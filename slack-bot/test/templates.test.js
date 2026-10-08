import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { formView, pickerView, readAnswers } from '../src/modal.js';
import {
  createTemplateStore,
  findTemplate,
  loadLocalTemplates,
  NO_RESPONSE,
  parseTemplate,
  renderIssue,
  validateAnswers,
} from '../src/templates.js';

const REPO_TEMPLATES = path.resolve(fileURLToPath(import.meta.url), '../../../.github/ISSUE_TEMPLATE');
const silent = { warn() {}, error() {} };
const templates = await loadLocalTemplates(REPO_TEMPLATES, silent);
const byName = (needle) => templates.find((t) => t.name.includes(needle));

test('every template in the repo parses', async () => {
  assert.equal(templates.length, 2);
  const merch = byName('Merch');
  assert.equal(merch.name, '169pi Merch Idea 👕');
  assert.equal(merch.titlePrefix, '[MERCH IDEA]: ');
  assert.deepEqual(merch.labels, ['merch']);
  assert.deepEqual(merch.assignees, []);
  assert.deepEqual(
    merch.sections.map((s) => [s.title, s.optional]),
    [
      ["👕 What's the Merch?", false],
      ['🎨 The Design & Vibe', false],
      ['🤔 Why do we NEED this?', false],
      ['📸 Inspiration / Moodboard', true],
    ],
  );
  assert.match(merch.sections[0].guidance, /^What kind of item/);
});

test('bullet fields become individual inputs with optional/url flags', () => {
  const alpie = byName('Alpie');
  assert.equal(alpie.titlePrefix, '[Project]: ');
  assert.deepEqual(alpie.labels, ['alpie-core', 'dogfooding', 'showcase']);
  const fields = alpie.sections.flatMap((s) => s.fields.map((f) => [f.label, f.optional, f.url]));
  assert.deepEqual(fields, [
    ['Project Name', false, false],
    ['The Mastermind(s)', false, false],
    ['Source Code Repo', false, true],
    ['Live Demo', true, true],
    ['Related Docs', false, true],
  ]);
});

test('rendered issue keeps the template layout byte-for-byte', async () => {
  const alpie = byName('Alpie');
  const answers = {
    title: 'Alpie Pager',
    s0f0: 'Alpie Pager',
    s0f1: 'Ada Lovelace',
    s1: 'Pages the on-call\nwhen evals regress.',
    s2: 'Used the eval API.',
    s3f0: 'https://github.com/169Pi/pager',
    s3f1: '',
    s3f2: 'https://docs.example.com',
  };
  const issue = renderIssue(alpie, answers, { reporter: 'Ada Lovelace' });
  assert.equal(issue.title, '[Project]: Alpie Pager');
  assert.deepEqual(issue.labels, ['alpie-core', 'dogfooding', 'showcase']);

  // Every heading and bullet label from the source template survives, in order.
  const source = await readFile(path.join(REPO_TEMPLATES, alpie.id), 'utf8');
  const skeleton = (md) => md.split('\n').filter((l) => /^#{1,6} |^\* \*\*/.test(l)).map((l) => l.replace(/:\*\*.*/, ':**'));
  assert.deepEqual(skeleton(issue.body), skeleton(source.split(/^---$/m)[2]));

  assert.match(issue.body, /\* \*\*Live Demo \(if applicable\):\*\* _No response_/);
  assert.match(issue.body, /### 📝 The Elevator Pitch\nPages the on-call\nwhen evals regress\./);
  assert.match(issue.body, /Raised from Slack by Ada Lovelace<\/sub>\n\n<!-- alpieca -->\n$/);
});

test('title prefix is not doubled and empty optional sections say so', () => {
  const merch = byName('Merch');
  const issue = renderIssue(merch, { title: '[merch idea]: Neon socks', s0: 'Socks', s1: 'Neon', s2: 'Warm feet' });
  assert.equal(issue.title, '[MERCH IDEA]: Neon socks');
  assert.ok(issue.body.includes(`### 📸 Inspiration / Moodboard (Optional)\n${NO_RESPONSE}\n\n<!-- alpieca -->`));
});

test('validation flags non-links and over-long titles', () => {
  const alpie = byName('Alpie');
  assert.deepEqual(validateAnswers(alpie, { title: 'ok', s3f0: 'github.com/foo', s3f1: '' }), {
    s3f0: 'Paste a full link starting with https://',
  });
  assert.ok(validateAnswers(alpie, { title: 'x'.repeat(300) }).title);
  assert.deepEqual(validateAnswers(alpie, { title: 'ok', s3f0: 'see https://github.com/x' }), {});
});

test('modal views respect Slack limits and round-trip answers', () => {
  for (const t of templates) {
    const view = formView(t, { authorName: 'Ada Lovelace' });
    assert.ok(view.title.text.length <= 24, view.title.text);
    assert.ok(view.blocks.length <= 100);
    const ids = view.blocks.filter((b) => b.type === 'input').map((b) => b.block_id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, [
      'title',
      ...t.sections.flatMap((s) => (s.fields.length ? s.fields.map((f) => f.id) : [s.id])),
      'github_login',
    ]);
    assert.deepEqual(JSON.parse(view.private_metadata), { templateId: t.id, version: t.version });
  }
  const alpie = formView(byName('Alpie'), { authorName: 'Ada Lovelace' });
  assert.equal(alpie.blocks.find((b) => b.block_id === 's0f1').element.initial_value, 'Ada Lovelace');

  const picker = pickerView(templates, { repo: '169Pi/devrel' });
  assert.equal(picker.blocks[1].element.options.length, 2);
  const state = { values: { template: { value: { type: 'radio_buttons', selected_option: { value: 'x.md' } } }, title: { value: { value: 'hi' } } } };
  assert.deepEqual(readAnswers({ state }), { template: 'x.md', title: 'hi' });
});

test('findTemplate resolves slash-command shortcuts', () => {
  assert.equal(findTemplate(templates, 'merch').name, '169pi Merch Idea 👕');
  assert.equal(findTemplate(templates, 'showcase').name, 'Alpie Showcase 🏆');
  assert.equal(findTemplate(templates, 'nope'), null);
});

test('malformed templates are skipped, not fatal', () => {
  assert.throws(() => parseTemplate('bad.md', 'no front matter'), /no front matter/);
});

test('template store keeps old versions for in-flight modals', async () => {
  const v1 = parseTemplate('a.md', '---\nname: A\n---\n### One\n');
  const v2 = parseTemplate('a.md', '---\nname: A\n---\n### One\n### Two\n');
  let next = [v1];
  const store = createTemplateStore(async () => next, { ttlMs: 0, logger: silent });
  await store.refresh();
  next = [v2];
  await store.refresh();
  assert.equal((await store.get('a.md')).sections.length, 2);
  assert.equal((await store.get('a.md', v1.version)).sections.length, 1);
});
