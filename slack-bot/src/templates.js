import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export const TEMPLATE_DIR = '.github/ISSUE_TEMPLATE';
export const NO_RESPONSE = '_No response_';

const FRONT_MATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
// "* **Project Name:** " -> a single-line field inside a section
const BULLET_FIELD = /^\s*[*-]\s+\*\*(.+?):\*\*\s*(.*)$/;
// "*What does this do?*" or "_What does this do?_" -> guidance shown to the reporter
const ITALIC = /^(?:\*(?![*\s])(.+?)\*|_(?![_\s])(.+?)_)$/;
const OPTIONAL = /\b(optional|if applicable)\b/i;
const OPTIONAL_SUFFIX = /\s*\((?:optional|if applicable)\)\s*/gi;
const URL_FIELD = /\b(links?|repo|url|demo|docs?)\b/i;

export function isTemplateFile(name) {
  return /\.md$/i.test(name);
}

function toList(value) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function plain(markdown) {
  return markdown.replace(/[*_`]/g, '').replace(OPTIONAL_SUFFIX, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Parses a GitHub Markdown issue template into a structure the Slack modal and
 * the issue renderer share. Section and field ids double as Slack block ids.
 */
export function parseTemplate(id, source) {
  const match = source.match(FRONT_MATTER);
  if (!match) throw new Error(`Issue template "${id}" has no front matter`);
  const meta = parseYaml(match[1]) ?? {};
  if (!meta.name) throw new Error(`Issue template "${id}" has no name`);

  const sections = [];
  let current = null;
  for (const line of match[2].split(/\r?\n/)) {
    const heading = line.match(HEADING);
    if (heading) {
      current = { level: heading[1].length, heading: heading[2], guidance: [], fields: [] };
      sections.push(current);
      continue;
    }
    if (!current || !line.trim()) continue;
    const field = line.match(BULLET_FIELD);
    if (field) {
      current.fields.push({ rawLabel: field[1].trim() });
      continue;
    }
    const italic = line.trim().match(ITALIC);
    current.guidance.push(italic ? (italic[1] ?? italic[2]) : line.trim());
  }
  if (!sections.length) throw new Error(`Issue template "${id}" has no ### sections`);

  const rawTitle = String(meta.title ?? '');
  const placeholderAt = rawTitle.indexOf('<');

  return {
    id,
    version: createHash('sha1').update(source).digest('hex').slice(0, 10),
    name: String(meta.name).trim(),
    about: String(meta.about ?? '').trim(),
    titlePrefix: placeholderAt === -1 ? rawTitle : rawTitle.slice(0, placeholderAt),
    labels: toList(meta.labels),
    assignees: toList(meta.assignees),
    sections: sections.map((section, i) => {
      const sectionOptional = OPTIONAL.test(section.heading);
      return {
        id: `s${i}`,
        level: section.level,
        heading: section.heading,
        title: plain(section.heading),
        guidance: section.guidance.join(' '),
        optional: sectionOptional,
        fields: section.fields.map((field, j) => ({
          id: `s${i}f${j}`,
          rawLabel: field.rawLabel,
          label: plain(field.rawLabel),
          optional: sectionOptional || OPTIONAL.test(field.rawLabel),
          url: URL_FIELD.test(field.rawLabel),
        })),
      };
    }),
  };
}

/** Parses [filename, source] pairs, skipping (and logging) templates that don't parse. */
export function parseTemplates(entries, logger = console) {
  const templates = [];
  for (const [id, source] of entries) {
    try {
      templates.push(parseTemplate(id, source));
    } catch (err) {
      logger.warn(`Skipping issue template: ${err.message}`);
    }
  }
  return templates.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadLocalTemplates(dir, logger = console) {
  const names = (await readdir(dir)).filter(isTemplateFile);
  const entries = await Promise.all(
    names.map(async (name) => [name, await readFile(path.join(dir, name), 'utf8')]),
  );
  return parseTemplates(entries, logger);
}

/** Matches `/devrel-issue merch` style shortcuts against template ids and names. */
export function findTemplate(templates, query) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const q = norm(query);
  if (!q) return null;
  const hits = templates.filter((t) => norm(t.id).includes(q) || norm(t.name).includes(q));
  return hits.length === 1 ? hits[0] : null;
}

/** Returns Slack `response_action: errors` entries keyed by block id. */
export function validateAnswers(template, answers) {
  const errors = {};
  const summary = (answers.title ?? '').trim();
  if (!summary) errors.title = 'Give the issue a short title.';
  else if (template.titlePrefix.length + summary.length > 256) {
    errors.title = `Keep the title under ${256 - template.titlePrefix.length} characters.`;
  }
  for (const section of template.sections) {
    for (const field of section.fields) {
      const value = (answers[field.id] ?? '').trim();
      if (field.url && value && !/https?:\/\/\S+/.test(value)) {
        errors[field.id] = 'Paste a full link starting with https://';
      }
    }
  }
  return errors;
}

function oneLine(value) {
  return (value ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
}

function stripPrefix(prefix, summary) {
  const p = prefix.trim().toLowerCase();
  return p && summary.toLowerCase().startsWith(p) ? summary.slice(p.length).trimStart() : summary;
}

/**
 * Renders answers back into the template's own Markdown layout, so issues filed
 * from Slack look exactly like issues filed through GitHub's "New issue" page.
 */
export function renderIssue(template, answers, { reporter, drafted = false, source } = {}) {
  const summary = stripPrefix(template.titlePrefix, (answers.title ?? '').trim());
  const parts = template.sections.map((section) => {
    const heading = `${'#'.repeat(section.level)} ${section.heading}`;
    if (section.fields.length) {
      const lines = section.fields.map(
        (f) => `* **${f.rawLabel}:** ${oneLine(answers[f.id]) || NO_RESPONSE}`,
      );
      return [heading, ...lines].join('\n');
    }
    return `${heading}\n${(answers[section.id] ?? '').trim() || NO_RESPONSE}`;
  });
  const extra = (answers.extra_context ?? '').trim();
  if (extra) parts.push(`### ${drafted ? '🤖 ' : ''}Additional context\n${extra}`);
  const footer = [
    reporter && `Raised from Slack by ${reporter.replace(/[<>@]/g, '').trim()}`,
    drafted && 'drafted with Alpie',
    source && `[source thread](${source})`,
  ].filter(Boolean);
  if (footer.length) parts.push(`---\n<sub>${footer.join(' · ')}</sub>`);
  return {
    title: `${template.titlePrefix}${summary}`,
    body: `${parts.join('\n\n')}\n`,
    labels: template.labels,
    assignees: template.assignees,
  };
}

/**
 * Caches templates so modals open inside Slack's 3-second trigger window.
 * Stale caches are refreshed in the background; older template versions stay
 * addressable so a modal opened before a template edit still submits cleanly.
 */
export function createTemplateStore(load, { ttlMs = 5 * 60_000, logger = console } = {}) {
  let current = null;
  let fetchedAt = 0;
  let inflight = null;
  const versions = new Map();

  function refresh() {
    inflight ??= load()
      .then((templates) => {
        if (!templates.length) throw new Error(`No usable issue templates found in ${TEMPLATE_DIR}`);
        for (const t of templates) versions.set(`${t.id}@${t.version}`, t);
        current = templates;
        fetchedAt = Date.now();
        return templates;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return {
    refresh,
    async all() {
      if (!current) return refresh();
      if (Date.now() - fetchedAt > ttlMs) {
        refresh().catch((err) => logger.error(`Template refresh failed: ${err.message}`));
      }
      return current;
    },
    async get(id, version) {
      const latest = (await this.all()).find((t) => t.id === id);
      return (version && versions.get(`${id}@${version}`)) || latest;
    },
  };
}
