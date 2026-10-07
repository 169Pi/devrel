import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// GitHub usernames: 1-39 chars, alphanumeric or single hyphens, not starting/ending with one.
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function normalizeLogin(value) {
  return String(value ?? '').trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//i, '').replace(/\/$/, '');
}

/**
 * Remembers which GitHub account belongs to which Slack user, so reporters are
 * asked once and triagers can "Assign to me". Stored as a small JSON file.
 */
export async function createPeopleStore(file) {
  let data = { slackToGithub: {} };
  try {
    data = { slackToGithub: {}, ...JSON.parse(await readFile(file, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Couldn't read ${file}: ${err.message}`);
  }

  let writing = Promise.resolve();
  function save() {
    // Serialise writes and swap the file in atomically so a crash never leaves half a JSON file.
    writing = writing.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
      await rename(tmp, file);
    });
    return writing;
  }

  return {
    githubFor: (slackId) => data.slackToGithub[slackId] ?? null,
    slackFor: (login) =>
      Object.entries(data.slackToGithub).find(([, l]) => l.toLowerCase() === String(login).toLowerCase())?.[0] ?? null,
    async link(slackId, login) {
      if (data.slackToGithub[slackId] === login) return;
      data.slackToGithub[slackId] = login;
      await save();
    },
  };
}
