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
      const usable = list.filter((r) => !(guest && !r.public));
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

    /** Loads templates and checks visibility. The main repo must work; the others may fail and retry later. */
    async start() {
      await Promise.all(
        list.map(async (r) => {
          r.public = await r.github.isPublic().catch(() => true);
          await r.templates.refresh().catch((err) => {
            if (r.main) throw err;
            logger.warn(`Couldn't load templates from ${r.repo} yet: ${err.message}`);
          });
        }),
      );
    },
  };
}
