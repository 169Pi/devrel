import { App } from '@slack/bolt';
import { AlpieError, createAlpie } from './alpie.js';
import { loadConfig } from './config.js';
import { createGitHub } from './github.js';
import { CALLBACK, formView, pickerView, readAnswers, statusView } from './modal.js';
import { threadTranscript } from './slack-text.js';
import {
  createTemplateStore,
  findTemplate,
  loadLocalTemplates,
  renderIssue,
  validateAnswers,
} from './templates.js';

const config = loadConfig();
const github = createGitHub(config.github);
const alpie = config.alpie ? createAlpie(config.alpie) : null;
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

const draftingView = (what) =>
  statusView('Alpie is drafting…', `:sparkles: Alpie is turning ${what} into an issue draft. This usually takes 10–30 seconds.`);

/**
 * Has Alpie draft the issue, then swaps the open modal (viewId) for a pre-filled
 * form the reporter reviews. Falls back to a manual form or the picker, keeping
 * the original feedback, if Alpie fails or no template fits.
 */
async function draftIntoView({ client, logger, viewId, userId, feedback, template, source }) {
  const [all, authorName] = await Promise.all([templates.all(), displayName(client, userId)]);
  let view;
  try {
    const draft = await alpie.draft({ templates: template ? [template] : all, feedback, reporter: authorName });
    view = formView(draft.template, {
      authorName,
      initial: draft.answers,
      extraContext: draft.additionalContext,
      drafted: true,
      source,
      publicRepo,
      banner: `:sparkles: *Alpie drafted this ${draft.template.name} issue.* Check each field, fill in anything left blank, then create it.`,
    });
  } catch (err) {
    if (!(err instanceof AlpieError)) logger.error(err);
    else logger.warn(`Alpie draft failed: ${err.message}`);
    const warning = `:warning: ${err instanceof AlpieError ? err.message : 'Alpie ran into a problem'}.`;
    view = template
      ? formView(template, { authorName, extraContext: feedback, source, publicRepo, banner: `${warning} Fill in the form below. Your original text is in *Additional context*.` })
      : pickerView(all, { repo: config.github.repo, alpie: true, feedback, warning: `${warning} Pick a template and try again.` });
  }
  await client.views.update({ view_id: viewId, view }).catch((err) => logger.warn(`views.update failed: ${err.message}`));
}

async function openIssueModal({ client, logger, triggerId, userId, query }) {
  const [all, authorName] = await Promise.all([templates.all(), displayName(client, userId)]);
  const match = query ? findTemplate(all, query) : null;
  if (match) return client.views.open({ trigger_id: triggerId, view: formView(match, { authorName }) });
  if (query && alpie) {
    // Free text after the command: treat it as feedback. The trigger expires in 3s, so open a placeholder first.
    const { view } = await client.views.open({ trigger_id: triggerId, view: draftingView('your feedback') });
    return draftIntoView({ client, logger, viewId: view.id, userId, feedback: query });
  }
  await client.views.open({ trigger_id: triggerId, view: pickerView(all, { repo: config.github.repo, alpie: Boolean(alpie) }) });
}

function helpText(all) {
  const list = all.map((t) => `• *${t.name}*: ${t.about || 'no description'}`).join('\n');
  return [
    `*${config.slack.command}* opens a form for one of the issue templates in *${config.github.repo}*:`,
    list,
    `Jump straight to one with e.g. \`${config.slack.command} ${all[0]?.name.split(' ')[0].toLowerCase() ?? ''}\`.`,
    alpie &&
      `Or just describe it: \`${config.slack.command} the docs search returns nothing for "quantization"\`, and Alpie drafts the issue for you. ` +
        'You can also use *More actions → Turn into GitHub issue* on any message to have Alpie draft one from that thread.',
  ]
    .filter(Boolean)
    .join('\n');
}

app.command(config.slack.command, async ({ ack, command, client, respond, logger }) => {
  await ack();
  const query = command.text.trim();
  try {
    if (query === 'help') return await respond({ response_type: 'ephemeral', text: helpText(await templates.all()) });
    await openIssueModal({ client, logger, triggerId: command.trigger_id, userId: command.user_id, query });
  } catch (err) {
    logger.error(err);
    await respond({ response_type: 'ephemeral', text: `:warning: Couldn't open the issue form: ${err.message}` });
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
    const message = shortcut.message;
    const root = message.thread_ts ?? (message.reply_count ? message.ts : null);
    let messages = [message];
    if (root) {
      // Needs *:history scopes and the bot in the channel; falls back to just the selected message.
      const replies = await client.conversations.replies({ channel, ts: root, limit: 100 }).catch((err) => {
        logger.warn(`Couldn't read thread (${err.data?.error ?? err.message}); using the selected message only`);
        return null;
      });
      if (replies?.messages?.length) messages = replies.messages;
    }
    const [feedback, permalink] = await Promise.all([
      threadTranscript(messages, { selectedTs: message.ts, resolveUser: (id) => displayName(client, id) }),
      client.chat.getPermalink({ channel, message_ts: message.ts }).then((r) => r.permalink, () => undefined),
    ]);
    await draftIntoView({ client, logger, viewId: view.id, userId: shortcut.user.id, feedback, source: permalink });
  } catch (err) {
    logger.error(err);
    await client.views.update({ view_id: view.id, view: statusView('Something went wrong', `:x: ${err.message}`) }).catch(() => {});
  }
});

app.view(CALLBACK.pick, async ({ ack, body, view, client, logger }) => {
  const { template: templateId, feedback = '' } = readAnswers(view);
  const template = templateId ? await templates.get(templateId) : null;
  if (templateId && !template) {
    return ack({ response_action: 'errors', errors: { template: 'That template no longer exists. Pick another one.' } });
  }
  if (!template && !feedback.trim()) {
    return ack({ response_action: 'errors', errors: { template: 'Pick a template, or describe the issue below.' } });
  }
  if (!feedback.trim() || !alpie) {
    return ack({ response_action: 'update', view: formView(template, { authorName: await displayName(client, body.user.id) }) });
  }
  await ack({ response_action: 'update', view: draftingView('your feedback') });
  await draftIntoView({ client, logger, viewId: view.id, userId: body.user.id, feedback: feedback.trim(), template });
});

app.view(CALLBACK.form, async ({ ack, body, view, client, logger }) => {
  const { templateId, version, drafted, source } = JSON.parse(view.private_metadata || '{}');
  const template = await templates.get(templateId, version);
  const answers = readAnswers(view);
  const errors = template
    ? validateAnswers(template, answers)
    : { title: 'This issue template was removed from GitHub. Close the form and start again.' };
  if (Object.keys(errors).length) return ack({ response_action: 'errors', errors });

  // Ack within Slack's 3s window, then talk to GitHub and update the same modal.
  await ack({ response_action: 'update', view: statusView('Filing issue…', ':hourglass_flowing_sand: Creating your issue on GitHub…') });

  const userId = body.user.id;
  const reporter = (await displayName(client, userId)) ?? body.user.name;
  const issue = renderIssue(template, answers, { reporter, drafted, source });
  const update = (title, markdown) =>
    client.views.update({ view_id: view.id, view: statusView(title, markdown) }).catch((err) => logger.warn(err));
  const dm = (text) => client.chat.postMessage({ channel: userId, text }).catch((err) => logger.warn(err));

  try {
    const created = await github.createIssue(issue);
    const link = `<${created.url}|#${created.number} ${issue.title}>`;
    const warning = created.missingLabels.length
      ? `\n:warning: GitHub didn't apply these labels: ${created.missingLabels.map((l) => `\`${l}\``).join(', ')}. Ask a maintainer to add them.`
      : '';
    await Promise.all([
      update('Issue created', `:white_check_mark: Filed ${link} in *${config.github.repo}*.${warning}`),
      dm(`:white_check_mark: Your issue ${link} is live in *${config.github.repo}*.${warning}`),
      config.slack.notifyChannel &&
        client.chat
          .postMessage({ channel: config.slack.notifyChannel, text: `:memo: <@${userId}> raised ${link} (${template.name})` })
          .catch((err) => logger.warn(err)),
    ]);
  } catch (err) {
    const reason = err.response?.data?.message ?? err.message;
    logger.error(`Couldn't create issue "${issue.title}": ${reason}`);
    await Promise.all([
      update('Issue not created', `:x: GitHub rejected the issue: ${reason}\nYour answers were sent to you in a DM so you don't lose them.`),
      // Hand the drafted issue back so nothing typed in the modal is lost.
      dm(`:x: Couldn't create your issue (${reason}). Here's what you wrote:\n*${issue.title}*\n\`\`\`${issue.body}\`\`\``),
    ]);
  }
});

app.error(async (err) => {
  console.error(err);
});

await templates.refresh();
publicRepo = await github.isPublic().catch(() => true);
await app.start();
console.log(
  `Alpieca running (${config.slack.socketMode ? 'Socket Mode' : `HTTP on :${config.slack.port}`}), filing into ${config.github.repo}` +
    (alpie ? `, drafting with ${config.alpie.model}` : ', Alpie drafting off (no ALPIE_API_KEY)'),
);
