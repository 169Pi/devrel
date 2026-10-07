import { Octokit } from '@octokit/rest';
import { TEMPLATE_DIR, isTemplateFile, parseTemplates } from './templates.js';

export function createGitHub({ token, repo, ref, logger = console }) {
  const [owner, name] = repo.split('/');
  const octokit = new Octokit({ auth: token, userAgent: 'alpieca-slack-bot' });

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

    async createIssue({ title, body, labels, assignees }) {
      const { data } = await octokit.issues.create({ owner, repo: name, title, body, labels, assignees });
      const applied = new Set(data.labels.map((l) => (typeof l === 'string' ? l : l.name)));
      return {
        number: data.number,
        url: data.html_url,
        // GitHub silently drops labels the token can't apply; surface that instead of hiding it.
        missingLabels: labels.filter((l) => !applied.has(l)),
      };
    },
  };
}
