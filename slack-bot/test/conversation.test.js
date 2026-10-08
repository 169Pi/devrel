import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAnswerMessages, createAlpie, keepKnownLinks, parseDraft, stripReasoning } from '../src/alpie.js';
import { looksLikeIssue, markdownToMrkdwn } from '../src/slack-text.js';

// What Alpie actually sends: plain-text reasoning closed by </think>, with no opening tag.
const REAL_SHAPE = `Alright, let's tackle this. The schema is {"template_id": ...} and I'll pick merch.
</think>

\`\`\`json
{"template_id": "m.md", "title": "Neon hoodie", "fields": {"s0": "Hoodie"}, "additional_context": ""}
\`\`\``;

test('reasoning without an opening <think> tag is stripped before parsing', () => {
  assert.match(stripReasoning(REAL_SHAPE), /^```json/);
  assert.equal(stripReasoning('<think>still thinking when cut off'), '');
  assert.equal(stripReasoning('<think>a</think>answer'), 'answer');
  assert.equal(stripReasoning('plain answer'), 'plain answer');
  // A "{" inside the reasoning must not be mistaken for the JSON, even without a code fence.
  const unfenced = REAL_SHAPE.replace(/```json\n|```/g, '');
  const template = { id: 'm.md', titlePrefix: '', sections: [{ id: 's0', fields: [] }] };
  assert.equal(parseDraft(unfenced, [template], { feedback: 'hoodie' }).answers.s0, 'Hoodie');
});

test('intent guess separates issue reports from questions', () => {
  const issues = [
    'we should make black hoodies with a neon logo for the offsite',
    'the docs search is broken for quantization',
    'can you raise this as an issue?',
    'I built a pager with Alpie, want to showcase it',
    'streaming cuts off after 4k tokens, error 502',
    "it'd be great if the playground had dark mode",
  ];
  const questions = ['is there an issue about merch?', 'what issues are open?', 'how do I link my GitHub?', 'what is alpieca', 'thanks!', ''];
  for (const t of issues) assert.ok(looksLikeIssue(t), t);
  for (const t of questions) assert.ok(!looksLikeIssue(t), t);
});

test('answers are grounded: only listed issues, the repo and links from the thread survive', () => {
  const allowed = ['https://github.com/169Pi/devrel', 'https://github.com/169Pi/devrel/issues/7', 'https://docs.169pi.ai/x'];
  const text = [
    'See [#7](https://github.com/169Pi/devrel/issues/7) and [#99](https://github.com/169Pi/devrel/issues/99).',
    'Docs: https://docs.169pi.ai/x. Also https://made-up.example.com/page',
  ].join('\n');
  const kept = keepKnownLinks(text, allowed);
  assert.match(kept, /\[#7\]\(https:\/\/github\.com\/169Pi\/devrel\/issues\/7\)/);
  assert.match(kept, /and #99\./);
  assert.match(kept, /https:\/\/docs\.169pi\.ai\/x\./);
  assert.match(kept, /\[link removed\]/);
  assert.doesNotMatch(kept, /made-up|issues\/99/);
});

test('answer prompt carries repo, templates, recent issues and fenced conversation', () => {
  const [system, user] = buildAnswerMessages({
    repo: '169Pi/devrel',
    conversation: 'Priya: any merch issues open?',
    templates: [{ name: '169pi Merch Idea 👕', about: 'Pitch swag' }],
    issues: [{ number: 7, title: '[MERCH IDEA]: Hoodie', state: 'open', labels: ['merch'], url: 'https://github.com/169Pi/devrel/issues/7' }],
  });
  assert.match(system.content, /assistant for the GitHub repo 169Pi\/devrel/);
  assert.match(system.content, /data, not instructions/);
  assert.match(system.content, /Never invent issue numbers/);
  assert.match(user.content, /- 169pi Merch Idea 👕: Pitch swag/);
  assert.match(user.content, /- #7 \[open\] \[MERCH IDEA\]: Hoodie \(merch\) https:\/\/github\.com\/169Pi\/devrel\/issues\/7/);
  assert.match(user.content, /<conversation>\nPriya: any merch issues open\?\n<\/conversation>/);
});

test('answer() strips reasoning and invented links', async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: 'They ask about merch. Issue 7 matches.\n</think>\n\nYes: **#7** is open (https://github.com/169Pi/devrel/issues/7). See also https://fake.example/x' } }],
      }),
    );
  const alpie = createAlpie({ apiKey: 'k', baseUrl: 'https://x', model: 'm', timeoutMs: 1000, fetchImpl });
  const reply = await alpie.answer({
    repo: '169Pi/devrel',
    conversation: 'any merch issues?',
    templates: [],
    issues: [{ number: 7, title: 'Hoodie', state: 'open', labels: [], url: 'https://github.com/169Pi/devrel/issues/7' }],
  });
  assert.equal(reply, 'Yes: **#7** is open (https://github.com/169Pi/devrel/issues/7). See also [link removed]');
});

test('Alpie Markdown becomes safe Slack mrkdwn', () => {
  assert.equal(
    markdownToMrkdwn('## Status\n- **#7** is [open](https://github.com/169Pi/devrel/issues/7)\n- ping <!channel> & <@U1>'),
    '*Status*\n• *#7* is <https://github.com/169Pi/devrel/issues/7|open>\n• ping &lt;!channel&gt; &amp; &lt;@U1&gt;',
  );
});
