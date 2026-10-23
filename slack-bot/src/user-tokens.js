import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// AES-256-GCM, keyed from TOKEN_ENCRYPTION_KEY. A copy of the file alone can't act as anyone.
const keyFrom = (secret) => createHash('sha256').update(String(secret)).digest();

function seal(key, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

function open(key, sealed) {
  const raw = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
}

/**
 * The GitHub sign-ins of people who ran `/alpieca github login`, by Slack user ID: their login in the
 * clear, their tokens encrypted. Expired access tokens are refreshed on use.
 *
 * @param refresh  (refreshToken) => new tokens, or null once the person has to sign in again
 */
export async function createUserTokenStore(file, { secret, refresh = async () => null, now = () => Date.now(), logger = console }) {
  const key = keyFrom(secret);
  let data = {};
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Couldn't read ${file}: ${err.message}`);
  }

  let writing = Promise.resolve();
  function save() {
    writing = writing.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, file);
    });
    return writing;
  }

  function tokensOf(slackId) {
    const entry = data[slackId];
    if (!entry) return null;
    try {
      return open(key, entry.sealed);
    } catch {
      // A changed TOKEN_ENCRYPTION_KEY: treat them as signed out rather than crash.
      logger.warn(`Couldn't decrypt the GitHub sign-in of ${slackId}; they need to sign in again`);
      return null;
    }
  }

  // One refresh per person at a time: refresh tokens are single-use.
  const refreshing = new Map();

  const store = {
    /** The GitHub login someone signed in as, or null. */
    loginFor: (slackId) => data[slackId]?.login ?? null,

    async save(slackId, login, tokens) {
      data[slackId] = { login, sealed: seal(key, tokens) };
      await save();
    },

    async remove(slackId) {
      if (!data[slackId]) return false;
      delete data[slackId];
      await save();
      return true;
    },

    /** A usable access token, refreshed if it has (nearly) expired. Null if they aren't, or are no longer, signed in. */
    async accessToken(slackId) {
      const tokens = tokensOf(slackId);
      if (!tokens) return null;
      if (!tokens.expiresAt || tokens.expiresAt - now() > 60_000) return tokens.accessToken;
      if (!refreshing.has(slackId)) {
        refreshing.set(
          slackId,
          (async () => {
            const fresh =
              tokens.refreshToken && (!tokens.refreshExpiresAt || tokens.refreshExpiresAt > now())
                ? await refresh(tokens.refreshToken).catch((err) => {
                    logger.warn(`Couldn't refresh the GitHub sign-in of ${slackId}: ${err.message}`);
                    return null;
                  })
                : null;
            if (!fresh) {
              await store.remove(slackId);
              return null;
            }
            await store.save(slackId, data[slackId]?.login, fresh);
            return fresh.accessToken;
          })().finally(() => refreshing.delete(slackId)),
        );
      }
      return refreshing.get(slackId);
    },
  };
  return store;
}
