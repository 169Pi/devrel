import { Octokit } from '@octokit/rest';
import { TEMPLATE_DIR, isTemplateFile, parseTemplates } from './templates.js';

export function createGitHub({ token, repo, ref, logger = console }) {
  const [owner, name] = repo.split('/');
  const octokit = new Octokit({
    auth: token,
    userAgent: 'alpieca-slack-bot',
    // 2022-11-28 (Octokit's default) now returns Deprecation headers.
    request: { headers: { 'X-GitHub-Api-Version': '2026-03-10' } },
  });

  return {
    /** Reads the templates from the repo itself, so Slack always matches GitHub. */
    async loadTemplates() {
      const { data: listing } = await octokit.repos.getContent({ owner, repo: name, path: TEMPLATE_DIR, ref });
      const files = (Array.isArray(listing) ? listing : []).filter(
        (f) => f.type === 'file' && isTemplateFile(f.name),
      );
      const entries = await Promise.all(
        files.map(async (f) => {
          const { data } = await octokit.repos.getContent({
            owner,
            repo: name,
            path: f.path,
            ref,
            mediaType: { format: 'raw' },
          });
          return [f.name, String(data)];
        }),
      );
      return parseTemplates(entries, logger);
    },

    async isPublic() {
      const { data } = await octokit.repos.get({ owner, repo: name });
      return !data.private;
    },

    async userExists(login) {
      try {
        await octokit.users.getByUsername({ username: login });
        return true;
      } catch (err) {
        if (err.status === 404) return false;
        throw err;
      }
    },

    async getIssue(number) {
      return (await octokit.issues.get({ owner, repo: name, issue_number: number })).data;
    },

    async listLabels() {
      return octokit.paginate(octokit.issues.listLabelsForRepo, { owner, repo: name, per_page: 100 });
    },

    async setLabels(number, labels) {
      await octokit.issues.setLabels({ owner, repo: name, issue_number: number, labels });
    },

    /** Returns true if GitHub actually assigned them (it silently ignores non-assignable users). */
    async assign(number, login) {
      const { data } = await octokit.issues.addAssignees({ owner, repo: name, issue_number: number, assignees: [login] });
      return data.assignees.some((a) => a.login.toLowerCase() === login.toLowerCase());
    },

    async comment(number, body) {
      return (await octokit.issues.createComment({ owner, repo: name, issue_number: number, body })).data;
    },

    async setState(number, state) {
      await octokit.issues.update({
        owner,
        repo: name,
        issue_number: number,
        state,
        ...(state === 'closed' ? { state_reason: 'completed' } : {}),
      });
    },

    async createIssue({ title, body, labels, assignees }) {
      let data;
      try {
        ({ data } = await octokit.issues.create({ owner, repo: name, title, body, labels, assignees }));
      } catch (err) {
        if (err.status === 403 || err.status === 404) {
          // Fine-grained tokens can still read a public repo while lacking write access, so
          // templates load fine and only creation fails. Say what to fix instead of a bare 403.
          throw new Error(
            `the bot's GitHub token can't create issues in ${repo}. It needs "Issues: Read and write" on ${repo}, ` +
              `and if it's a fine-grained token owned by ${owner}, an org owner must approve it`,
            { cause: err },
          );
        }
        throw err;
      }
      const applied = new Set(data.labels.map((l) => (typeof l === 'string' ? l : l.name)));
      return {
        number: data.number,
        url: data.html_url,
        // GitHub silently drops labels the token can't apply; surface that instead of hiding it.
        missingLabels: labels.filter((l) => !applied.has(l)),
        issue: data,
      };
    },
  };
}
