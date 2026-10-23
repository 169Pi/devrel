// Alpieca's GitHub App. It gives the bot an identity of its own (issues show "alpieca[bot]", not
// whoever owns a personal token) and lets people sign in, so the issues they file are opened by
// them, marked "with Alpieca" by GitHub. Uses only Node built-ins: no @octokit/auth-app needed.
import { createPrivateKey, createSign } from 'node:crypto';

const API = 'https://api.github.com';
const WEB = 'https://github.com';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const b64url = (value) => Buffer.from(value).toString('base64url');

/**
 * The App's private key, as a PEM, a PEM with literal "\n"s (.env files), or the PEM base64-encoded on one
 * line, which is what deploy/alpieca-start can load from Parameter Store.
 */
export function normalizePem(pem) {
  const value = String(pem ?? '').trim();
  return value.includes('-----BEGIN') ? value.replace(/\\n/g, '\n') : Buffer.from(value, 'base64').toString('utf8');
}

/** The short-lived JWT a GitHub App signs to ask for installation tokens. */
export function appJwt({ appId, privateKey, now = Date.now() }) {
  const iat = Math.floor(now / 1000) - 60; // GitHub allows for clock drift backwards, not forwards
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: String(appId) }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(createPrivateKey(normalizePem(privateKey)));
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

/** Turns GitHub's OAuth token response into what Alpieca stores. Expiry fields are absent when the App doesn't expire tokens. */
function userTokens(data, now) {
  return {
    accessToken: data.access_token,
    expiresAt: data.expires_in ? now + data.expires_in * 1000 : null,
    refreshToken: data.refresh_token ?? null,
    refreshExpiresAt: data.refresh_token_expires_in ? now + data.refresh_token_expires_in * 1000 : null,
  };
}

export class SignInError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * @param appId, privateKey     for installation tokens (the bot's own identity). Optional.
 * @param clientId, clientSecret for people signing in with the device flow. The secret is only needed
 *                              to refresh tokens, which expire after 8 hours unless the App turns that off.
 */
export function createGitHubApp({ appId, privateKey, clientId, clientSecret, fetch = globalThis.fetch, now = () => Date.now(), sleep } = {}) {
  sleep ??= (ms, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true });
    });

  async function api(method, route, { bearer, body } = {}) {
    const res = await fetch(`${API}${route}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${bearer ?? appJwt({ appId, privateKey, now: now() })}`,
        'user-agent': 'alpieca-slack-bot',
        'x-github-api-version': '2026-03-10',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || `GitHub answered ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /** POSTs to github.com's OAuth endpoints, which answer errors with 200 and an `error` field. */
  async function oauth(path, params) {
    const res = await fetch(`${WEB}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'alpieca-slack-bot' },
      body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !data.error) throw new SignInError('http', `GitHub answered ${res.status}`);
    return data;
  }

  return {
    canAct: Boolean(appId && privateKey),
    canSignIn: Boolean(clientId),

    /** The App's slug, e.g. "alpieca": its issues show as "alpieca[bot]". */
    async slug() {
      return (await api('GET', '/app')).slug;
    },

    /**
     * A function that returns a valid installation token for one repo, cached until 5 minutes before it
     * expires (they last an hour). Each repo's token is scoped to that repo, and `permissions` can narrow
     * it further, e.g. Issues only for a repo whose code the bot has no business reading.
     */
    installationToken({ repo, permissions }) {
      const [owner, name] = repo.split('/');
      let cached = null;
      let inflight = null;
      return async function token() {
        if (cached && cached.expiresAt - now() > 5 * 60_000) return cached.token;
        inflight ??= (async () => {
          let installation;
          try {
            installation = await api('GET', `/repos/${owner}/${name}/installation`);
          } catch (err) {
            if (err.status === 404) throw Object.assign(new Error(`the GitHub App isn't installed on ${repo}`), { status: 404 });
            throw err;
          }
          const data = await api('POST', `/app/installations/${installation.id}/access_tokens`, {
            body: { repositories: [name], ...(permissions ? { permissions } : {}) },
          });
          cached = { token: data.token, expiresAt: Date.parse(data.expires_at) };
          return cached.token;
        })().finally(() => {
          inflight = null;
        });
        return inflight;
      };
    },

    /** Starts a device-flow sign-in: the person enters `userCode` at `verificationUri`. */
    async startSignIn() {
      const data = await oauth('/login/device/code', { client_id: clientId });
      if (data.error) throw new SignInError(data.error, data.error_description || data.error);
      return {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        expiresAt: now() + data.expires_in * 1000,
        interval: data.interval || 5,
      };
    },

    /** Waits until the person approves (tokens), declines or lets the code expire (SignInError). */
    async finishSignIn({ deviceCode, expiresAt, interval }, { signal } = {}) {
      let wait = interval;
      while (now() < expiresAt) {
        await sleep(wait * 1000, signal);
        const data = await oauth('/login/oauth/access_token', { client_id: clientId, device_code: deviceCode, grant_type: DEVICE_GRANT });
        if (data.access_token) return userTokens(data, now());
        if (data.error === 'authorization_pending') continue;
        if (data.error === 'slow_down') {
          wait = data.interval || wait + 5;
          continue;
        }
        if (data.error === 'expired_token') break;
        throw new SignInError(data.error, data.error_description || data.error);
      }
      throw new SignInError('expired_token', 'The sign-in code expired.');
    },

    /** New tokens from a refresh token, or null if it's expired or revoked (they need to sign in again). */
    async refresh(refreshToken) {
      if (!clientSecret || !refreshToken) return null;
      const data = await oauth('/login/oauth/access_token', {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      return data.access_token ? userTokens(data, now()) : null;
    },

    /** The GitHub login a user token belongs to. */
    async whoAmI(accessToken) {
      return (await api('GET', '/user', { bearer: accessToken })).login;
    },
  };
}
