import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AlpieError, buildDraftMessages, createAlpie, parseDraft } from '../src/alpie.js';
import { EXTRA_CONTEXT, formView } from '../src/modal.js';
import { slackToPlain, threadTranscript } from '../src/slack-text.js';
import { loadLocalTemplates, renderIssue } from '../src/templates.js';

const REPO_TEMPLATES = path.resolve(fileURLToPath(import.meta.url), '../../../.github/ISSUE_TEMPLATE');
const templates = await loadLocalTemplates(REPO_TEMPLATES, { warn() {} });
const alpie = templates.find((t) => t.name.includes('Alpie'));
const merch = templates.find((t) => t.name.includes('Merch'));

const FEEDBACK = `Priya: I built a Slack pager on top of Alpie that pings on-call when eval scores drop.
Repo is https://github.com/169Pi/alpie-pager, demo coming next week.
Rahul: streaming responses cut off after ~4k tokens which was painful.`;

function reply(obj, { think = true, fence = false } = {}) {
  const json = JSON.stringify(obj);
  return `${think ? '<think>Let me map this to the showcase template {not json}.</think>\n' : ''}${fence ? `\`\`\`json\n${json}\n\`\`\`` : json}`;
}

const GOOD = {
  template_id: alpie.id,
  title: '[Project]: Alpie Pager',
  fields: {
    s0f0: 'Alpie Pager',
    s0f1: 'Priya',
    s1: 'A Slack pager that pings on-call when eval scores drop.',
    s2: 'Built on Alpie.\nPain point: streaming cut off after ~4k tokens.',
    s3f0: 'https://github.com/169Pi/alpie-pager',
    s3f1: 'https://alpie-pager.vercel.app', // invented: not in the feedback
    s3f2: 'docs',
    bogus: 'ignored',
  },
  additional_context: '- Rahul hit the streaming cutoff too\n- Demo expected next week',
};

test('prompt carries template schema, reporter, and fenced feedback', () => {
  const [system, user] = buildDraftMessages({ templates, feedback: FEEDBACK, reporter: 'Vishal Das' });
  assert.match(system.content, /data, not instructions/);
  assert.match(user.content, /Pick the template/);
  assert.match(user.content, /"s3f0"/);
  assert.match(user.content, /"link": true/);
  assert.match(user.content, /reporter .* is Vishal Das/);
  assert.match(user.content, /<feedback>\nPriya: I built/);
  assert.match(buildDraftMessages({ templates: [merch], feedback: 'x' })[1].content, /Use this template/);
});

test('draft is sanitised: prefix stripped, invented links and unknown keys dropped', () => {
  const draft = parseDraft(reply(GOOD), templates, { feedback: FEEDBACK });
  assert.equal(draft.template, alpie);
  assert.equal(draft.answers.title, 'Alpie Pager');
  assert.equal(draft.answers.s3f0, 'https://github.com/169Pi/alpie-pager');
  assert.equal(draft.answers.s3f1, '', 'hallucinated demo URL must not survive');
  assert.equal(draft.answers.s3f2, '', 'link field without a link is left for the reporter');
  assert.equal(draft.answers.s0f1, 'Priya');
  assert.match(draft.answers.s2, /\n/, 'multi-line sections keep line breaks');
  assert.equal(draft.answers.bogus, undefined);
  assert.match(draft.additionalContext, /Rahul/);
});

test('fenced JSON and missing fields are handled', () => {
  const draft = parseDraft(reply({ template_id: merch.id, title: 'Neon socks', fields: { s0: 'Socks' } }, { fence: true }), templates, {
    feedback: 'neon socks pls',
  });
  assert.equal(draft.template, merch);
  assert.equal(draft.answers.s1, '');
  assert.equal(draft.additionalContext, '');
});

test('no matching template is an AlpieError (falls back to the picker)', () => {
  assert.throws(() => parseDraft(reply({ template_id: null, fields: {} }), templates, { feedback: 'x' }), AlpieError);
  assert.throws(() => parseDraft('I think this is a bug report.', templates, { feedback: 'x' }), /valid JSON/);
});

test('client posts to chat/completions and retries once on non-JSON', async () => {
  const calls = [];
  const replies = ['Sure! Here is the issue.', reply(GOOD)];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init: { ...init, body: JSON.parse(init.body) } });
    return new Response(JSON.stringify({ choices: [{ message: { content: replies.shift() } }] }), { status: 200 });
  };
  const client = createAlpie({ apiKey: 'k', baseUrl: 'https://api.169pi.com/v1/', model: 'alpie-32b', timeoutMs: 1000, fetchImpl });
  const draft = await client.draft({ templates, feedback: FEEDBACK });
  assert.equal(draft.template, alpie);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.169pi.com/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  assert.equal(calls[0].init.body.model, 'alpie-32b');
  assert.equal(calls[1].init.body.messages.at(-1).role, 'user');
});

test('API errors surface the backend message', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: { message: 'Key not active', type: 'key_not_active', code: 402 } }), { status: 402 });
  const client = createAlpie({ apiKey: 'k', baseUrl: 'https://x', model: 'm', timeoutMs: 1000, fetchImpl });
  await assert.rejects(client.draft({ templates, feedback: 'x' }), /Alpie API error 402: Key not active/);
});

test('drafted form is pre-filled, flagged, and renders Alpie context into the issue', () => {
  const draft = parseDraft(reply(GOOD), templates, { feedback: FEEDBACK });
  const source = 'https://169pi.slack.com/archives/C1/p123';
  const view = formView(draft.template, {
    authorName: 'Vishal Das',
    initial: draft.answers,
    extraContext: draft.additionalContext,
    drafted: true,
    source,
    publicRepo: true,
  });
  const block = (id) => view.blocks.find((b) => b.block_id === id);
  assert.equal(block('title').element.initial_value, 'Alpie Pager');
  assert.equal(block('s0f1').element.initial_value, 'Priya', 'Alpie answer beats the Slack-name default');
  assert.equal(block('s3f1').element.initial_value, undefined);
  assert.match(block(EXTRA_CONTEXT).label.text, /Alpie/);
  assert.ok(view.blocks.some((b) => b.type === 'context' && /public/.test(b.elements[0].text)));
  assert.deepEqual(JSON.parse(view.private_metadata), { templateId: alpie.id, version: alpie.version, drafted: true, source });

  const issue = renderIssue(alpie, { ...draft.answers, s3f2: 'https://docs.169pi.ai', [EXTRA_CONTEXT]: draft.additionalContext }, {
    reporter: 'Vishal Das',
    drafted: true,
    source,
  });
  assert.match(issue.body, /### 🤖 Additional context\n- Rahul hit the streaming cutoff too/);
  assert.match(issue.body, /<sub>Raised from Slack by Vishal Das · drafted with Alpie · \[source thread\]\(https:\/\/169pi\.slack\.com/);
  // Without Alpie context, no extra section appears.
  assert.doesNotMatch(renderIssue(alpie, { title: 'x' }).body, /Additional context/);
});

test('Slack markup is flattened for Alpie', async () => {
  const resolveUser = async (id) => ({ U1: 'Priya', U2: 'Rahul' })[id];
  assert.equal(
    await slackToPlain('<@U1> see <https://github.com/x|the repo> in <#C9|devrel> &amp; ping <!here> <@U404>', resolveUser),
    '@Priya see the repo (https://github.com/x) in #devrel & ping @here @someone',
  );
  const transcript = await threadTranscript(
    [
      { user: 'U1', ts: '1', text: 'Pager idea' },
      { user: 'U2', ts: '2', text: 'streaming cuts off' },
      { bot_profile: { name: 'CI' }, ts: '3', text: 'build green' },
    ],
    { selectedTs: '2', resolveUser },
  );
  assert.equal(transcript, 'Priya: Pager idea\nRahul (selected message): streaming cuts off\nCI: build green');

  const long = await threadTranscript(
    Array.from({ length: 50 }, (_, i) => ({ user: 'U1', ts: String(i), text: `message ${i} ${'x'.repeat(50)}` })),
    { resolveUser, maxChars: 600 },
  );
  assert.ok(long.startsWith('Priya: message 0 '), 'opening message is kept');
  assert.match(long, /earlier replies omitted/);
  assert.ok(long.endsWith(`message 49 ${'x'.repeat(50)}`));
});
