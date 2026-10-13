import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildAnswerMessages, buildDraftMessages, draftSchema, parseDraft } from '../src/alpie.js';
import { loadConfig } from '../src/config.js';
import { issueCard, issueRef, parseIssueRef } from '../src/issue-card.js';
import { downloadSlackFile, filesIn, imagesForAlpie } from '../src/media.js';
import { ATTACHMENTS_BLOCK, formView, readAnswers } from '../src/modal.js';
import { createRepos, qualify } from '../src/repos.js';
import { findTemplate, loadLocalTemplates, renderIssue } from '../src/templates.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEVREL_TEMPLATES = path.resolve(HERE, '../../.github/ISSUE_TEMPLATE');
const FEEDBACK_TEMPLATES = path.resolve(HERE, '../feedback-templates');
const silent = { warn() {}, error() {} };
const BASE_ENV = { SLACK_BOT_TOKEN: 'x', SLACK_APP_TOKEN: 'x', GITHUB_TOKEN: 'x' };

const feedbackTemplate = qualify(await loadLocalTemplates(FEEDBACK_TEMPLATES, silent), '169Pi/feedback')[0];

/** A fake GitHub client per repo; `private` repos report themselves as such. */
function fakeGitHub({ priv = [] } = {}) {
  return ({ repo, token }) => ({
    repo,
    token,
    isPublic: async () => !priv.includes(repo),
    loadTemplates: async () => {
      throw new Error('templates come from disk in tests');
    },
  });
}

async function twoRepos({ priv = ['169Pi/feedback'] } = {}) {
  const repos = createRepos(
    [
      { repo: '169Pi/devrel', templateDir: DEVREL_TEMPLATES },
      { repo: '169Pi/feedback', templateDir: FEEDBACK_TEMPLATES, linkFiles: true, mention: '@169Pi/engineering' },
    ],
    { token: 't', logger: silent, makeGitHub: fakeGitHub({ priv }) },
  );
  await repos.start();
  return repos;
}

test('config: feedback repo is optional and tags @169Pi/engineering by default', () => {
  assert.equal(loadConfig(BASE_ENV).feedback, null);
  const { feedback } = loadConfig({ ...BASE_ENV, FEEDBACK_REPO: '169Pi/product-feedback', FEEDBACK_SLACK_MENTION: 'S0ENG' });
  assert.equal(feedback.repo, '169Pi/product-feedback');
  assert.equal(feedback.mention, '@169Pi/engineering');
  assert.equal(feedback.slackMention, 'S0ENG');
  assert.equal(feedback.token, null, 'falls back to GITHUB_TOKEN');
  assert.equal(feedback.templatePath, 'slack-bot/feedback-templates', 'templates live with the bot');
  assert.equal(loadConfig({ ...BASE_ENV, FEEDBACK_REPO: 'a/b', FEEDBACK_GITHUB_TOKEN: 'issues-only' }).feedback.token, 'issues-only');
  assert.equal(loadConfig({ ...BASE_ENV, FEEDBACK_REPO: 'a/b', FEEDBACK_GITHUB_MENTION: '' }).feedback.mention, null);
  assert.throws(() => loadConfig({ ...BASE_ENV, FEEDBACK_REPO: 'nope' }), /owner\/repo/);
  assert.throws(() => loadConfig({ ...BASE_ENV, FEEDBACK_REPO: '169Pi/devrel' }), /differ/);
  assert.throws(() => loadConfig({ ...BASE_ENV, FEEDBACK_REPO: 'a/b', FEEDBACK_GITHUB_MENTION: 'engineering' }), /@user or @org\/team/);
  assert.throws(() => loadConfig({ ...BASE_ENV, FEEDBACK_REPO: 'a/b', FEEDBACK_SLACK_MENTION: '@eng' }), /user group/);
});

test('templates from both repos are offered together; guests only see public repos', async () => {
  const repos = await twoRepos();
  const all = await repos.templates();
  assert.deepEqual([...new Set(all.map((t) => t.repo))].sort(), ['169Pi/devrel', '169Pi/feedback']);
  assert.ok(all.every((t) => t.id === `${t.repo}:${t.file}`));
  const guest = await repos.templates({ guest: true });
  assert.ok(guest.length && guest.every((t) => t.repo === '169Pi/devrel'));
  // "/alpieca feedback" still finds the template by name, not by its repo-qualified id.
  assert.equal(findTemplate(all, 'feedback').repo, '169Pi/feedback');
  assert.equal(findTemplate(all, 'merch').repo, '169Pi/devrel');
});

test('template lookup handles qualified ids and ids from before there were two repos', async () => {
  const repos = await twoRepos();
  const merch = (await repos.templates()).find((t) => t.name.includes('Merch'));
  assert.equal((await repos.template(merch.id)).id, merch.id);
  assert.equal((await repos.template(merch.file)).id, merch.id, 'bare file name = main repo');
  assert.equal(await repos.template(null), null);
  assert.equal(repos.get('169pi/FEEDBACK').repo, '169Pi/feedback');
  assert.equal(repos.get(null).repo, '169Pi/devrel');
  assert.equal(repos.get('someone/else').repo, '169Pi/devrel');
});

test('the feedback repo can have its own token, and its templates can come from the main repo', async () => {
  const loaded = [];
  const repos = createRepos(
    [{ repo: '169Pi/devrel' }, { repo: '169Pi/app-alpie', token: 'issues-only', templatePath: 'slack-bot/feedback-templates' }],
    {
      token: 'main',
      logger: silent,
      makeGitHub: ({ repo, token }) => ({
        repo,
        token,
        isPublic: async () => repo.endsWith('devrel'),
        loadTemplates: async (dir = '.github/ISSUE_TEMPLATE') => {
          loaded.push(`${repo}/${dir}`);
          const source = dir.startsWith('slack-bot') ? FEEDBACK_TEMPLATES : DEVREL_TEMPLATES;
          return loadLocalTemplates(source, silent);
        },
      }),
    },
  );
  await repos.start();
  assert.equal(repos.get('169Pi/devrel').github.token, 'main');
  assert.equal(repos.get('169Pi/app-alpie').github.token, 'issues-only');
  assert.deepEqual(loaded.sort(), ['169Pi/devrel/.github/ISSUE_TEMPLATE', '169Pi/devrel/slack-bot/feedback-templates']);
  const feedback = (await repos.templates()).find((t) => t.repo === '169Pi/app-alpie');
  assert.equal(feedback.id, '169Pi/app-alpie:product-feedback.md');
  assert.equal(repos.get('169Pi/app-alpie').public, false);
});

test('a feedback repo that fails to load does not stop the bot', async () => {
  const repos = createRepos(
    [{ repo: '169Pi/devrel', templateDir: DEVREL_TEMPLATES }, { repo: '169Pi/feedback' }],
    { token: 't', logger: silent, makeGitHub: fakeGitHub() },
  );
  await repos.start();
  assert.ok((await repos.templates()).every((t) => t.repo === '169Pi/devrel'));
});

test('card buttons carry the repo, and old number-only values still parse', () => {
  assert.equal(issueRef('169Pi/feedback', 7), '169Pi/feedback#7');
  assert.equal(issueRef(undefined, 7), '7');
  assert.deepEqual(parseIssueRef('169Pi/feedback#7'), { repo: '169Pi/feedback', number: 7 });
  assert.deepEqual(parseIssueRef('42'), { repo: null, number: 42 });
  assert.equal(parseIssueRef('drop table'), null);
  const card = issueCard(
    { number: 7, title: 't', html_url: 'https://github.com/169Pi/feedback/issues/7', body: '', state: 'open', labels: [], assignees: [] },
    { repo: '169Pi/feedback' },
  );
  const values = card.blocks.find((b) => b.type === 'actions').elements.map((e) => e.value);
  assert.ok(values.every((v) => v === '169Pi/feedback#7'));
});

test('the feedback template asks the triage questions', () => {
  assert.equal(feedbackTemplate.titlePrefix, '[Feedback]: ');
  assert.deepEqual(feedbackTemplate.labels, ['feedback']);
  const fields = feedbackTemplate.sections.flatMap((s) => s.fields.map((f) => [f.label, f.optional]));
  assert.deepEqual(fields, [
    ['Product', false],
    ['Area or screen', false],
    ['Type (bug, UX problem, feature request, praise)', false],
    ['Who is affected (you, a teammate, a customer)', false],
    ['How often (every time, sometimes, once)', false],
    ['Severity (blocker, major, minor, cosmetic)', false],
    ['Version, browser, device or OS', true],
  ]);
  assert.ok(feedbackTemplate.sections.find((s) => s.title.startsWith('🔁')).optional);
});

test('feedback issues link the Slack files and @mention the team', () => {
  const issue = renderIssue(
    feedbackTemplate,
    { title: 'Export button does nothing', s1: 'Clicked Export, nothing happened.' },
    {
      reporter: 'Priya',
      githubLogin: 'priya-dev',
      files: [
        { name: 'export.png', permalink: 'https://169pi.slack.com/files/U1/F1/export.png', mimetype: 'image/png' },
        { name: 'repro_[1].mp4', permalink: 'https://169pi.slack.com/files/U1/F2/repro.mp4', mimetype: 'video/mp4' },
        { name: 'notes.pdf', permalink: 'https://evil.example/x', mimetype: 'application/pdf' },
      ],
      mention: '@169Pi/engineering',
    },
  );
  assert.equal(issue.title, '[Feedback]: Export button does nothing');
  assert.match(
    issue.body,
    /### 📎 Screenshots and recordings\n_In Slack\. Open them with your Slack account\._\n- \[🖼️ export\.png\]\(https:\/\/169pi\.slack\.com\/files\/U1\/F1\/export\.png\)\n- \[▶️ repro_1\.mp4\]\(https:\/\/169pi\.slack\.com\/files\/U1\/F2\/repro\.mp4\)\n- 📎 notes\.pdf\n/,
  );
  assert.match(issue.body, /\ncc @169Pi\/engineering\n\n---\n<sub>Raised from Slack by Priya \(@priya-dev\)/);
  // No media, no mention: nothing extra.
  assert.doesNotMatch(renderIssue(feedbackTemplate, { title: 'x' }).body, /Screenshots and recordings|cc @/);
});

test('files are picked out of a thread without duplicates or unusable ones', () => {
  const png = { id: 'F1', name: 'a.png', mimetype: 'image/png', size: 10 };
  const files = filesIn([
    { text: 'look', files: [png, { id: 'F2', name: 'drive doc', mode: 'external' }] },
    { text: 'again', files: [png, { id: 'F3', title: 'clip', mimetype: 'video/mp4', size: 99 }, { id: 'F4', mode: 'tombstone' }] },
    { text: 'no files' },
  ]);
  assert.deepEqual(files.map((f) => [f.id, f.name, f.mimetype]), [
    ['F1', 'a.png', 'image/png'],
    ['F3', 'clip', 'video/mp4'],
  ]);
  assert.equal(filesIn([{ files: Array.from({ length: 15 }, (_, i) => ({ id: `F${i}`, name: 'x' })) }]).length, 10);
});

test('Slack downloads use the bot token and catch the missing-scope sign-in page', async () => {
  const file = { name: 'a.png', mimetype: 'image/png', size: 3, url_private_download: 'https://files.slack.com/a.png' };
  let auth;
  const ok = async (url, init) => {
    auth = init.headers.Authorization;
    return new Response('png', { headers: { 'content-type': 'image/png' } });
  };
  assert.equal((await downloadSlackFile(file, { token: 'xoxb-1', fetchImpl: ok })).toString(), 'png');
  assert.equal(auth, 'Bearer xoxb-1');
  const signIn = async () => new Response('<html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(downloadSlackFile(file, { token: 't', fetchImpl: signIn }), /files:read/);
  await assert.rejects(downloadSlackFile({ ...file, size: 10 }, { token: 't', maxBytes: 5, fetchImpl: ok }), /larger than/);
});

test('only small images are shown to Alpie, at most four', async () => {
  const files = [
    ...Array.from({ length: 5 }, (_, i) => ({ id: `F${i}`, name: `s${i}.png`, mimetype: 'image/png', size: 100 })),
    { id: 'V', name: 'clip.mp4', mimetype: 'video/mp4', size: 100 },
    { id: 'H', name: 'huge.png', mimetype: 'image/png', size: 50 * 1024 * 1024 },
  ];
  const images = await imagesForAlpie([files[5], files[6], ...files.slice(0, 5)], async () => Buffer.from('img'), silent);
  assert.deepEqual(images.map((i) => i.name), ['s0.png', 's1.png', 's2.png', 's3.png']);
  assert.equal(images[0].url, `data:image/png;base64,${Buffer.from('img').toString('base64')}`);
  const failing = await imagesForAlpie(files.slice(0, 1), async () => {
    throw new Error('nope');
  }, silent);
  assert.deepEqual(failing, []);
});

test('drafts send screenshots to Alpie as image parts', () => {
  const [, user] = buildDraftMessages({
    templates: [feedbackTemplate],
    feedback: 'Export is broken',
    images: [{ name: 'export.png', url: 'data:image/png;base64,AAA' }],
  });
  assert.equal(user.content[0].type, 'text');
  assert.match(user.content[0].text, /Images attached to the feedback, in order: export\.png\./);
  assert.deepEqual(user.content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } });
  // Without images the message stays plain text.
  assert.equal(typeof buildDraftMessages({ templates: [feedbackTemplate], feedback: 'x' })[1].content, 'string');
});

test('the draft schema lists fields in document order, so no template loses fields', async () => {
  const repos = await twoRepos();
  const all = await repos.templates();
  const order = Object.keys(draftSchema(all).properties.fields.properties);
  assert.deepEqual(order.slice(0, 6), ['s0', 's0f0', 's0f1', 's0f2', 's1', 's2']);
  // Each template's own fields appear in the order the template has them.
  for (const t of all) {
    const own = t.sections.flatMap((sec) => (sec.fields.length ? sec.fields.map((f) => f.id) : [sec.id]));
    assert.deepEqual(order.filter((id) => own.includes(id)), own, t.name);
  }
});

test('Alpie is told not to guess severity or frequency', () => {
  const [, user] = buildDraftMessages({ templates: [feedbackTemplate], feedback: 'x' });
  const fields = JSON.parse(user.content.match(/\[[\s\S]*\]/)[0])[0].fields;
  const flagged = Object.values(fields).filter((f) => f.only_if_stated).map((f) => f.label);
  assert.deepEqual(flagged, ['How often (every time, sometimes, once)', 'Severity (blocker, major, minor, cosmetic)']);
});

test('severity and frequency are dropped unless the reporter said them', () => {
  const reply = (fields) => JSON.stringify({ title: 'Export broken', template_id: feedbackTemplate.id, fields, additional_context: '' });
  const ids = Object.fromEntries(feedbackTemplate.sections.flatMap((s) => s.fields.map((f) => [f.label.split(' ')[0], f.id])));
  const guessed = parseDraft(reply({ [ids.Severity]: 'major', [ids.How]: 'sometimes', [ids.Product]: 'Playground' }), [feedbackTemplate], {
    feedback: 'export is broken again',
  });
  assert.equal(guessed.answers[ids.Severity], '');
  assert.equal(guessed.answers[ids.How], '');
  assert.equal(guessed.answers[ids.Product], 'Playground', 'other fields are untouched');
  const said = parseDraft(reply({ [ids.Severity]: 'Blocker', [ids.How]: 'every time' }), [feedbackTemplate], {
    feedback: "it's a blocker for us, happens every time",
  });
  assert.equal(said.answers[ids.Severity], 'Blocker');
  assert.equal(said.answers[ids.How], 'every time');
});

test('answers know about both repos', () => {
  const [system, user] = buildAnswerMessages({
    repos: ['169Pi/devrel', '169Pi/feedback'],
    conversation: 'any export bugs?',
    templates: [feedbackTemplate],
    issues: [{ repo: '169Pi/feedback', number: 3, title: 'Export', state: 'open', labels: [], url: 'https://github.com/169Pi/feedback/issues/3' }],
  });
  assert.match(system.content, /GitHub repos 169Pi\/devrel and 169Pi\/feedback/);
  assert.match(system.content, /You run on 169Pi's Alpie model\./);
  const [seed] = buildAnswerMessages({ repos: ['169Pi/devrel'], model: 'alpie_9b', conversation: 'which model are you?' });
  assert.match(seed.content, /You run on 169Pi's Alpie Seed 9B \(alpie_9b\) model\. If asked which model you are, say exactly that\./);
  assert.match(user.content, /Product Feedback 💬 \(files to 169Pi\/feedback\)/);
  assert.match(user.content, /- 169Pi\/feedback#3 \[open\] Export/);
});

test('feedback forms list the conversation files to link', () => {
  const attachments = [
    { id: 'F1', name: 'export.png', size: 2 * 1024 * 1024 },
    { id: 'F2', name: 'repro.mp4', size: 300 * 1024 },
  ];
  const view = formView(feedbackTemplate, { linkFiles: true, attachments, mention: '@169Pi/engineering' });
  const block = (id) => view.blocks.find((b) => b.block_id === id);
  const boxes = block(ATTACHMENTS_BLOCK).element;
  assert.equal(boxes.type, 'checkboxes');
  assert.deepEqual(boxes.options.map((o) => [o.value, o.text.text]), [
    ['F1', 'export.png (2.0 MB)'],
    ['F2', 'repro.mp4 (300 KB)'],
  ]);
  assert.deepEqual(boxes.initial_options, boxes.options, 'all ticked to start with');
  assert.match(JSON.stringify(view.blocks), /Filed in \*<https:\/\/github\.com\/169Pi\/feedback\|169Pi\/feedback>\* · notifies `@169Pi\/engineering`/);

  // No files, no checkboxes.
  assert.equal(formView(feedbackTemplate, { linkFiles: true }).blocks.find((b) => b.block_id === ATTACHMENTS_BLOCK), undefined);

  // A repo that doesn't link files says so.
  const plain = formView({ ...feedbackTemplate, repo: '169Pi/devrel' }, { attachments });
  assert.equal(plain.blocks.find((b) => b.block_id === ATTACHMENTS_BLOCK), undefined);
  assert.match(JSON.stringify(plain.blocks), /aren't added to \*169Pi\/devrel\* issues/);
});

test('ticked files are read back as file ids', () => {
  const answers = readAnswers({
    state: { values: { [ATTACHMENTS_BLOCK]: { value: { type: 'checkboxes', selected_options: [{ value: 'F1' }] } } } },
  });
  assert.deepEqual(answers[ATTACHMENTS_BLOCK], ['F1']);
  const none = readAnswers({ state: { values: { [ATTACHMENTS_BLOCK]: { value: { type: 'checkboxes', selected_options: [] } } } } });
  assert.deepEqual(none[ATTACHMENTS_BLOCK], []);
});
