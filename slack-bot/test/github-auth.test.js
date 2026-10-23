import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { fileIssue } from '../src/filing.js';
import { createGitHub } from '../src/github.js';
import { appJwt, createGitHubApp, SignInError } from '../src/github-app.js';
import { formView } from '../src/modal.js';
import { createUserTokenStore } from '../src/user-tokens.js';

const silent = { warn() {}, error() {} };
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });
const SLACK = { SLACK_BOT_TOKEN: 'x', SLACK_APP_TOKEN: 'x' };
const KEY = 'k'.repeat(32);

/** A fake fetch that answers each "METHOD url" from `routes` (a value, or a function of the request body), in order. */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, { method = 'GET', headers, body } = {}) => {
    const key = `${method} ${url}`;
    const parsed = body ? JSON.parse(body) : undefined;
    calls.push({ key, headers, body: parsed });
    const queue = routes[key];
    if (!queue) throw new Error(`unexpected ${key}`);
    let answer = Array.isArray(queue) ? queue.shift() : queue;
    if (typeof answer === 'function') answer = answer(parsed);
    const { status = 200, ...json } = answer;
    return { ok: status < 400, status, json: async () => json };
  };
  return { fetch, calls };
}

test('the App signs a JWT GitHub can verify, issued a minute early for clock drift', () => {
  const jwt = appJwt({ appId: 123, privateKey: PEM.replace(/\n/g, '\\n'), now: 1_000_000_000_000 });
  const [header, payload, signature] = jwt.split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, 'base64url')));
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iat: 999_999_940, exp: 1_000_000_480, iss: '123' });
});

test('the private key may be a PEM, a PEM with \\n escapes, or base64 on one line', () => {
  for (const key of [PEM, PEM.replace(/\n/g, '\\n'), Buffer.from(PEM).toString('base64')]) {
    const [header, payload, signature] = appJwt({ appId: 1, privateKey: key }).split('.');
    assert.ok(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, 'base64url')));
  }
});

test('installation tokens are scoped to one repo, narrowed if asked, and cached until near expiry', async () => {
  let now = Date.parse('2026-10-23T10:00:00Z');
  const { fetch, calls } = fakeFetch({
    'GET https://api.github.com/repos/169Pi/app-alpie/installation': { id: 42 },
    'POST https://api.github.com/app/installations/42/access_tokens': [
      { token: 'ghs_one', expires_at: '2026-10-23T11:00:00Z' },
      { token: 'ghs_two', expires_at: '2026-10-23T12:00:00Z' },
    ],
  });
  const app = createGitHubApp({ appId: 1, privateKey: PEM, fetch, now: () => now });
  const token = app.installationToken({ repo: '169Pi/app-alpie', permissions: { issues: 'write', metadata: 'read' } });
  assert.equal(await token(), 'ghs_one');
  assert.match(calls[0].headers.authorization, /^Bearer ey/);
  assert.deepEqual(calls[1].body, { repositories: ['app-alpie'], permissions: { issues: 'write', metadata: 'read' } });
  now += 50 * 60_000;
  assert.equal(await token(), 'ghs_one', 'still 10 minutes left');
  now += 6 * 60_000;
  assert.equal(await token(), 'ghs_two', 'renewed 5 minutes before expiry');
});

test('the GitHub client asks for a fresh installation token on every request', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, { headers }) => {
    seen.push(new Headers(headers).get('authorization'));
    return new Response(url.endsWith('/repos/o/r') ? '{"private":true}' : '{"message":"Not Found"}', {
      status: url.endsWith('/repos/o/r') ? 200 : 404,
      headers: { 'content-type': 'application/json' },
    });
  });
  let n = 0;
  const github = createGitHub({ token: async () => `ghs_${++n}`, repo: 'o/r', logger: silent });
  assert.equal(await github.canRead(), true);
  assert.equal(await github.isPublic(), false);
  assert.deepEqual(seen, ['token ghs_1', 'token ghs_2']);
  assert.equal(await createGitHub({ token: 't', repo: 'o/missing', logger: silent }).canRead(), false);
});

test("a repo the App isn't installed on says so", async () => {
  const { fetch } = fakeFetch({ 'GET https://api.github.com/repos/o/r/installation': { status: 404, message: 'Not Found' } });
  const token = createGitHubApp({ appId: 1, privateKey: PEM, fetch }).installationToken({ repo: 'o/r' });
  await assert.rejects(token(), /isn't installed on o\/r/);
});

test('device-flow sign-in waits for approval, slowing down when GitHub asks', async () => {
  let now = 0;
  const waits = [];
  const { fetch, calls } = fakeFetch({
    'POST https://github.com/login/device/code': { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 },
    'POST https://github.com/login/oauth/access_token': [
      { error: 'authorization_pending' },
      { error: 'slow_down', interval: 10 },
      { access_token: 'ghu_x', expires_in: 28800, refresh_token: 'ghr_x', refresh_token_expires_in: 15897600 },
    ],
  });
  const app = createGitHubApp({ clientId: 'Iv1.abc', fetch, now: () => now, sleep: async (ms) => (waits.push(ms), (now += ms)) });
  const flow = await app.startSignIn();
  assert.equal(flow.userCode, 'ABCD-1234');
  const tokens = await app.finishSignIn(flow);
  assert.deepEqual(waits, [5000, 5000, 10000]);
  assert.equal(calls[1].body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  assert.deepEqual(tokens, { accessToken: 'ghu_x', expiresAt: 20000 + 28800_000, refreshToken: 'ghr_x', refreshExpiresAt: 20000 + 15897600_000 });
});

test('device-flow sign-in reports a cancel or an expired code', async () => {
  const flow = { deviceCode: 'dc', expiresAt: 10_000, interval: 5 };
  let now = 0;
  const sleep = async (ms) => (now += ms);
  const denied = fakeFetch({ 'POST https://github.com/login/oauth/access_token': { error: 'access_denied' } });
  await assert.rejects(createGitHubApp({ clientId: 'c', fetch: denied.fetch, now: () => now, sleep }).finishSignIn(flow), (err) => err instanceof SignInError && err.code === 'access_denied');
  now = 0;
  const pending = fakeFetch({ 'POST https://github.com/login/oauth/access_token': () => ({ error: 'authorization_pending' }) });
  await assert.rejects(createGitHubApp({ clientId: 'c', fetch: pending.fetch, now: () => now, sleep }).finishSignIn(flow), (err) => err.code === 'expired_token');
});

test('refreshing needs the client secret; a rejected refresh token means signing in again', async () => {
  const { fetch, calls } = fakeFetch({
    'POST https://github.com/login/oauth/access_token': [{ access_token: 'ghu_new', expires_in: 60 }, { error: 'bad_refresh_token' }],
  });
  assert.equal(await createGitHubApp({ clientId: 'c', fetch }).refresh('ghr'), null, 'no secret, no refresh');
  const app = createGitHubApp({ clientId: 'c', clientSecret: 's', fetch, now: () => 0 });
  assert.equal((await app.refresh('ghr')).accessToken, 'ghu_new');
  assert.equal(calls[0].body.client_secret, 's');
  assert.equal(await app.refresh('ghr'), null);
});

test('sign-in tokens are stored encrypted, owner-only, and refreshed when they expire', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'alpieca-'));
  const file = path.join(dir, 'github-sign-ins.json');
  let now = 0;
  const refreshed = [];
  const refresh = async (t) => (refreshed.push(t), { accessToken: 'ghu_2', expiresAt: now + 3_600_000, refreshToken: 'ghr_2', refreshExpiresAt: null });
  const store = await createUserTokenStore(file, { secret: KEY, refresh, now: () => now, logger: silent });
  await store.save('U1', 'vishal', { accessToken: 'ghu_1', expiresAt: 3_600_000, refreshToken: 'ghr_1', refreshExpiresAt: null });

  const raw = await readFile(file, 'utf8');
  assert.doesNotMatch(raw, /ghu_1|ghr_1/);
  assert.match(raw, /"login": "vishal"/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  assert.equal(await store.accessToken('U1'), 'ghu_1');
  now = 3_590_000; // within a minute of expiry
  const [a, b] = await Promise.all([store.accessToken('U1'), store.accessToken('U1')]);
  assert.deepEqual([a, b, refreshed], ['ghu_2', 'ghu_2', ['ghr_1']], 'one refresh, shared');

  const reloaded = await createUserTokenStore(file, { secret: KEY, now: () => now, logger: silent });
  assert.equal(await reloaded.accessToken('U1'), 'ghu_2');
  const wrongKey = await createUserTokenStore(file, { secret: 'x'.repeat(32), now: () => now, logger: silent });
  assert.equal(await wrongKey.accessToken('U1'), null);
});

test("a sign-in that can't be refreshed is forgotten", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'alpieca-'));
  const store = await createUserTokenStore(path.join(dir, 't.json'), { secret: KEY, now: () => 10_000_000, logger: silent });
  await store.save('U1', 'vishal', { accessToken: 'ghu_1', expiresAt: 1, refreshToken: null, refreshExpiresAt: null });
  assert.equal(await store.accessToken('U1'), null);
  assert.equal(store.loginFor('U1'), null);
});

/** A repo with a fake bot client, plus a fake "as the user" client, recording who did what. */
function setup({ public: isPublic = true, canRead = true, userCreate } = {}) {
  const log = [];
  const created = (by, labels = ['bug']) => ({ number: 7, url: 'u', missingLabels: by === 'user' ? labels : [], issue: { labels: [], assignees: [] } });
  const dest = {
    repo: '169Pi/app-alpie',
    public: isPublic,
    github: {
      createIssue: async () => (log.push('bot:create'), created('bot')),
      setLabels: async (n, labels) => log.push(`bot:label ${labels}`),
      assign: async (n, login) => log.push(`bot:assign ${login}`),
    },
  };
  const asUser = (token) => ({
    canRead: async () => (log.push(`user:read ${token}`), canRead),
    createIssue: userCreate ?? (async () => (log.push('user:create'), created('user'))),
  });
  return { dest, asUser, log };
}
const issue = { title: 't', body: 'b', labels: ['bug'], assignees: ['triager'] };
const user = { login: 'vishal', token: 'ghu' };

test('signed in, the issue is opened as them and the bot adds the labels GitHub dropped', async () => {
  const { dest, asUser, log } = setup();
  const filed = await fileIssue({ dest, issue, user, signIn: true, asUser, logger: silent });
  assert.equal(filed.as, 'user');
  assert.deepEqual(filed.created.missingLabels, []);
  assert.deepEqual(filed.created.issue.labels, [{ name: 'bug' }]);
  assert.deepEqual(log, ['user:create', 'bot:label bug', 'bot:assign triager'], 'public repos need no access check');
});

test('signed in to a private repo they can see, it is opened as them', async () => {
  const { dest, asUser, log } = setup({ public: false });
  assert.equal((await fileIssue({ dest, issue, user, signIn: true, asUser, logger: silent })).as, 'user');
  assert.deepEqual(log.slice(0, 2), ['user:read ghu', 'user:create']);
});

test("signed in without access to a private repo, nothing is filed, not even as the bot", async () => {
  const { dest, asUser, log } = setup({ public: false, canRead: false });
  assert.deepEqual(await fileIssue({ dest, issue, user, signIn: true, asUser, logger: silent }), { refused: 'no-access', login: 'vishal' });
  assert.deepEqual(log, ['user:read ghu']);
});

test('not signed in, a public repo gets the issue from the bot and a private one asks them to sign in', async () => {
  const pub = setup();
  assert.equal((await fileIssue({ ...pub, issue, user: null, signIn: true, logger: silent })).as, 'bot');
  const priv = setup({ public: false });
  assert.deepEqual(await fileIssue({ ...priv, issue, user: null, signIn: true, logger: silent }), { refused: 'sign-in' });
  assert.deepEqual(priv.log, []);
  // Without sign-in set up there's nothing to check against, so the bot files as it always has.
  assert.equal((await fileIssue({ ...priv, issue, user: null, signIn: false, logger: silent })).as, 'bot');
});

test('a revoked sign-in is dropped and the issue filed as if they had never signed in', async () => {
  const revoked = async () => {
    throw Object.assign(new Error('Bad credentials'), { status: 401 });
  };
  const pub = setup({ userCreate: revoked });
  assert.deepEqual(
    { ...(await fileIssue({ ...pub, issue, user, signIn: true, logger: silent })), created: undefined },
    { as: 'bot', signedOut: true, created: undefined },
  );
  const priv = setup({ public: false, userCreate: revoked });
  assert.deepEqual(await fileIssue({ ...priv, issue, user, signIn: true, logger: silent }), { refused: 'sign-in', signedOut: true });
});

test("when GitHub won't let the App open issues as them, the bot opens it", async () => {
  const { dest, asUser, log } = setup({
    userCreate: async () => {
      throw new Error("can't create issues", { cause: { status: 403 } });
    },
  });
  assert.equal((await fileIssue({ dest, issue, user, signIn: true, asUser, logger: silent })).as, 'bot');
  assert.deepEqual(log, ['bot:create']);
});

test('config: a GitHub App replaces GITHUB_TOKEN, and sign-ins need an encryption key', () => {
  assert.throws(() => loadConfig(SLACK), /GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY \(or GITHUB_TOKEN\)/);
  assert.throws(() => loadConfig({ ...SLACK, GITHUB_APP_ID: '1' }), /GITHUB_APP_PRIVATE_KEY/);
  const app = loadConfig({ ...SLACK, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'pem' });
  assert.equal(app.github.token, null);
  assert.deepEqual(app.github.app, { appId: '1', privateKey: 'pem', clientId: null, clientSecret: null });
  assert.equal(loadConfig({ ...SLACK, GITHUB_TOKEN: 't' }).github.app, null);
  assert.throws(() => loadConfig({ ...SLACK, GITHUB_TOKEN: 't', GITHUB_APP_CLIENT_ID: 'c' }), /TOKEN_ENCRYPTION_KEY/);
  assert.throws(() => loadConfig({ ...SLACK, GITHUB_TOKEN: 't', GITHUB_APP_CLIENT_ID: 'c', TOKEN_ENCRYPTION_KEY: 'short' }), /at least 32/);
  const signIn = loadConfig({ ...SLACK, GITHUB_TOKEN: 't', GITHUB_APP_CLIENT_ID: 'c', TOKEN_ENCRYPTION_KEY: KEY });
  assert.equal(signIn.github.app.clientId, 'c');
});

test('the form shows who a signed-in person files as, and asks others to sign in for a private repo', () => {
  const template = { id: 'o/r:bug.md', repo: 'o/r', name: 'Bug', titlePrefix: '', sections: [], labels: [], version: 'v' };
  const texts = (view) => JSON.stringify(view.blocks);
  const signedIn = formView(template, { signedInAs: 'vishal', publicRepo: false, signInCommand: '/alpieca github login' });
  assert.match(texts(signedIn), /Signed in to GitHub as \*@vishal\*/);
  assert.doesNotMatch(texts(signedIn), /github_login/);
  const out = formView(template, { publicRepo: false, signInCommand: '/alpieca github login' });
  assert.match(texts(out), /is private\. Sign in with `\/alpieca github login`/);
  assert.match(texts(out), /github_login/);
  assert.doesNotMatch(texts(formView(template, { publicRepo: true, signInCommand: '/alpieca github login' })), /is private/);
});
