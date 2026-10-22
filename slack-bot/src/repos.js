// The repos Alpieca files into: the main one (GITHUB_REPO) and, optionally, a product feedback
// repo (FEEDBACK_REPO). Each has its own GitHub client and templates. Templates from all repos
// are offered together, so picking a template also picks the repo.
import { createGitHub } from './github.js';
import { createTemplateStore, loadLocalTemplates } from './templates.js';

/** Template ids are "owner/repo:file.md" so two repos can both have e.g. bug.md. */
export function qualify(templates, repo) {
  return templates.map((t) => ({ ...t, id: `${repo}:${t.id}`, file: t.id, repo }));
}

/**
 * @param destinations [{ repo, token?, ref?, templateDir?, templatePath?, linkFiles?, mention?, slackMention? }],
 *                     main repo first. Templates come from `templateDir` on disk, else from `templatePath` in the
 *                     main repo (so a repo can take issues without holding any Alpieca files), else from the
 *                     repo's own .github/ISSUE_TEMPLATE.
 * @param makeGitHub   for tests; defaults to a real GitHub client
 */
export function createRepos(destinations, { token, ttlMs, logger = console, makeGitHub = createGitHub } = {}) {
  const clients = destinations.map((d) => makeGitHub({ token: d.token || token, repo: d.repo, ref: d.ref, logger }));
  const list = destinations.map((d, i) => {
    const github = clients[i];
    const load = d.templateDir
      ? () => loadLocalTemplates(d.templateDir, logger)
      : d.templatePath
        ? () => clients[0].loadTemplates(d.templatePath)
        : () => github.loadTemplates();
    return {
      ...d,
      main: i === 0,
      github,
      templates: createTemplateStore(async () => qualify(await load(), d.repo), { ttlMs, logger }),
      // Assume public until GitHub says otherwise, so reporters are warned when in doubt.
      public: true,
      // Why the token couldn't read the repo, if it couldn't. Guests are kept out of such repos.
      accessError: null,
      labels: { at: 0, list: [] },
    };
  });
  const byName = new Map(list.map((r) => [r.repo.toLowerCase(), r]));
  const main = list[0];

  return {
    list,
    main,

    /** The repo by owner/repo name, or the main repo for cards and modals made before there were several. */
    get(name) {
      return (name && byName.get(String(name).toLowerCase())) || main;
    },

    /** Templates from every repo the person may file into. A repo that fails to load is skipped. */
    async templates({ guest = false } = {}) {
      // Guests only get repos known to be public.
      const usable = list.filter((r) => !(guest && (!r.public || r.accessError)));
      const loaded = await Promise.all(
        usable.map((r) =>
          r.templates.all().catch((err) => {
            logger.warn(`Couldn't load templates from ${r.repo}: ${err.message}`);
            return [];
          }),
        ),
      );
      return loaded.flat();
    },

    /** Looks a template up by id (and version, for forms opened before a template changed). */
    async template(id, version) {
      if (!id) return null;
      // Ids from before templates were qualified are file names in the main repo.
      const repo = id.includes(':') ? this.get(id.slice(0, id.indexOf(':'))) : main;
      const qualified = id.includes(':') ? id : `${main.repo}:${id}`;
      return repo.templates.get(qualified, version);
    },

    /** Labels for the Label button, cached for 5 minutes per repo. */
    async labels(name) {
      const r = this.get(name);
      if (Date.now() - r.labels.at > 5 * 60_000) r.labels = { at: Date.now(), list: await r.github.listLabels() };
      return r.labels.list;
    },

    /** Counts for analytical questions, cached for 2 minutes per repo. Null if GitHub wouldn't say. */
    async stats(name) {
      const r = this.get(name);
      if (r.stats && Date.now() - r.stats.at < 2 * 60_000) return r.stats.value;
      let value = null;
      try {
        value = (await r.github.stats?.()) ?? null;
      } catch (err) {
        logger.warn(`Couldn't count issues in ${r.repo}: ${err.message}`);
      }
      r.stats = { at: Date.now(), value };
      return r.stats.value;
    },

    /** One person's issues in a repo, cached for 2 minutes. Null if GitHub has no such user or wouldn't say. */
    async personStats(name, login) {
      const r = this.get(name);
      r.people ??= new Map();
      const key = login.toLowerCase();
      const hit = r.people.get(key);
      if (hit && Date.now() - hit.at < 2 * 60_000) return hit.value;
      let value = null;
      try {
        value = (await r.github.personStats?.(login)) ?? null;
      } catch (err) {
        logger.warn(`Couldn't count @${login}'s issues in ${r.repo}: ${err.message}`);
      }
      r.people.set(key, { at: Date.now(), value });
      return value;
    },

    /**
     * What Alpieca can see and do in each repo, for questions like "what do you have access to?".
     * Templates kept outside a repo mean its token only needs Issues, so it can't read that repo's code.
     */
    access(subset = list) {
      return subset.map((r) => ({
        repo: r.repo,
        visibility: r.public ? 'public' : 'private',
        error: r.accessError,
        issuesOnly: Boolean(r.templateDir || r.templatePath),
        main: r.main,
      }));
    },

    /** How each repo looks from here, for the startup log: "owner/repo (private)", "owner/repo (no access: …)". */
    describe() {
      const access = (r) => (r.accessError ? ` (no access: ${r.accessError})` : r.public ? '' : ' (private)');
      // GitHub shows the token's owner as every issue's author, so say who that is.
      return list.map((r) => `${r.repo}${access(r)}${r.owner ? ` as @${r.owner}` : ''}`).join(' and ');
    },

    /** Loads templates and checks visibility. The main repo must work; the others may fail and retry later. */
    async start() {
      await Promise.all(
        list.map(async (r) => {
          r.public = await r.github.isPublic().catch((err) => {
            r.accessError = err.status === 404 || err.status === 403 ? 'token has no access' : err.status === 401 ? 'token rejected' : err.message;
            logger.warn(`Can't read ${r.repo} with its GitHub token (${r.accessError}). Filing issues there will fail.`);
            return true;
          });
          r.owner = await r.github.tokenOwner?.();
          await r.templates.refresh().catch((err) => {
            if (r.main) throw err;
            logger.warn(`Couldn't load templates from ${r.repo} yet: ${err.message}`);
          });
        }),
      );
    },
  };
}
