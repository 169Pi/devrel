import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ACTION, escapeSlack, isFromSlack, issueCard, previewBody, reporterFromBody, slackMarker } from '../src/issue-card.js';
import { commentView, formView, githubLoginView, labelView, readAnswers } from '../src/modal.js';
import { createPeopleStore, GITHUB_LOGIN, normalizeLogin } from '../src/people.js';
import { loadLocalTemplates, renderIssue } from '../src/templates.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const templates = await loadLocalTemplates(path.resolve(HERE, '../../.github/ISSUE_TEMPLATE'), { warn() {} });
const merch = templates.find((t) => t.name.includes('Merch'));

const ANSWERS = { title: 'Neon hoodie', s0: 'Hoodie', s1: 'Black with a **tiny** neon logo', s2: 'Offsite <!channel> vibes' };

function ghIssue(overrides = {}) {
  const rendered = renderIssue(merch, ANSWERS, { reporter: 'Priya', githubLogin: 'priya-dev' });
  return {
    number: 42,
    title: rendered.title,
    html_url: 'https://github.com/169Pi/devrel/issues/42',
    body: rendered.body,
    state: 'open',
    labels: [{ name: 'merch' }],
    assignees: [],
    user: { login: 'token-owner' },
    ...overrides,
  };
}

test('issues filed from Slack @mention the reporter and carry a hidden marker', () => {
  const { body } = renderIssue(merch, ANSWERS, { reporter: 'Priya', githubLogin: 'priya-dev', drafted: true });
  assert.match(body, /<sub>Raised from Slack by Priya \(@priya-dev\) · drafted with Alpie<\/sub>/);
  assert.ok(body.trimEnd().endsWith(slackMarker('priya-dev')));
  assert.ok(isFromSlack(body));
  assert.equal(reporterFromBody(body), 'priya-dev');
  assert.equal(isFromSlack('### Opened on GitHub\nhi'), false);
});

test('card credits the real reporter, not the token owner, and escapes issue content', () => {
  const card = issueCard(ghIssue(), { repo: '169Pi/devrel', headline: ':memo: <@U1> raised an issue' });
  const json = JSON.stringify(card.blocks);
  assert.equal(card.blocks[0].elements[0].text, ':memo: <@U1> raised an issue');
  assert.match(card.blocks[1].text.text, /^\*<https:\/\/github\.com\/169Pi\/devrel\/issues\/42\|#42 \[MERCH IDEA\]: Neon hoodie>\*$/);
  assert.match(json, /@priya-dev/);
  assert.doesNotMatch(json, /token-owner/);
  assert.match(json, /`merch`/);
  // Content from GitHub can't ping the channel.
  assert.match(json, /&lt;!channel&gt;/);
  assert.doesNotMatch(json, /<!channel>/);
  assert.equal(card.unfurl_links, false);
});

test('open cards offer triage; closed cards offer reopen', () => {
  const ids = (issue) => issueCard(issue, { repo: 'r' }).blocks.find((b) => b.type === 'actions').elements.map((e) => e.action_id);
  assert.deepEqual(ids(ghIssue()), ['issue_view', ACTION.assign, ACTION.label, ACTION.comment, ACTION.close]);
  assert.deepEqual(ids(ghIssue({ state: 'closed', state_reason: 'completed' })), ['issue_view', ACTION.comment, ACTION.reopen]);
  const open = issueCard(ghIssue(), { repo: 'r', note: 'Closed by <@U2>' });
  assert.equal(open.blocks.find((b) => b.type === 'actions').elements.find((e) => e.action_id === ACTION.close).confirm.title.text, 'Close #42?');
  assert.equal(open.blocks.at(-1).elements[0].text, 'Closed by <@U2>');
  assert.match(JSON.stringify(issueCard(ghIssue({ state: 'closed', state_reason: 'not_planned' }), { repo: 'r' })), /not planned/);
});

test('preview turns template markdown into a short Slack summary', () => {
  const preview = previewBody(ghIssue().body);
  assert.match(preview, /^\*👕 What's the Merch\?\*\nHoodie/);
  assert.match(preview, /Black with a \*tiny\* neon logo/);
  assert.doesNotMatch(preview, /Inspiration|No response|Raised from Slack|alpieca/);
  const long = previewBody(`## Big\n${'word '.repeat(400)}\n![shot](https://x/y.png)\n[docs](https://docs.169pi.ai)`);
  assert.ok(long.length <= 760);
  assert.ok(long.endsWith('…'));
  assert.match(previewBody('see [docs](https://docs.169pi.ai) & more'), /<https:\/\/docs\.169pi\.ai\|docs> &amp; more/);
  assert.equal(escapeSlack('<@U1> & <!here>'), '&lt;@U1&gt; &amp; &lt;!here&gt;');
});

test('GitHub usernames are normalised and validated', () => {
  assert.equal(normalizeLogin(' @Priya-Dev '), 'Priya-Dev');
  assert.equal(normalizeLogin('https://github.com/octocat/'), 'octocat');
  for (const ok of ['octocat', 'a', 'priya-dev', 'x'.repeat(39)]) assert.ok(GITHUB_LOGIN.test(ok), ok);
  for (const bad of ['', '-lead', 'trail-', 'dou--ble', 'has space', 'x'.repeat(40), 'emoji🦙']) assert.ok(!GITHUB_LOGIN.test(bad), bad);
});

test('people store remembers Slack -> GitHub links across restarts', async () => {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'alpieca-')), 'nested', 'people.json');
  const store = await createPeopleStore(file);
  assert.equal(store.githubFor('U1'), null);
  await store.link('U1', 'priya-dev');
  await store.link('U2', 'rahul');
  const reloaded = await createPeopleStore(file);
  assert.equal(reloaded.githubFor('U1'), 'priya-dev');
  assert.equal(reloaded.slackFor('RAHUL'), 'U2');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).slackToGithub, { U1: 'priya-dev', U2: 'rahul' });
});

test('form asks for the GitHub username and carries the post-back origin', () => {
  const origin = { channel: 'C1', thread: '171.1' };
  const view = formView(merch, { githubLogin: 'priya-dev', origin });
  const login = view.blocks.find((b) => b.block_id === 'github_login');
  assert.equal(login.optional, false);
  assert.equal(login.element.initial_value, 'priya-dev');
  assert.deepEqual(JSON.parse(view.private_metadata).origin, origin);
  assert.equal(formView(merch).blocks.find((b) => b.block_id === 'github_login').element.initial_value, undefined);
});

test('triage modals respect Slack limits and read back cleanly', () => {
  const issue = ghIssue();
  const meta = { number: 42, channel: 'C1', ts: '1.2', headline: 'h' };
  const labels = Array.from({ length: 120 }, (_, i) => ({ name: i === 3 ? 'merch' : `label-${i}` }));
  const lv = labelView(issue, labels, meta);
  const select = lv.blocks.find((b) => b.block_id === 'labels').element;
  assert.equal(select.options.length, 100);
  assert.deepEqual(select.initial_options.map((o) => o.value), ['merch']);
  assert.ok(lv.title.text.length <= 24);
  assert.deepEqual(JSON.parse(lv.private_metadata), meta);
  assert.ok(commentView(issue, meta).title.text.length <= 24);
  assert.equal(githubLoginView(meta, { reason: 'why' }).blocks[1].block_id, 'github_login');
  const state = { values: { labels: { value: { type: 'multi_static_select', selected_options: [{ value: 'a' }, { value: 'b' }] } } } };
  assert.deepEqual(readAnswers({ state }), { labels: ['a', 'b'] });
});

test('GitHub Action script posts new GitHub issues and skips ones filed from Slack', async () => {
  const run = promisify(execFile);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'alpieca-event-'));
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const script = path.resolve(HERE, '../scripts/post-github-issue.js');
  const env = (event) => ({
    ...process.env,
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_ISSUES_CHANNEL: 'C-ISSUES',
    SLACK_API_URL: `http://127.0.0.1:${server.address().port}`,
    GITHUB_REPOSITORY: '169Pi/devrel',
    GITHUB_EVENT_PATH: event,
  });
  try {
    const direct = path.join(dir, 'direct.json');
    await writeFile(direct, JSON.stringify({ issue: ghIssue({ body: '### Bug\nIt broke', user: { login: 'outsider' } }) }));
    await run('node', [script], { env: env(direct) });
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/chat.postMessage');
    assert.equal(received[0].auth, 'Bearer xoxb-test');
    assert.equal(received[0].body.channel, 'C-ISSUES');
    assert.match(received[0].body.blocks[0].elements[0].text, /New issue opened on GitHub by .*@outsider/);

    const fromSlack = path.join(dir, 'slack.json');
    await writeFile(fromSlack, JSON.stringify({ issue: ghIssue() }));
    const { stdout } = await run('node', [script], { env: env(fromSlack) });
    assert.match(stdout, /filed from Slack/);
    assert.equal(received.length, 1, 'no duplicate post for Slack-filed issues');
  } finally {
    server.close();
  }
});
