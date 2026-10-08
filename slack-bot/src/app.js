import path from 'node:path';
import { App } from '@slack/bolt';
import { AlpieError, createAlpie } from './alpie.js';
import { loadConfig } from './config.js';
import { createGitHub } from './github.js';
import { ACTION, escapeSlack, issueCard } from './issue-card.js';
import {
  CALLBACK,
  commentView,
  formView,
  GITHUB_LOGIN_BLOCK,
  githubLoginView,
  labelView,
  pickerView,
  readAnswers,
  statusView,
} from './modal.js';
import { createPeopleStore, GITHUB_LOGIN, normalizeLogin } from './people.js';
import { createProgress, startTicker, statusLine } from './progress.js';
import { looksLikeIssue, markdownToMrkdwn, threadTranscript } from './slack-text.js';
import {
  createTemplateStore,
  findTemplate,
  loadLocalTemplates,
  renderIssue,
  validateAnswers,
} from './templates.js';

const config = loadConfig();
const repo = config.github.repo;
const github = createGitHub(config.github);
const alpie = config.alpie ? createAlpie(config.alpie) : null;
const people = await createPeopleStore(path.join(config.dataDir, 'people.json'));
const templates = createTemplateStore(
  config.templateDir ? () => loadLocalTemplates(config.templateDir) : () => github.loadTemplates(),
  { ttlMs: config.templateTtlMs },
);
// Assume public until GitHub says otherwise, so reporters are always warned when in doubt.
let publicRepo = true;

const app = new App({
  token: config.slack.token,
  appToken: config.slack.appToken,
  signingSecret: config.slack.signingSecret,
  socketMode: config.slack.socketMode,
  port: config.slack.port,
});

const names = new Map();
async function displayName(client, userId) {
  if (!names.has(userId)) {
    try {
      const { user } = await client.users.info({ user: userId });
      names.set(userId, user.profile?.real_name || user.profile?.display_name || user.name);
    } catch {
      return null;
    }
  }
  return names.get(userId);
}

let labelCache = { at: 0, labels: [] };
async function repoLabels() {
  if (Date.now() - labelCache.at > 5 * 60_000) labelCache = { at: Date.now(), labels: await github.listLabels() };
  return labelCache.labels;
}

/** Validates a GitHub username typed into Slack. Returns { login } or { error }. */
async function checkGithubLogin(value) {
  const login = normalizeLogin(value);
  if (!GITHUB_LOGIN.test(login)) return { error: "That doesn't look like a GitHub username." };
  // If GitHub can't be reached, accept the name rather than block the reporter.
  if (!(await github.userExists(login).catch(() => true))) return { error: `There's no GitHub user called @${login}.` };
  return { login };
}

/** The "Alpie is drafting…" modal. With progress, it's one frame of the loading animation. */
const draftingView = (what, progress = createProgress(), tick = 0) =>
  statusView(
    'Alpie is drafting…',
    `${statusLine(progress, tick, 'draft')}\n\n_Turning ${what} into an issue draft. This usually takes 10–20 seconds._`,
  );

const formFor = (template, userId, authorName, opts = {}) =>
  formView(template, { authorName, githubLogin: people.githubFor(userId), publicRepo, ...opts });

const pickerFor = (all, opts = {}) => pickerView(all, { repo, alpie: Boolean(alpie), ...opts });

/**
 * Has Alpie draft the issue, then swaps the open modal (viewId) for a pre-filled
 * form the reporter reviews. Falls back to a manual form or the picker, keeping
 * the original feedback, if Alpie fails or no template fits.
 * `origin` ({ channel, thread }) is where the confirmation card gets posted.
 * `pending` is a draft already started in the background (see prefetchDraft).
 */
async function draftIntoView({ client, logger, viewId, userId, feedback, template, source, origin, pending, progress, what = 'this' }) {
  const [all, authorName] = await Promise.all([templates.all(), displayName(client, userId)]);
  // A background draft brings its own progress; otherwise track this one as it streams.
  const live = progress ?? createProgress();
  const stopAnimation = startTicker(
    (tick) => client.views.update({ view_id: viewId, view: draftingView(what, live, tick) }),
    { intervalMs: 1500 },
  );
  let view;
  try {
    const draft = await (pending ??
      alpie.draft({
        templates: template ? [template] : all,
        feedback,
        reporter: authorName,
        onProgress: (p) => Object.assign(live, p),
      })).finally(stopAnimation);
    view = formFor(draft.template, userId, authorName, {
      initial: draft.answers,
      extraContext: draft.additionalContext,
      drafted: true,
      source,
      origin,
      banner: `:sparkles: *Alpie drafted this ${draft.template.name} issue.* Check each field, fill in anything left blank, then create it.`,
    });
  } catch (err) {
    if (!(err instanceof AlpieError)) logger.error(err);
    else logger.warn(`Alpie draft failed: ${err.message}`);
    const warning = `:warning: ${err instanceof AlpieError ? err.message : 'Alpie ran into a problem'}.`;
    view = template
      ? formFor(template, userId, authorName, {
          extraContext: feedback,
          source,
          origin,
          banner: `${warning} Fill in the form below. Your original text is in *Additional context*.`,
        })
      : pickerFor(all, { feedback, warning: `${warning} Pick a template and try again.`, metadata: { origin, source } });
  }
  await client.views.update({ view_id: viewId, view }).catch((err) => logger.warn(`views.update failed: ${err.message}`));
}

async function openIssueModal({ client, logger, triggerId, userId, query, origin }) {
  const [all, authorName] = await Promise.all([templates.all(), displayName(client, userId)]);
  const match = query ? findTemplate(all, query) : null;
  if (match) return client.views.open({ trigger_id: triggerId, view: formFor(match, userId, authorName, { origin }) });
  if (query && alpie) {
    // Free text after the command: treat it as feedback. The trigger expires in 3s, so open a placeholder first.
    const { view } = await client.views.open({ trigger_id: triggerId, view: draftingView('your feedback') });
    return draftIntoView({ client, logger, viewId: view.id, userId, feedback: query, origin, what: 'your feedback' });
  }
  await client.views.open({ trigger_id: triggerId, view: pickerFor(all, { metadata: { origin } }) });
}

/** Reads a message (and its thread, if any) as a transcript for Alpie, plus a permalink to it. */
async function conversationFeedback(client, logger, { channel, ts, threadTs, message }) {
  const root = threadTs ?? (message?.reply_count ? ts : null);
  let messages = message ? [message] : [];
  if (root) {
    // Needs *:history scopes and the bot in the channel; falls back to just the one message.
    const replies = await client.conversations.replies({ channel, ts: root, limit: 100 }).catch((err) => {
      logger.warn(`Couldn't read thread (${err.data?.error ?? err.message}); using the selected message only`);
      return null;
    });
    if (replies?.messages?.length) messages = replies.messages;
  }
  if (!messages.length) {
    const history = await client.conversations.history({ channel, latest: ts, inclusive: true, limit: 1 }).catch(() => null);
    messages = history?.messages ?? [];
  }
  const [feedback, permalink] = await Promise.all([
    threadTranscript(messages, { selectedTs: ts, resolveUser: (id) => displayName(client, id) }),
    client.chat.getPermalink({ channel, message_ts: ts }).then((r) => r.permalink, () => undefined),
  ]);
  return { feedback, permalink };
}

/** Posts a card where the issue was raised; falls back to a DM if Alpieca can't post there. */
async function postCard(client, logger, { origin, userId, card }) {
  if (origin?.channel) {
    try {
      const res = await client.chat.postMessage({ channel: origin.channel, thread_ts: origin.thread, ...card });
      return { where: `<#${res.channel}>` };
    } catch (err) {
      // e.g. a private channel or someone else's DM the bot isn't in.
      logger.warn(`Couldn't post card in ${origin.channel} (${err.data?.error ?? err.message}); sending it as a DM`);
    }
  }
  await client.chat.postMessage({ channel: userId, ...card });
  return { where: 'your DMs with Alpieca' };
}

function helpText(all) {
  const list = all.map((t) => `• *${t.name}*: ${t.about || 'no description'}`).join('\n');
  const cmd = config.slack.command;
  return [
    `*${cmd}* opens a form for one of the issue templates in *${repo}*:`,
    list,
    `Jump straight to one with e.g. \`${cmd} ${all[0]?.name.split(' ')[0].toLowerCase() ?? ''}\`.`,
    alpie &&
      `Or just describe it: \`${cmd} the docs search returns nothing for "quantization"\`, and Alpie drafts the issue for you. ` +
        'You can also @mention Alpieca or DM it with a question or an idea, or use *More actions → Turn into GitHub issue* on any message.',
    `Link your GitHub account with \`${cmd} github <username>\` so issues @mention you and *Assign to me* works.`,
  ]
    .filter(Boolean)
    .join('\n');
}

app.command(config.slack.command, async ({ ack, command, client, respond, logger }) => {
  await ack();
  const query = command.text.trim();
  const ephemeral = (text) => respond({ response_type: 'ephemeral', text });
  try {
    if (query === 'help') return await ephemeral(helpText(await templates.all()));
    const linkMatch = query.match(/^github(?:\s+(\S+))?$/i);
    if (linkMatch) {
      if (!linkMatch[1]) {
        const current = people.githubFor(command.user_id);
        return await ephemeral(
          current ? `You're linked to GitHub as *@${current}*.` : `Link your GitHub account with \`${config.slack.command} github <username>\`.`,
        );
      }
      const { login, error } = await checkGithubLogin(linkMatch[1]);
      if (error) return await ephemeral(`:warning: ${error}`);
      await people.link(command.user_id, login);
      return await ephemeral(`:white_check_mark: Linked you to GitHub as *@${login}*.`);
    }
    await openIssueModal({
      client,
      logger,
      triggerId: command.trigger_id,
      userId: command.user_id,
      query,
      origin: { channel: command.channel_id },
    });
  } catch (err) {
    logger.error(err);
    await ephemeral(`:warning: Couldn't open the issue form: ${err.message}`);
  }
});

app.shortcut('raise_github_issue', async ({ ack, shortcut, client, logger }) => {
  await ack();
  try {
    await openIssueModal({ client, logger, triggerId: shortcut.trigger_id, userId: shortcut.user.id });
  } catch (err) {
    logger.error(err);
    await client.chat.postMessage({ channel: shortcut.user.id, text: `:warning: Couldn't open the issue form: ${err.message}` });
  }
});

// Message shortcut: "Turn into GitHub issue" on any message drafts an issue from its whole thread.
app.shortcut('issue_from_message', async ({ ack, shortcut, client, logger }) => {
  await ack();
  if (!alpie) {
    return client.views.open({
      trigger_id: shortcut.trigger_id,
      view: statusView('Alpie not set up', 'Turning messages into issues needs Alpie. Ask whoever runs the bot to set `ALPIE_API_KEY`.'),
    });
  }
  const { view } = await client.views.open({ trigger_id: shortcut.trigger_id, view: draftingView('this conversation') });
  try {
    const channel = shortcut.channel.id;
    const { message } = shortcut;
    const { feedback, permalink } = await conversationFeedback(client, logger, {
      channel,
      ts: message.ts,
      threadTs: message.thread_ts,
      message,
    });
    await draftIntoView({
      client,
      logger,
      viewId: view.id,
      userId: shortcut.user.id,
      feedback,
      source: permalink,
      origin: { channel, thread: message.thread_ts ?? message.ts },
      what: 'this conversation',
    });
  } catch (err) {
    logger.error(err);
    await client.views.update({ view_id: view.id, view: statusView('Something went wrong', `:x: ${err.message}`) }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Conversations: "@Alpieca …" in channels and threads, and direct messages.

// Alpie takes ~12-15s to draft, almost all of it reasoning. When a message looks like an issue,
// start drafting straight away so the wait mostly happens before anyone clicks.
const prefetched = new Map(); // "channel:ts" -> { prep, draft, progress, userId }
const PREFETCH_TTL_MS = 15 * 60_000;

function prefetchDraft(client, logger, { channel, ts, threadTs, userId }) {
  const key = `${channel}:${ts}`;
  const progress = createProgress();
  const prep = conversationFeedback(client, logger, { channel, ts, threadTs });
  const draft = Promise.all([prep, templates.all(), displayName(client, userId)]).then(([{ feedback }, all, reporter]) =>
    alpie.draft({ templates: all, feedback, reporter, onProgress: (p) => Object.assign(progress, p) }),
  );
  // Failures are reported when someone clicks; don't let an unclicked one crash the process.
  prep.catch(() => {});
  draft.catch(() => {});
  prefetched.set(key, { prep, draft, progress, userId });
  setTimeout(() => prefetched.delete(key), PREFETCH_TTL_MS).unref();
}

/** Where to post the eventual issue card: the thread for channels, the DM itself for DMs. */
const originFor = ({ channel, ts, thread, dm }) => (dm ? { channel, thread: thread ?? undefined } : { channel, thread: thread ?? ts });

const draftButtons = (value, { prefetching }) => ({
  type: 'actions',
  block_id: 'issue_offer',
  elements: [
    ...(alpie
      ? [
          {
            type: 'button',
            action_id: 'mention_draft',
            style: 'primary',
            text: { type: 'plain_text', text: prefetching ? "✨ Review Alpie's draft" : '✨ Draft with Alpie' },
            value,
          },
        ]
      : []),
    { type: 'button', action_id: 'mention_pick', text: { type: 'plain_text', text: 'Pick a template' }, value },
  ],
});

/**
 * Handles a mention or DM: issue-like messages get a (private) offer to draft, with drafting already
 * under way; anything else is answered by Alpie, with a button to turn it into an issue after all.
 */
async function handleConversation({ client, logger, event, text, isDm }) {
  const { channel, ts } = event;
  const thread = event.thread_ts ?? null;
  const value = JSON.stringify({ channel, ts, thread, dm: isDm });
  // In channels, offers are ephemeral so only the asker sees them; answers go in the thread for everyone.
  const privately = (payload) =>
    (isDm
      ? client.chat.postMessage({ channel, thread_ts: thread ?? undefined, ...payload })
      : client.chat.postEphemeral({ channel, user: event.user, thread_ts: thread ?? undefined, ...payload })
    ).catch((err) => logger.warn(`Couldn't reply: ${err.data?.error ?? err.message}`));
  const publicly = (payload) => client.chat.postMessage({ channel, thread_ts: isDm ? (thread ?? undefined) : (thread ?? ts), ...payload });

  // A bare "@Alpieca" in a thread means "turn this thread into an issue"; elsewhere it's a hello.
  const wantsIssue = looksLikeIssue(text) || (!text && thread && !isDm);
  if (/^(help|hi|hello|hey)?$/i.test(text) && !wantsIssue) {
    return privately({ text: `:llama: Hi! Ask me about *${repo}* issues, or tell me about a bug or idea and I'll help you raise it.\n\n${helpText(await templates.all())}` });
  }

  if (wantsIssue) {
    if (alpie) prefetchDraft(client, logger, { channel, ts, threadTs: thread, userId: event.user });
    const where = thread && !isDm ? 'this thread' : 'this';
    return privately({
      text: 'Want me to turn this into a GitHub issue?',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: alpie
              ? `:llama: Sounds like something for *${repo}*. Alpie is already drafting an issue from ${where}; review it when you're ready, and I'll post the issue back here.`
              : `:llama: Want to raise a *${repo}* issue from ${where}? I'll post it back here.`,
          },
        },
        draftButtons(value, { prefetching: Boolean(alpie) }),
      ],
    });
  }

  if (!alpie) {
    return privately({
      text: `I can't answer questions without Alpie, but I can help you raise a *${repo}* issue.`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `:llama: I can't answer questions without Alpie, but I can help you raise a *${repo}* issue.` } },
        draftButtons(value, { prefetching: false }),
      ],
    });
  }

  // Questions: post a placeholder right away, then swap in Alpie's answer.
  const progress = createProgress();
  const frame = (tick) => {
    const partial = progress.phase === 'writing' && progress.output.trim();
    const text = partial ? `${markdownToMrkdwn(partial).slice(0, 2900)} ▍` : statusLine(progress, tick, 'answer');
    return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
  };
  const placeholder = await publicly({ ...frame(0), unfurl_links: false });
  const stopAnimation = startTicker((tick) => client.chat.update({ channel: placeholder.channel, ts: placeholder.ts, ...frame(tick) }));
  let answer;
  try {
    const [{ feedback: conversation }, all, issues] = await Promise.all([
      conversationFeedback(client, logger, { channel, ts, threadTs: thread }),
      templates.all(),
      github.recentIssues().catch(() => []),
    ]);
    progress.phase = 'thinking';
    const reply = await alpie.answer({ repo, conversation, templates: all, issues, onProgress: (p) => Object.assign(progress, p) });
    answer = markdownToMrkdwn(reply).slice(0, 2900);
  } catch (err) {
    logger.warn(`Alpie answer failed: ${err.message}`);
    answer = `:warning: Sorry, I couldn't answer that right now (${err instanceof AlpieError ? err.message : 'something went wrong'}).`;
  }
  // Stop the animation (and wait for any frame in flight) before showing the final answer.
  await stopAnimation();
  await client.chat
    .update({
      channel: placeholder.channel,
      ts: placeholder.ts,
      text: answer,
      unfurl_links: false,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: answer } },
        {
          type: 'actions',
          block_id: 'answer_actions',
          elements: [{ type: 'button', action_id: 'mention_draft', text: { type: 'plain_text', text: '📝 Draft an issue from this' }, value }],
        },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Answered by Alpie :sparkles: · it can make mistakes, so check anything important.' }] },
      ],
    })
    .catch((err) => logger.warn(`Couldn't post answer: ${err.data?.error ?? err.message}`));
}

app.event('app_mention', async ({ event, client, logger, context }) => {
  if (event.bot_id) return;
  const text = event.text.replaceAll(`<@${context.botUserId}>`, '').trim();
  await handleConversation({ client, logger, event, text, isDm: false });
});

app.message(async ({ message, client, logger, context }) => {
  // Only plain messages people send to Alpieca directly; mentions in channels arrive as app_mention.
  if (message.channel_type !== 'im' || message.subtype || message.bot_id) return;
  const text = (message.text ?? '').replaceAll(`<@${context.botUserId}>`, '').trim();
  await handleConversation({ client, logger, event: message, text, isDm: true });
});

app.action('mention_draft', async ({ ack, body, action, client, respond, logger }) => {
  await ack();
  const ref = JSON.parse(action.value);
  const { channel, ts, thread } = ref;
  const entry = prefetched.get(`${channel}:${ts}`);
  const reuse = entry?.userId === body.user.id;
  const { view } = await client.views.open({
    trigger_id: body.trigger_id,
    view: draftingView('this conversation', reuse ? entry.progress : undefined),
  });
  // Remove the offer once used; keep answers, which other people in the thread may still read.
  if (action.block_id === 'issue_offer') respond({ delete_original: true }).catch(() => {});
  try {
    const { feedback, permalink } = await (entry?.prep ?? conversationFeedback(client, logger, { channel, ts, threadTs: thread }));
    await draftIntoView({
      client,
      logger,
      viewId: view.id,
      userId: body.user.id,
      feedback,
      source: permalink,
      origin: originFor(ref),
      // Reuse the background draft only for the person it was started for (it's written as them).
      pending: reuse ? entry.draft : undefined,
      progress: reuse ? entry.progress : undefined,
      what: 'this conversation',
    });
  } catch (err) {
    logger.error(err);
    await client.views.update({ view_id: view.id, view: statusView('Something went wrong', `:x: ${err.message}`) }).catch(() => {});
  }
});

app.action('mention_pick', async ({ ack, body, action, client, respond }) => {
  await ack();
  const ref = JSON.parse(action.value);
  const all = await templates.all();
  await client.views.open({ trigger_id: body.trigger_id, view: pickerFor(all, { metadata: { origin: originFor(ref) } }) });
  if (action.block_id === 'issue_offer') respond({ delete_original: true }).catch(() => {});
});

app.view(CALLBACK.pick, async ({ ack, body, view, client, logger }) => {
  const { origin, source } = JSON.parse(view.private_metadata || '{}');
  const { template: templateId, feedback = '' } = readAnswers(view);
  const template = templateId ? await templates.get(templateId) : null;
  if (templateId && !template) {
    return ack({ response_action: 'errors', errors: { template: 'That template no longer exists. Pick another one.' } });
  }
  if (!template && !feedback.trim()) {
    return ack({ response_action: 'errors', errors: { template: 'Pick a template, or describe the issue below.' } });
  }
  if (!feedback.trim() || !alpie) {
    const authorName = await displayName(client, body.user.id);
    return ack({ response_action: 'update', view: formFor(template, body.user.id, authorName, { origin, source }) });
  }
  await ack({ response_action: 'update', view: draftingView('your feedback') });
  await draftIntoView({
    client,
    logger,
    viewId: view.id,
    userId: body.user.id,
    feedback: feedback.trim(),
    template,
    origin,
    source,
    what: 'your feedback',
  });
});

app.view(CALLBACK.form, async ({ ack, body, view, client, logger }) => {
  const { templateId, version, drafted, source, origin } = JSON.parse(view.private_metadata || '{}');
  const template = await templates.get(templateId, version);
  const answers = readAnswers(view);
  const userId = body.user.id;
  const errors = template
    ? validateAnswers(template, answers)
    : { title: 'This issue template was removed from GitHub. Close the form and start again.' };

  // Only hit GitHub to check the username when it differs from the one we already know.
  const typed = normalizeLogin(answers[GITHUB_LOGIN_BLOCK]);
  let githubLogin = people.githubFor(userId);
  if (typed.toLowerCase() !== githubLogin?.toLowerCase()) {
    const checked = await checkGithubLogin(typed);
    if (checked.error) errors[GITHUB_LOGIN_BLOCK] = checked.error;
    githubLogin = checked.login;
  }
  if (Object.keys(errors).length) return ack({ response_action: 'errors', errors });

  // Ack within Slack's 3s window, then talk to GitHub and update the same modal.
  await ack({ response_action: 'update', view: statusView('Filing issue…', ':hourglass_flowing_sand: Creating your issue on GitHub…') });

  const reporter = (await displayName(client, userId)) ?? body.user.name;
  const issue = renderIssue(template, answers, { reporter, githubLogin, drafted, source });
  const update = (title, markdown) =>
    client.views.update({ view_id: view.id, view: statusView(title, markdown) }).catch((err) => logger.warn(err));

  let created;
  try {
    created = await github.createIssue(issue);
  } catch (err) {
    const reason = err.response?.data?.message ?? err.message;
    logger.error(`Couldn't create issue "${issue.title}": ${reason}`);
    await Promise.all([
      update('Issue not created', `:x: GitHub rejected the issue: ${reason}\nYour answers were sent to you in a DM so you don't lose them.`),
      // Hand the drafted issue back so nothing typed in the modal is lost.
      client.chat
        .postMessage({ channel: userId, text: `:x: Couldn't create your issue (${reason}). Here's what you wrote:\n*${issue.title}*\n\`\`\`${issue.body}\`\`\`` })
        .catch((e) => logger.warn(e)),
    ]);
    return;
  }

  await people.link(userId, githubLogin).catch((err) => logger.warn(`Couldn't save GitHub username: ${err.message}`));
  const link = `<${created.url}|#${created.number} ${escapeSlack(issue.title)}>`;
  const note = created.missingLabels.length
    ? `:warning: GitHub didn't apply ${created.missingLabels.map((l) => `\`${l}\``).join(', ')}. A triager can add them with *Label*.`
    : undefined;
  const headline = `:memo: <@${userId}> raised a *${escapeSlack(template.name)}* issue${drafted ? ' · drafted with Alpie :sparkles:' : ''}`;
  const card = issueCard(created.issue, { repo, headline, note });

  try {
    const posted = await postCard(client, logger, { origin, userId, card });
    await update('Issue created', `:white_check_mark: Filed ${link} in *${repo}* and posted it in ${posted.where}.`);
  } catch (err) {
    logger.warn(`Couldn't post issue card: ${err.message}`);
    await update('Issue created', `:white_check_mark: Filed ${link} in *${repo}*.`);
  }
  if (config.slack.notifyChannel && config.slack.notifyChannel !== origin?.channel) {
    await client.chat.postMessage({ channel: config.slack.notifyChannel, ...card }).catch((err) => logger.warn(err));
  }
});

// ---------------------------------------------------------------------------
// Triage buttons on issue cards (posted by Alpieca itself or by the GitHub Action).

/** Where the clicked card lives, plus its headline so a refresh keeps it. */
function cardRef(body) {
  const first = body.message?.blocks?.[0];
  return {
    channel: body.channel?.id ?? body.container?.channel_id,
    ts: body.message?.ts ?? body.container?.message_ts,
    headline: first?.type === 'context' ? first.elements?.[0]?.text : undefined,
  };
}

/** Re-renders a card from GitHub's current state, with a note about what just happened. */
async function refreshCard(client, logger, { number, channel, ts, headline }, note) {
  if (!channel || !ts) return;
  const issue = await github.getIssue(number);
  await client.chat
    .update({ channel, ts, ...issueCard(issue, { repo, headline, note }) })
    .catch((err) => logger.warn(`Couldn't refresh card: ${err.data?.error ?? err.message}`));
}

/** Wraps a triage button handler with the triager check and error reporting to the clicker. */
function triage(handler) {
  return async (args) => {
    const { ack, body, respond, logger } = args;
    await ack();
    const ephemeral = (text) => respond({ response_type: 'ephemeral', replace_original: false, text }).catch(() => {});
    if (config.slack.triageUsers.length && !config.slack.triageUsers.includes(body.user.id)) {
      return ephemeral(':lock: Only issue triagers can do that. Use *View on GitHub* to follow along.');
    }
    try {
      await handler({ ...args, ephemeral, number: Number(args.action.value), ref: cardRef(body) });
    } catch (err) {
      logger.error(err);
      await ephemeral(`:x: ${err.response?.data?.message ?? err.message}`);
    }
  };
}

// The link button opens GitHub in the browser, but Slack still sends an action that must be acked.
app.action('issue_view', async ({ ack }) => ack());

async function assignAndRefresh({ client, logger, userId, login, number, ref, ephemeral }) {
  if (!(await github.assign(number, login))) {
    return ephemeral(`:warning: GitHub didn't assign *@${login}*. Only people with access to *${repo}* can be assigned.`);
  }
  await refreshCard(client, logger, { number, ...ref }, `:raising_hand: Assigned to <https://github.com/${login}|@${login}> by <@${userId}>`);
}

app.action(
  ACTION.assign,
  triage(async ({ body, client, logger, number, ref, ephemeral }) => {
    const login = people.githubFor(body.user.id);
    if (!login) {
      return client.views.open({
        trigger_id: body.trigger_id,
        view: githubLoginView({ then: 'assign', number, ...ref }, { reason: `To assign #${number} to you, Alpieca needs your GitHub username.` }),
      });
    }
    await assignAndRefresh({ client, logger, userId: body.user.id, login, number, ref, ephemeral });
  }),
);

app.action(
  ACTION.comment,
  triage(async ({ body, client, number, ref }) => {
    const issue = await github.getIssue(number);
    await client.views.open({ trigger_id: body.trigger_id, view: commentView(issue, { number, ...ref }) });
  }),
);

app.action(
  ACTION.label,
  triage(async ({ body, client, number, ref }) => {
    const [issue, labels] = await Promise.all([github.getIssue(number), repoLabels()]);
    await client.views.open({ trigger_id: body.trigger_id, view: labelView(issue, labels, { number, ...ref }) });
  }),
);

app.action(
  ACTION.close,
  triage(async ({ body, client, logger, number, ref }) => {
    await github.setState(number, 'closed');
    await refreshCard(client, logger, { number, ...ref }, `:white_check_mark: Closed by <@${body.user.id}>`);
  }),
);

app.action(
  ACTION.reopen,
  triage(async ({ body, client, logger, number, ref }) => {
    await github.setState(number, 'open');
    await refreshCard(client, logger, { number, ...ref }, `:leftwards_arrow_with_hook: Reopened by <@${body.user.id}>`);
  }),
);

app.view(CALLBACK.comment, async ({ ack, body, view, client, logger }) => {
  const meta = JSON.parse(view.private_metadata);
  const text = String(readAnswers(view).comment ?? '').trim();
  if (!text) return ack({ response_action: 'errors', errors: { comment: 'Write a comment first.' } });
  await ack();
  const userId = body.user.id;
  const name = ((await displayName(client, userId)) ?? body.user.name).replace(/[<>@]/g, '');
  const login = people.githubFor(userId);
  try {
    const comment = await github.comment(meta.number, `${text}\n\n<sub>— ${name}${login ? ` (@${login})` : ''} via Slack</sub>`);
    if (meta.channel && meta.ts) {
      const excerpt = escapeSlack(text.length > 300 ? `${text.slice(0, 300)}…` : text).replace(/^/gm, '>');
      await client.chat.postMessage({
        channel: meta.channel,
        thread_ts: meta.ts,
        text: `:speech_balloon: <@${userId}> <${comment.html_url}|commented on GitHub>:\n${excerpt}`,
        unfurl_links: false,
      });
    }
    await refreshCard(client, logger, meta, `:speech_balloon: <@${userId}> commented`);
  } catch (err) {
    logger.error(err);
    await client.chat.postMessage({ channel: userId, text: `:x: Couldn't post your comment on #${meta.number}: ${err.message}\n>${text}` });
  }
});

app.view(CALLBACK.label, async ({ ack, body, view, client, logger }) => {
  const meta = JSON.parse(view.private_metadata);
  const labels = readAnswers(view).labels || [];
  await ack();
  try {
    await github.setLabels(meta.number, labels);
    await refreshCard(client, logger, meta, `:label: Labels updated by <@${body.user.id}>`);
  } catch (err) {
    logger.error(err);
    await client.chat.postMessage({ channel: body.user.id, text: `:x: Couldn't update labels on #${meta.number}: ${err.message}` });
  }
});

app.view(CALLBACK.githubLogin, async ({ ack, body, view, client, logger }) => {
  const meta = JSON.parse(view.private_metadata);
  const { login, error } = await checkGithubLogin(readAnswers(view)[GITHUB_LOGIN_BLOCK]);
  if (error) return ack({ response_action: 'errors', errors: { [GITHUB_LOGIN_BLOCK]: error } });
  await ack();
  const userId = body.user.id;
  await people.link(userId, login);
  if (meta.then === 'assign') {
    const { then, number, ...ref } = meta;
    const ephemeral = (text) => client.chat.postMessage({ channel: userId, text }).catch(() => {});
    await assignAndRefresh({ client, logger, userId, login, number, ref, ephemeral }).catch((err) => ephemeral(`:x: ${err.message}`));
  }
});

app.error(async (err) => {
  console.error(err);
});

await templates.refresh();
publicRepo = await github.isPublic().catch(() => true);
await app.start();
console.log(
  `Alpieca running (${config.slack.socketMode ? 'Socket Mode' : `HTTP on :${config.slack.port}`}), filing into ${repo}` +
    (alpie ? `, drafting with ${config.alpie.model}` : ', Alpie drafting off (no ALPIE_API_KEY)'),
);
