import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildAnswerMessages, buildDraftMessages, draftSchema, parseDraft } from '../src/alpie.js';
import { loadConfig } from '../src/config.js';
import { issueCard, issueRef, parseIssueRef, previewBody } from '../src/issue-card.js';
import { downloadSlackFile, filesIn, imagesForAlpie } from '../src/media.js';
import { ATTACHMENTS_BLOCK, formView, readAnswers } from '../src/modal.js';
import { createRepos, qualify } from '../src/repos.js';
import { findTemplate, loadLocalTemplates, parseTemplate, renderIssue } from '../src/templates.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEVREL_TEMPLATES = path.resolve(HERE, '../../.github/ISSUE_TEMPLATE');
const FEEDBACK_TEMPLATES = path.resolve(HERE, '../feedback-templates');
const silent = { warn() {}, error() {} };
const BASE_ENV = { SLACK_BOT_TOKEN: 'x', SLACK_APP_TOKEN: 'x', GITHUB_TOKEN: 'x' };

const feedbackTemplate = qualify(await loadLocalTemplates(FEEDBACK_TEMPLATES, silent), '169Pi/feedback')[0];
/** The feedback template's bullet field ids by label, e.g. ids.Severity. */
const ids = Object.fromEntries(feedbackTemplate.sections.flatMap((s) => s.fields.map((f) => [f.label, f.id])));

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
  assert.equal(repos.describe(), '169Pi/devrel and 169Pi/app-alpie (private)');
  assert.equal(repos.get('169Pi/devrel').github.token, 'main');
  assert.equal(repos.get('169Pi/app-alpie').github.token, 'issues-only');
  assert.deepEqual(loaded.sort(), ['169Pi/devrel/.github/ISSUE_TEMPLATE', '169Pi/devrel/slack-bot/feedback-templates']);
  const feedback = (await repos.templates()).find((t) => t.repo === '169Pi/app-alpie');
  assert.equal(feedback.id, '169Pi/app-alpie:product-feedback.md');
  assert.equal(repos.get('169Pi/app-alpie').public, false);
});

test("a repo the token can't read is reported, and kept from guests", async () => {
  const warnings = [];
  const repos = createRepos(
    [{ repo: '169Pi/devrel', templateDir: DEVREL_TEMPLATES }, { repo: '169Pi/app-alpie', templateDir: FEEDBACK_TEMPLATES }],
    {
      token: 't',
      logger: { warn: (m) => warnings.push(m), error() {} },
      makeGitHub: ({ repo }) => ({
        repo,
        isPublic: async () => {
          if (repo.endsWith('app-alpie')) throw Object.assign(new Error('Not Found'), { status: 404 });
          return true;
        },
      }),
    },
  );
  await repos.start();
  assert.equal(repos.describe(), '169Pi/devrel and 169Pi/app-alpie (no access: token has no access)');
  assert.match(warnings.join('\n'), /Can't read 169Pi\/app-alpie .*Filing issues there will fail/);
  assert.ok((await repos.templates({ guest: true })).every((t) => t.repo === '169Pi/devrel'));
  assert.ok((await repos.templates()).some((t) => t.repo === '169Pi/app-alpie'), 'members still see it, so the error surfaces when filing');
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
  const products = feedbackTemplate.sections[0];
  assert.equal(products.title, '📱 Which products?');
  assert.deepEqual(products.choices, ['iOS App', 'Android App', 'API', 'Playground', 'Alpie Chat']);
  assert.equal(products.optional, false);
  const fields = feedbackTemplate.sections.flatMap((s) => s.fields.map((f) => [f.label, f.optional, f.options]));
  assert.deepEqual(fields, [
    ['Area or screen', false, null],
    ['Type', false, ['Bug', 'UX problem', 'Feature request', 'Praise']],
    ['Who is affected', false, ['Just me', 'Teammates', 'Customers', 'Everyone']],
    ['How often', false, ['Every time', 'Sometimes', 'Once']],
    ['Severity', false, ['Blocker', 'Major', 'Minor', 'Cosmetic']],
    ['App version or device', true, null],
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
  // Each template's own fields appear in the order the template has them.
  for (const t of all) {
    const own = t.sections.flatMap((sec) => (sec.fields.length ? sec.fields.map((f) => f.id) : [sec.id]));
    assert.deepEqual(order.filter((id) => own.includes(id)), own, t.name);
  }
});

test('the draft schema pins checkboxes and dropdowns to their options, and needs every field', () => {
  const fields = draftSchema([feedbackTemplate]).properties.fields;
  assert.deepEqual(fields.required, Object.keys(fields.properties));
  assert.deepEqual(fields.properties.s0, { type: 'array', items: { type: 'string', enum: ['iOS App', 'Android App', 'API', 'Playground', 'Alpie Chat'] } });
  assert.deepEqual(fields.properties[ids.Severity], { type: 'string', enum: ['Blocker', 'Major', 'Minor', 'Cosmetic', ''] });
  assert.deepEqual(fields.properties[ids['Area or screen']], { type: 'string' });
});

test("Alpie gets the options, and is told not to guess who's affected or how often", () => {
  const [system, user] = buildDraftMessages({ templates: [feedbackTemplate], feedback: 'x' });
  const fields = Object.values(JSON.parse(user.content.match(/\[[\s\S]*\]/)[0])[0].fields);
  assert.deepEqual(fields.filter((f) => f.only_if_stated).map((f) => f.label), ['Who is affected', 'How often', 'App version or device']);
  assert.deepEqual(fields.find((f) => f.label === 'Severity').options, ['Blocker', 'Major', 'Minor', 'Cosmetic']);
  assert.equal(fields.find((f) => f.label === 'Severity').single_line, undefined);
  assert.equal(fields.find((f) => f.label === 'Area or screen').single_line, true);
  const products = fields.find((f) => f.label === '📱 Which products?');
  assert.equal(products.pick_any_number, true);
  assert.deepEqual(products.options, ['iOS App', 'Android App', 'API', 'Playground', 'Alpie Chat']);
  // Problem reports get a full draft; pitches keep the no-invention rules.
  assert.match(system.content, /Problem reports .* make a complete first draft/);
  assert.match(system.content, /"Steps to reproduce": write the likely steps/);
  assert.match(system.content, /If they only say "the app", tick none/);
  assert.match(system.content, /Ideas and pitches[\s\S]*Never write persuasive/);
});

test("dropdown answers snap to an option, and who's affected / how often need the reporter's words", () => {
  const reply = (fields) => JSON.stringify({ title: 'Login freezes', template_id: feedbackTemplate.id, fields, additional_context: '' });
  const guessed = parseDraft(
    reply({ [ids.Severity]: 'blocker', [ids.Type]: 'nonsense', [ids['How often']]: 'Sometimes', [ids['Who is affected']]: 'Customers', [ids['Area or screen']]: 'Login screen' }),
    [feedbackTemplate],
    { feedback: 'login screen of the app freezes' },
  );
  assert.equal(guessed.answers[ids.Severity], 'Blocker', 'judged by Alpie, snapped to the option');
  assert.equal(guessed.answers[ids.Type], '', 'not an option');
  assert.equal(guessed.answers[ids['How often']], '', 'not said');
  assert.equal(guessed.answers[ids['Who is affected']], '', 'not said');
  assert.equal(guessed.answers[ids['Area or screen']], 'Login screen', 'text fields untouched');
  assert.equal(parseDraft(reply({ [ids.Type]: 'UX' }), [feedbackTemplate], { feedback: 'x' }).answers[ids.Type], 'UX problem', 'prefix of an option');

  const said = parseDraft(reply({ [ids['How often']]: 'Every time', [ids['Who is affected']]: 'Customers' }), [feedbackTemplate], {
    feedback: 'a customer reported it, and it happens every time',
  });
  assert.equal(said.answers[ids['How often']], 'Every time');
  assert.equal(said.answers[ids['Who is affected']], 'Customers', '"a customer" counts for "Customers"');
});

test('product ticks come from screenshots or named products, never from "the app"', () => {
  const reply = (s0) => JSON.stringify({ title: 't', template_id: feedbackTemplate.id, fields: { s0 }, additional_context: '' });
  const guess = reply(['iOS App', 'Android App', 'Teams App', 'ios app']);
  assert.deepEqual(parseDraft(guess, [feedbackTemplate], { feedback: 'login screen of the app freezes' }).answers.s0, [], '"the app" names none');
  assert.deepEqual(parseDraft(guess, [feedbackTemplate], { feedback: 'x', hasImages: true }).answers.s0, ['iOS App', 'Android App'], 'seen; unknown and duplicates dropped');
  assert.deepEqual(
    parseDraft(reply(['iOS App', 'Playground', 'Alpie Chat']), [feedbackTemplate], { feedback: 'frozen on iOS and in alpie chat' }).answers.s0,
    ['iOS App', 'Alpie Chat'],
    'named',
  );
  assert.deepEqual(parseDraft(JSON.stringify({ title: 't', template_id: feedbackTemplate.id, fields: { s0: 'iOS App' }, additional_context: '' }), [feedbackTemplate], { feedback: 'ios' }).answers.s0, [], 'not a list');
});

test("versions need the reporter's words, and emails Alpie read off a screenshot are removed", () => {
  const happened = feedbackTemplate.sections.find((s) => s.title.startsWith('📝')).id;
  const draft = parseDraft(
    JSON.stringify({
      title: 'Login freezes for vishal@example.com',
      template_id: feedbackTemplate.id,
      fields: { [ids['App version or device']]: 'iOS 17.4.1', [happened]: 'Stuck on Signing in for vishal@example.com; ask help@169pi.ai' },
      additional_context: '- User email is vishal@example.com',
    }),
    [feedbackTemplate],
    { feedback: 'login is frozen, see screenshot. ping help@169pi.ai' },
  );
  assert.equal(draft.answers[ids['App version or device']], '', 'version not typed');
  assert.equal(draft.answers[happened], 'Stuck on Signing in for [email removed]; ask help@169pi.ai', 'typed emails stay');
  assert.equal(draft.answers.title, 'Login freezes for [email removed]');
  assert.equal(draft.additionalContext, '- User email is [email removed]');
  const typed = parseDraft(
    JSON.stringify({ title: 't', template_id: feedbackTemplate.id, fields: { [ids['App version or device']]: 'v2.3.1 on Pixel 8' }, additional_context: '' }),
    [feedbackTemplate],
    { feedback: 'frozen on v2.3.1, my Pixel 8' },
  );
  assert.equal(typed.answers[ids['App version or device']], 'v2.3.1 on Pixel 8');
});

test('platform fields are kept from screenshots or words, never from a guess', () => {
  const t = qualify([parseTemplate('bug.md', '---\nname: Bug\n---\n### Where\n* **Platform (iOS, Android, All platforms):** \n')], 'a/b')[0];
  const reply = (v) => JSON.stringify({ title: 't', template_id: t.id, fields: { s0f0: v }, additional_context: '' });
  assert.equal(parseDraft(reply('All platforms'), [t], { feedback: 'login screen freezes' }).answers.s0f0, '', 'guessed from words alone');
  assert.equal(parseDraft(reply('iOS'), [t], { feedback: 'login freezes', hasImages: true }).answers.s0f0, 'iOS', 'read off a screenshot');
  assert.equal(parseDraft(reply('iOS'), [t], { feedback: 'login freezes on my ios phone' }).answers.s0f0, 'iOS', 'said');
});

test('an answer slipped into the field above (Product = Area) is cleared', () => {
  const t = qualify([parseTemplate('bug.md', '---\nname: Bug\n---\n### Where\n* **Product:** \n* **Area or screen:** \n')], 'a/b')[0];
  const reply = (product) => JSON.stringify({ title: 't', template_id: t.id, fields: { s0f0: product, s0f1: 'Login screen' }, additional_context: '' });
  const slipped = parseDraft(reply('login screen'), [t], { feedback: 'x' });
  assert.equal(slipped.answers.s0f0, '');
  assert.equal(slipped.answers.s0f1, 'Login screen');
  assert.equal(parseDraft(reply('Alpie'), [t], { feedback: 'x' }).answers.s0f0, 'Alpie');
});

test('option fields become dropdowns, with Alpie\'s pick selected', () => {
  const view = formView(feedbackTemplate, { initial: { [ids.Severity]: 'Blocker', [ids.Type]: 'nonsense' } });
  const block = (id) => view.blocks.find((b) => b.block_id === id);
  const severity = block(ids.Severity).element;
  assert.equal(severity.type, 'static_select');
  assert.deepEqual(severity.options.map((o) => o.value), ['Blocker', 'Major', 'Minor', 'Cosmetic']);
  assert.equal(severity.initial_option.value, 'Blocker');
  assert.equal(block(ids.Type).element.initial_option, undefined, 'unknown values leave it unselected');
  assert.equal(block(ids['Area or screen']).element.type, 'plain_text_input');
  // Dropdown answers come back like any other answer, and render into the template's layout.
  const answers = readAnswers({ state: { values: { [ids.Severity]: { value: { type: 'static_select', selected_option: { value: 'Major' } } } } } });
  assert.equal(answers[ids.Severity], 'Major');
  assert.match(renderIssue(feedbackTemplate, { title: 'x', ...answers }).body, /\* \*\*Severity \(Blocker, Major, Minor, Cosmetic\):\*\* Major/);
});

test('product checkboxes: ticked in the form, read back as a list, and a task list on GitHub', () => {
  const view = formView(feedbackTemplate, { initial: { s0: ['iOS App', 'Alpie Chat'] } });
  const boxes = view.blocks.find((b) => b.block_id === 's0');
  assert.equal(boxes.optional, false, 'at least one product');
  assert.equal(boxes.element.type, 'checkboxes');
  assert.deepEqual(boxes.element.options.map((o) => o.value), ['iOS App', 'Android App', 'API', 'Playground', 'Alpie Chat']);
  assert.deepEqual(boxes.element.initial_options.map((o) => o.value), ['iOS App', 'Alpie Chat']);
  assert.equal(formView(feedbackTemplate).blocks.find((b) => b.block_id === 's0').element.initial_options, undefined);

  const answers = readAnswers({
    state: { values: { s0: { value: { type: 'checkboxes', selected_options: [{ value: 'Android App' }, { value: 'API' }] } } } },
  });
  const issue = renderIssue(feedbackTemplate, { title: 'x', ...answers });
  assert.match(issue.body, /### 📱 Which products\?\n- \[ \] iOS App\n- \[x\] Android App\n- \[x\] API\n- \[ \] Playground\n- \[ \] Alpie Chat\n/);
  // The Slack card shows only what's ticked.
  const preview = previewBody(issue.body);
  assert.match(preview, /\*📱 Which products\?\*\n☑ Android App\n☑ API\n/);
  assert.doesNotMatch(preview, /iOS App|\[ \]/);
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
