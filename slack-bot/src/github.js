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
    repo,

    /** Reads the templates from the repo itself, so Slack always matches GitHub. */
    async loadTemplates(dir = TEMPLATE_DIR) {
      const { data: listing } = await octokit.repos.getContent({ owner, repo: name, path: dir, ref });
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

    /** The account issues are opened as: the token's owner. Null for tokens that can't say (GitHub App tokens). */
    async tokenOwner() {
      try {
        return (await octokit.users.getAuthenticated()).data.login;
      } catch {
        return null;
      }
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

    /** Open issues (not PRs), most recently updated first, then the most recently closed: context for answers. */
    async recentIssues(limit = 30, closedLimit = 10) {
      const list = (state, n) =>
        octokit.issues
          .listForRepo({ owner, repo: name, state, sort: 'updated', per_page: 50 })
          .then(({ data }) => data.filter((i) => !i.pull_request).slice(0, n));
      const [open, closed] = await Promise.all([list('open', limit), list('closed', closedLimit)]);
      return [...open, ...closed].map((i) => ({
        repo,
        number: i.number,
        title: i.title,
        state: i.state,
        url: i.html_url,
        labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
      }));
    },

    /** Open pull requests, most recently updated first, as context for answers. */
    async recentPullRequests(limit = 30) {
      const { data } = await octokit.pulls.list({ owner, repo: name, state: 'open', sort: 'updated', direction: 'desc', per_page: limit });
      return data.map((p) => ({
        repo,
        number: p.number,
        title: p.title,
        url: p.html_url,
        author: p.user?.login ?? null,
        draft: Boolean(p.draft),
        labels: p.labels.map((l) => (typeof l === 'string' ? l : l.name)),
      }));
    },

    /**
     * One person's issues, for "how many open issues by @vishal?". Issues raised from Slack are opened by
     * the bot's account and @mention their reporter, so "mentioned" is how those are counted.
     * Null if GitHub has no such user.
     */
    async personStats(login) {
      const q = (rest) => `repo:${repo} is:issue ${rest}`;
      const query = `query($opened: String!, $openedAll: String!, $assigned: String!, $mentioned: String!, $involved: String!) {
        opened: search(type: ISSUE, query: $opened, first: 1) { issueCount }
        openedAll: search(type: ISSUE, query: $openedAll, first: 1) { issueCount }
        assigned: search(type: ISSUE, query: $assigned, first: 1) { issueCount }
        mentioned: search(type: ISSUE, query: $mentioned, first: 1) { issueCount }
        involved: search(type: ISSUE, query: $involved, first: 10) {
          issueCount
          nodes { ... on Issue { number title url state } }
        }
      }`;
      let data;
      try {
        data = await octokit.graphql(query, {
          opened: q(`is:open author:${login}`),
          openedAll: q(`author:${login}`),
          assigned: q(`is:open assignee:${login}`),
          mentioned: q(`is:open mentions:${login}`),
          involved: q(`is:open involves:${login}`),
        });
      } catch (err) {
        // GitHub refuses to search for users who don't exist.
        if (/cannot be searched|do not exist/i.test(err.message)) return null;
        throw err;
      }
      return {
        repo,
        login,
        openOpened: data.opened.issueCount,
        allOpened: data.openedAll.issueCount,
        openAssigned: data.assigned.issueCount,
        openMentioned: data.mentioned.issueCount,
        openInvolved: data.involved.issueCount,
        openIssues: data.involved.nodes.map((i) => ({ repo, number: i.number, title: i.title, state: i.state.toLowerCase(), url: i.url, labels: [] })),
      };
    },

    /**
     * Exact counts for analytical questions ("how many issues are open?"), in one GraphQL call.
     * Counts the token can't read (pull requests, with an Issues-only token) come back null.
     */
    async stats({ now = new Date() } = {}) {
      const week = new Date(now - 7 * 86_400_000).toISOString().slice(0, 10);
      const q = (rest) => `repo:${repo} is:issue ${rest}`;
      const query = `query($owner: String!, $name: String!, $unassigned: String!, $opened: String!, $closed: String!) {
        repository(owner: $owner, name: $name) {
          openIssues: issues(states: OPEN) { totalCount }
          closedIssues: issues(states: CLOSED) { totalCount }
          labels(first: 50) { nodes { name issues(states: OPEN) { totalCount } } }
        }
        prs: repository(owner: $owner, name: $name) {
          openPRs: pullRequests(states: OPEN) { totalCount }
          mergedPRs: pullRequests(states: MERGED) { totalCount }
          closedPRs: pullRequests(states: CLOSED) { totalCount }
          labels(first: 50) {
            nodes {
              name
              openPRs: pullRequests(states: OPEN) { totalCount }
              mergedPRs: pullRequests(states: MERGED) { totalCount }
            }
          }
        }
        unassigned: search(type: ISSUE, query: $unassigned, first: 1) { issueCount }
        opened: search(type: ISSUE, query: $opened, first: 1) { issueCount }
        closed: search(type: ISSUE, query: $closed, first: 1) { issueCount }
      }`;
      let data;
      try {
        data = await octokit.graphql(query, {
          owner,
          name,
          unassigned: q('is:open no:assignee'),
          opened: q(`created:>=${week}`),
          closed: q(`closed:>=${week}`),
        });
      } catch (err) {
        // Partial results: e.g. an Issues-only token can't see pull requests, but its issue counts are fine.
        if (!err.data?.repository) throw err;
        data = err.data;
      }
      const r = data.repository;
      const count = (c) => c?.totalCount ?? null;
      return {
        repo,
        openIssues: count(r.openIssues),
        closedIssues: count(r.closedIssues),
        openPRs: count(data.prs?.openPRs),
        mergedPRs: count(data.prs?.mergedPRs),
        closedPRs: count(data.prs?.closedPRs),
        unassignedOpenIssues: data.unassigned?.issueCount ?? null,
        openedLastWeek: data.opened?.issueCount ?? null,
        closedLastWeek: data.closed?.issueCount ?? null,
        openByLabel: (r.labels?.nodes ?? [])
          .map((l) => ({ name: l.name, open: l.issues.totalCount }))
          .filter((l) => l.open > 0)
          .sort((a, b) => b.open - a.open)
          .slice(0, 15),
        // Every label, even unused ones, so "how many PRs are ready for review?" can be answered with 0.
        // Pull requests are where labels like "ready-for-review" live.
        prsByLabel: data.prs?.labels
          ? data.prs.labels.nodes.map((l) => ({ name: l.name, open: l.openPRs.totalCount, merged: l.mergedPRs.totalCount }))
          : null,
      };
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
