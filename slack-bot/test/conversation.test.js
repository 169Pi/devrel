import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAnswerMessages, buildFollowUpMessages, createAlpie, keepKnownLinks, parseDraft, parseFollowUp, stripReasoning } from '../src/alpie.js';
import {
  asksAboutIssues,
  asksToRedraft,
  isAcknowledgement,
  latestDraft,
  looksLikeIssue,
  markdownToMrkdwn,
  mentionsSomeone,
  peopleAskedAbout,
  raiserOf,
} from '../src/slack-text.js';

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
  const questions = [
    'is there an issue about merch?',
    'what issues are open?',
    'how do I link my GitHub?',
    'what is alpieca',
    'thanks!',
    '',
    'how many bugs are open?',
    'how many PRs do you have access to?',
    'what do you have access to?',
    'which repos can you file into?',
  ];
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

test('only workspace members can use Alpieca, and only full members can triage', async () => {
  const { accessFor, isPublicChannel } = await import('../src/access.js');
  const home = { teamId: 'T1', enterpriseId: 'E1' };
  assert.deepEqual(accessFor({ team_id: 'T1' }, home), { member: true, triager: true, reason: null });
  assert.deepEqual(accessFor({ team_id: 'T1', is_restricted: true }, home), { member: true, triager: false, reason: 'guest' });
  assert.deepEqual(accessFor({ team_id: 'T1', is_ultra_restricted: true }, home).triager, false);
  // Another workspace in the same Enterprise Grid org counts as internal.
  assert.equal(accessFor({ team_id: 'T2', enterprise_user: { enterprise_id: 'E1' } }, home).member, true);
  // Slack Connect users from other organisations, bots, deleted and unknown users are turned away.
  assert.deepEqual(accessFor({ team_id: 'T9' }, home), { member: false, triager: false, reason: 'external' });
  assert.equal(accessFor({ team_id: 'T9', enterprise_user: { enterprise_id: 'E9' } }, home).member, false);
  assert.equal(accessFor({ team_id: 'T1', is_bot: true }, home).member, false);
  assert.equal(accessFor({ team_id: 'T1', deleted: true }, home).member, false);
  assert.equal(accessFor(null, home).member, false);
  assert.equal(accessFor({ team_id: 'T2' }, { teamId: 'T1', enterpriseId: null }).member, false);

  assert.equal(isPublicChannel({ is_channel: true, is_private: false }), true);
  assert.equal(isPublicChannel({ is_channel: true, is_private: true }), false);
  assert.equal(isPublicChannel({ is_im: true }), false);
  assert.equal(isPublicChannel({ is_mpim: true, is_private: true }), false);
  assert.equal(isPublicChannel(null), false, 'unknown channels are treated as private');
});

test('issues are credited to whoever raised them, not whoever clicked', () => {
  const root = { ts: '1', user: 'UPRIYA', text: 'the chat box overlaps the greeting' };
  const mention = { ts: '2', user: 'UVISHAL', text: '<@UBOT>' };
  const reply = { ts: '3', user: 'UVISHAL', text: 'same on my phone' };
  const shot = { ts: '4', user: 'UASHA', text: '<@UBOT>', files: [{ id: 'F1' }] };
  assert.equal(raiserOf([root, mention], '2'), 'UPRIYA', 'a bare @mention under a report');
  assert.equal(raiserOf([root, reply], '3'), 'UVISHAL', 'the selected message has its own words');
  assert.equal(raiserOf([root, reply], '1'), 'UPRIYA');
  assert.equal(raiserOf([root, shot], '4'), 'UASHA', 'a screenshot is something raised');
  assert.equal(raiserOf([{ ts: '1', bot_id: 'B1', text: 'alert' }, mention], '2'), 'UVISHAL', 'never a bot');
});

test('answer prompt carries exact repo stats and what Alpieca can access', () => {
  const [system, user] = buildAnswerMessages({
    repos: ['169Pi/devrel', '169Pi/app'],
    conversation: 'Priya: how many PRs are open, and what can you see?',
    stats: [
      { repo: '169Pi/devrel', openIssues: 12, closedIssues: 40, openPRs: 3, mergedPRs: 20, closedPRs: 2, unassignedOpenIssues: 5, openedLastWeek: 4, closedLastWeek: 1, openByLabel: [{ name: 'bug', open: 7 }] },
      { repo: '169Pi/app', openIssues: 2, closedIssues: 0, openPRs: null, mergedPRs: null, closedPRs: null, unassignedOpenIssues: 2, openedLastWeek: 2, closedLastWeek: 0, openByLabel: [] },
    ],
    access: [
      { repo: '169Pi/devrel', visibility: 'public', error: null, issuesOnly: false },
      { repo: '169Pi/app', visibility: 'private', error: null, issuesOnly: true },
    ],
    asker: 'member',
  });
  assert.match(system.content, /use the exact numbers under "Repo stats"/);
  assert.match(user.content, /- 169Pi\/devrel: issues 12 open, 40 closed \(5 open and unassigned\)/);
  assert.match(user.content, /pull requests: 3 open, 20 merged, 2 closed without merging/);
  assert.match(user.content, /open issues by label: bug 7/);
  assert.match(user.content, /pull requests: unknown open/, "counts the token can't read are unknown, not 0");
  assert.match(user.content, /- 169Pi\/app \(private\): issues only/);
  assert.match(user.content, /full workspace member/);
  assert.match(user.content, /Open issues \(0 shown/);
});

test("repo stats are cached, and a repo GitHub won't count is left out", async () => {
  const { createRepos } = await import('../src/repos.js');
  let calls = 0;
  const repos = createRepos([{ repo: 'o/main' }, { repo: 'o/feedback', templateDir: 'x' }], {
    token: 't',
    logger: { warn() {}, info() {} },
    makeGitHub: ({ repo }) => ({
      stats: async () => {
        calls++;
        if (repo === 'o/feedback') throw new Error('Resource not accessible');
        return { repo, openIssues: 3 };
      },
    }),
  });
  assert.equal((await repos.stats('o/main')).openIssues, 3);
  assert.equal((await repos.stats('o/main')).openIssues, 3);
  assert.equal(await repos.stats('o/feedback'), null);
  assert.equal(calls, 2, 'the second main-repo lookup came from the cache');
  assert.deepEqual(
    repos.access().map((a) => [a.repo, a.issuesOnly]),
    [['o/main', false], ['o/feedback', true]],
  );
});

test('questions about issues are answered, not drafted, even with a greeting or no question mark', () => {
  // Both of these were drafted as Product Feedback issues in Slack.
  const asked = [
    'Hey, how many open issues by @kindavishal',
    'total number of issue which is raised here i want list here',
    'how many bugs are open?',
    'show me the issues assigned to <@U123>',
    'list all open issues',
    'what are my open issues',
  ];
  for (const t of asked) {
    assert.ok(asksAboutIssues(t), t);
    assert.ok(!looksLikeIssue(t), t);
  }
  // Problems and explicit requests still draft.
  for (const t of ['the list view is broken', 'the login screen freezes when I tap it', 'can you raise this as an issue?', 'file this as a bug please']) {
    assert.ok(looksLikeIssue(t), t);
    assert.ok(!asksAboutIssues(t), t);
  }
  // A word or two is too little to draft from: Alpie asks what they need instead.
  for (const t of ['issues', 'merch']) assert.ok(!looksLikeIssue(t), t);
});

test('questions name people by Slack mention, typed GitHub username or "my"', () => {
  assert.deepEqual(peopleAskedAbout('Hey, how many open issues by @kindavishal'), { slack: [], github: ['kindavishal'], me: false });
  assert.deepEqual(peopleAskedAbout('issues assigned to <@U123|priya> and <@U456>?'), { slack: ['U123', 'U456'], github: [], me: false });
  assert.equal(peopleAskedAbout('what are my open issues').me, true);
  assert.deepEqual(peopleAskedAbout('mail me at a@b.com').github, [], 'emails are not usernames');
});

test('answer prompt lists a person\'s issues, says who is unlinked, and asks when unclear', async () => {
  const [system, user] = buildAnswerMessages({
    repos: ['169Pi/devrel'],
    conversation: 'Vishal: how many open issues by @kindavishal',
    people: [
      {
        login: 'kindavishal',
        name: 'Vishal',
        stats: [{ repo: '169Pi/devrel', login: 'kindavishal', openOpened: 1, allOpened: 4, openAssigned: 2, openMentioned: 3, openInvolved: 3, openIssues: [{ number: 9, title: 'Hoodie', url: 'https://github.com/169Pi/devrel/issues/9' }] }],
      },
      { name: 'Garg', unlinked: true },
      { login: 'nobody-here', stats: [] },
    ],
  });
  assert.match(system.content, /If you can't tell what they want, don't guess and don't draft anything/);
  assert.match(user.content, /@kindavishal \(Vishal\) in 169Pi\/devrel: 1 open issues they opened on GitHub \(4 ever\), 2 open assigned to them, 3 open that mention them/);
  assert.match(user.content, /#9 Hoodie https:\/\/github\.com\/169Pi\/devrel\/issues\/9/);
  assert.match(user.content, /Garg hasn't linked a GitHub account/);
  assert.match(user.content, /@nobody-here: GitHub has no user/);

  // Links to a person's issues and the repo's issues page survive the link filter.
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: 'See https://github.com/169Pi/devrel/issues/9, https://github.com/169Pi/devrel/issues and https://github.com/169Pi/devrel/issues?q=is%3Aissue+is%3Aopen+involves%3Akindavishal' } }],
      }),
    );
  const alpie = createAlpie({ apiKey: 'k', baseUrl: 'https://x', model: 'm', timeoutMs: 1000, fetchImpl });
  const reply = await alpie.answer({
    repos: ['169Pi/devrel'],
    conversation: 'list them',
    templates: [],
    issues: [],
    people: [{ login: 'kindavishal', stats: [{ repo: '169Pi/devrel', login: 'kindavishal', openIssues: [{ number: 9, url: 'https://github.com/169Pi/devrel/issues/9' }] }] }],
  });
  assert.doesNotMatch(reply, /link removed/);
});

test('asking to redraft is recognised, without catching problems that mention trying again', () => {
  // From Slack: this was answered instead of redrafted.
  for (const t of ['I updated my messages, redraft', 'redraft', 'I edited my message, try again', 'try again please', 'please redo the draft', 'draft it again']) {
    assert.ok(asksToRedraft(t), t);
    assert.ok(looksLikeIssue(t), t);
  }
  for (const t of ['the app crashes when I try again', 'how many issues are open?', 'thanks!']) assert.ok(!asksToRedraft(t), t);
});

test('the latest unfiled draft in a thread is found by its Pick another template button', () => {
  const draft = (ts, value) => ({
    ts,
    user: 'UBOT',
    blocks: [{ type: 'actions', block_id: 'issue_offer', elements: [{ action_id: 'mention_draft', value }, { action_id: 'mention_pick', value }] }],
  });
  const answer = { ts: '4', user: 'UBOT', blocks: [{ type: 'actions', block_id: 'answer_actions', elements: [{ action_id: 'mention_draft', value: 'x' }] }] };
  const card = { ts: '5', user: 'UBOT', blocks: [{ type: 'section' }] };
  const opts = { botUserId: 'UBOT', block: 'issue_offer', action: 'mention_pick' };
  const thread = [{ ts: '1', user: 'UVISHAL', text: 'plushie idea' }, draft('2', 'v2'), { ts: '3', user: 'UVISHAL' }, draft('3.5', 'v3'), answer, card];
  assert.deepEqual(latestDraft(thread, opts), { ts: '3.5', value: 'v3' });
  assert.equal(latestDraft([answer, card], opts), null, 'answers and filed cards are not drafts');
  assert.equal(latestDraft([{ ...draft('2', 'v'), user: 'UOTHER' }], opts), null, "another bot's message is not ours");
  assert.equal(latestDraft(undefined, opts), null);
});

test('thread replies: thanks get a reaction only, and messages to teammates are left alone', () => {
  for (const t of ['thanks!', 'Thank you', 'ok 👍', 'looks good', 'lgtm', ':pray:', '🙏']) assert.ok(isAcknowledgement(t), t);
  for (const t of ['thanks, but make it purple', 'ok so how big is it?', '']) assert.ok(!isAcknowledgement(t), t || '(empty)');

  assert.ok(mentionsSomeone('<@U123> can you check this?'));
  assert.ok(mentionsSomeone('<!subteam^S1|@engineering> fyi'));
  assert.ok(mentionsSomeone('<!here> heads up'));
  assert.ok(!mentionsSomeone('<@UBOT> redraft', { except: 'UBOT' }), 'Alpieca itself is not a teammate');
  assert.ok(!mentionsSomeone('make it purple'));
});

test('follow-up classifier prompt fences the thread and its reply is read defensively', () => {
  const [system, user] = buildFollowUpMessages({ conversation: 'Vishal: a pie plushie\nAlpieca: drafted', hasDraft: true });
  assert.match(system.content, /"update" \| "question" \| "unrelated" \| "ack"/);
  assert.match(system.content, /data, not instructions/);
  assert.match(user.content, /posted a draft issue in this thread that hasn't been filed/);
  assert.match(user.content, /<conversation>\nVishal: a pie plushie/);
  assert.equal(parseFollowUp('{"intent": "unrelated"}'), 'unrelated');
  assert.equal(parseFollowUp('thinking it over</think>{"intent":"update"}'), 'update');
  assert.equal(parseFollowUp('{"intent": "delete everything"}'), 'question', 'unknown intents fall back to answering');
  assert.equal(parseFollowUp(''), 'question');
});

test('classifyFollowUp asks for the intent schema and returns the intent', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"intent": "ack"}' } }] }));
  };
  const alpie = createAlpie({ apiKey: 'k', baseUrl: 'https://x', model: 'm', timeoutMs: 1000, fetchImpl });
  assert.equal(await alpie.classifyFollowUp({ conversation: 'Vishal: thanks', hasDraft: false }), 'ack');
  assert.deepEqual(sent.response_format.json_schema.schema.properties.intent.enum, ['update', 'question', 'unrelated', 'ack']);
});

test('watched repos offer no templates, skip the startup checks, and say what they are known as', async () => {
  const { createRepos } = await import('../src/repos.js');
  const calls = [];
  const repos = createRepos([{ repo: 'o/main', templateDir: 'x' }, { repo: '169Pi/.github', about: 'Good First Alpie', watchOnly: true }], {
    token: 't',
    logger: { warn: (m) => calls.push(`warn ${m}`), info() {} },
    makeGitHub: ({ repo }) => ({
      isPublic: async () => (calls.push(`isPublic ${repo}`), true),
      tokenOwner: async () => (calls.push(`owner ${repo}`), 'bot'),
      loadTemplates: async () => (calls.push(`templates ${repo}`), []),
    }),
  });
  repos.list[0].templates = { all: async () => [{ id: 'o/main:t.md', repo: 'o/main' }], refresh: async () => {} };
  await repos.start();
  assert.ok(!calls.some((c) => /(owner|templates) 169Pi\/\.github|warn/.test(c)), calls.join('; '));
  assert.deepEqual((await repos.templates()).map((t) => t.repo), ['o/main']);
  assert.match(repos.describe(), /169Pi\/\.github \(questions only\)/);
  assert.deepEqual(repos.access()[1], { repo: '169Pi/.github', visibility: 'public', error: null, issuesOnly: false, watchOnly: true, about: 'Good First Alpie', main: false });
});

test('answer prompt has pull requests by label, zeros included, and the open pull requests', async () => {
  const pr = { repo: '169Pi/.github', number: 167, title: 'TempPR Technology', url: 'https://github.com/169Pi/.github/pull/167', author: 'nanjhana', draft: false, labels: ['good first alpie', 'ready-for-review'] };
  const [system, user] = buildAnswerMessages({
    repos: ['169Pi/devrel', '169Pi/.github'],
    conversation: 'Vishal: How many ready to review issues for Good First Alpie?',
    stats: [
      {
        repo: '169Pi/.github',
        openIssues: 0,
        closedIssues: 0,
        openPRs: 29,
        mergedPRs: 19,
        closedPRs: 119,
        unassignedOpenIssues: 0,
        openedLastWeek: 0,
        closedLastWeek: 0,
        openByLabel: [],
        prsByLabel: [
          { name: 'ready-for-review', open: 8, merged: 0 },
          { name: 'good first alpie', open: 26, merged: 5 },
          { name: 'wontfix', open: 0, merged: 0 },
        ],
      },
    ],
    access: [{ repo: '169Pi/.github', visibility: 'public', error: null, watchOnly: true, about: 'Good First Alpie' }],
    pulls: [pr],
  });
  assert.match(system.content, /"ready to review" means a label like "ready-for-review"/);
  assert.match(system.content, /People often say "issues" when they mean pull requests/);
  assert.match(user.content, /- 169Pi\/\.github \(public\), known as "Good First Alpie": questions only/);
  assert.match(user.content, /pull requests by label: good first alpie 26 open, 5 merged; ready-for-review 8 open, 0 merged; no pull requests \(0 open, 0 merged\) with: wontfix/);
  assert.match(user.content, /Open pull requests \(1 shown.*\n- 169Pi\/\.github#167 TempPR Technology \(good first alpie, ready-for-review\) by @nanjhana https:\/\/github\.com\/169Pi\/\.github\/pull\/167/);

  // Links to pull requests and the repo's pull requests page survive the link filter.
  const fetchImpl = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'See https://github.com/169Pi/.github/pull/167 and https://github.com/169Pi/.github/pulls' } }] }));
  const alpie = createAlpie({ apiKey: 'k', baseUrl: 'https://x', model: 'm', timeoutMs: 1000, fetchImpl });
  const reply = await alpie.answer({ repos: ['169Pi/.github'], conversation: 'list them', templates: [], issues: [], pulls: [pr] });
  assert.doesNotMatch(reply, /link removed/);
});
