import { formatBytes } from './media.js';

export const CALLBACK = {
  pick: 'issue_template_pick',
  form: 'issue_template_form',
  comment: 'issue_comment_submit',
  label: 'issue_label_submit',
  githubLogin: 'github_login_submit',
};

// Slack Block Kit limits
const MODAL_TITLE_MAX = 24;
const OPTION_TEXT_MAX = 75;
const HINT_MAX = 2000;
const TEXTAREA_MAX = 3000;
const AUTHOR_FIELD = /\b(mastermind|author|owner|submitted by|your name|reporter)/i;
export const EXTRA_CONTEXT = 'extra_context';
export const GITHUB_LOGIN_BLOCK = 'github_login';
export const ATTACHMENTS_BLOCK = 'attachments';
const MAX_CHECKBOXES = 10;

const text = (value) => ({ type: 'plain_text', text: value, emoji: true });
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function input(blockId, label, element, { optional = false, hint } = {}) {
  return {
    type: 'input',
    block_id: blockId,
    optional,
    label: text(truncate(label, 2000)),
    element: { action_id: 'value', ...element },
    ...(hint ? { hint: text(truncate(hint, HINT_MAX)) } : {}),
  };
}

const notice = (markdown) => ({ type: 'context', elements: [{ type: 'mrkdwn', text: markdown }] });

/** A dropdown of a field's options, with `selected` picked if it's one of them. */
function selectFor(options, selected) {
  const choices = options.map((o) => ({ text: text(truncate(o, OPTION_TEXT_MAX)), value: o.slice(0, 150) }));
  const initial = choices.find((c) => c.value.toLowerCase() === String(selected ?? '').trim().toLowerCase());
  return { type: 'static_select', placeholder: text('Choose one'), options: choices, ...(initial ? { initial_option: initial } : {}) };
}

const repoLink = (repo) => `*<https://github.com/${repo}|${repo}>*`;

/** @param repos the owner/repo names templates come from */
export function pickerView(templates, { repos, alpie = false, feedback = '', warning, metadata = {} }) {
  const several = repos.length > 1;
  const options = templates.map((t) => {
    // With several repos, say where each template files to.
    const about = [t.about, several && t.repo].filter(Boolean).join(' · ');
    return {
      text: text(truncate(t.name, OPTION_TEXT_MAX)),
      value: t.id,
      ...(about && templates.length <= 10 ? { description: text(truncate(about, OPTION_TEXT_MAX)) } : {}),
    };
  });
  return {
    type: 'modal',
    callback_id: CALLBACK.pick,
    private_metadata: JSON.stringify(metadata),
    title: text('Raise a GitHub issue'),
    submit: text('Next'),
    close: text('Cancel'),
    blocks: [
      ...(warning ? [notice(warning)] : []),
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: several
            ? `Issues are filed in ${repos.map(repoLink).join(' or ')}, depending on the template.`
            : `Issues are filed in ${repoLink(repos[0])} using its issue templates.`,
        },
      },
      input(
        'template',
        'What are you raising?',
        // Radio buttons read better but Slack caps them at 10 options.
        templates.length <= 10 ? { type: 'radio_buttons', options } : { type: 'static_select', options },
        { optional: alpie, hint: alpie ? 'Leave this empty and Alpie will choose a template for you.' : undefined },
      ),
      ...(alpie
        ? [
            input(
              'feedback',
              '…or describe it in your own words',
              {
                type: 'plain_text_input',
                multiline: true,
                max_length: TEXTAREA_MAX,
                ...(feedback ? { initial_value: feedback.slice(0, TEXTAREA_MAX) } : {}),
              },
              { optional: true, hint: 'Alpie drafts the template from this. You review everything before the issue is filed.' },
            ),
          ]
        : []),
    ],
  };
}

/**
 * @param initial      answers keyed by block id (e.g. drafted by Alpie)
 * @param extraContext text for the trailing "Additional context" box; the box is
 *                     shown whenever this is a string (even an empty one)
 * @param drafted      whether Alpie drafted the answers (shown in the issue footer)
 * @param source       Slack permalink the issue was raised from
 * @param githubLogin  the reporter's remembered GitHub username, if known
 * @param origin       { channel, thread } to post the confirmation card in
 * @param linkFiles    whether issues in this repo link the conversation's files
 * @param attachments  files from the Slack thread: [{ id, name, size }], all ticked to start with
 * @param mention      who the issue notifies on GitHub, e.g. "@169Pi/engineering"
 */
export function formView(
  template,
  {
    authorName,
    initial = {},
    extraContext,
    drafted = false,
    source,
    banner,
    publicRepo,
    githubLogin,
    origin,
    linkFiles = false,
    attachments = [],
    mention,
  } = {},
) {
  const blocks = [];
  if (banner) blocks.push(notice(banner));
  if (publicRepo && (drafted || source)) {
    blocks.push(notice(':eyes: This repo is *public*. Check the draft for anything internal before creating the issue. Your name and GitHub username will appear on it.'));
  }
  const meta = [
    template.about,
    template.repo && `Filed in ${repoLink(template.repo)}${mention ? ` · notifies \`${mention}\`` : ''}`,
    template.labels.length && `Labels: ${template.labels.map((l) => `\`${l}\``).join(' ')}`,
  ]
    .filter(Boolean)
    .join('\n');
  if (meta) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: meta }] });

  blocks.push(
    input(
      'title',
      'Title',
      {
        type: 'plain_text_input',
        max_length: 256 - template.titlePrefix.length,
        placeholder: text('Short summary'),
        ...(initial.title ? { initial_value: initial.title } : {}),
      },
      { hint: template.titlePrefix.trim() ? `Filed as “${template.titlePrefix}…”` : undefined },
    ),
  );

  for (const section of template.sections) {
    if (section.choices) {
      const options = section.choices.slice(0, MAX_CHECKBOXES).map((c) => ({ text: text(truncate(c, OPTION_TEXT_MAX)), value: c.slice(0, 150) }));
      const picked = new Set(Array.isArray(initial[section.id]) ? initial[section.id] : []);
      const initialOptions = options.filter((o) => picked.has(o.value));
      blocks.push(
        input(section.id, section.title, { type: 'checkboxes', options, ...(initialOptions.length ? { initial_options: initialOptions } : {}) }, {
          optional: section.optional,
          hint: section.guidance,
        }),
      );
      continue;
    }
    if (!section.fields.length) {
      blocks.push(
        input(
          section.id,
          section.title,
          {
            type: 'plain_text_input',
            multiline: true,
            max_length: TEXTAREA_MAX,
            ...(initial[section.id] ? { initial_value: initial[section.id] } : {}),
          },
          { optional: section.optional, hint: section.guidance },
        ),
      );
      continue;
    }
    blocks.push({ type: 'divider' }, { type: 'header', text: text(truncate(section.title, 150)) });
    if (section.guidance) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: section.guidance }] });
    }
    for (const field of section.fields) {
      if (field.options) {
        blocks.push(input(field.id, field.label, selectFor(field.options, initial[field.id]), { optional: field.optional }));
        continue;
      }
      const element = { type: 'plain_text_input' };
      if (field.url) element.placeholder = text('https://…');
      const value = initial[field.id] || (AUTHOR_FIELD.test(field.label) ? authorName : '');
      if (value) element.initial_value = value;
      blocks.push(input(field.id, field.label, element, { optional: field.optional }));
    }
  }

  if (typeof extraContext === 'string') {
    blocks.push(
      { type: 'divider' },
      input(
        EXTRA_CONTEXT,
        drafted ? '🤖 Additional context (added by Alpie)' : 'Additional context',
        {
          type: 'plain_text_input',
          multiline: true,
          max_length: TEXTAREA_MAX,
          ...(extraContext ? { initial_value: extraContext.slice(0, TEXTAREA_MAX) } : {}),
        },
        { optional: true, hint: 'Added to the end of the issue. Edit or clear it as you like.' },
      ),
    );
  }

  if (linkFiles && attachments.length) {
    const options = attachments.slice(0, MAX_CHECKBOXES).map((f) => ({
      text: text(truncate(`${f.name}${f.size ? ` (${formatBytes(f.size)})` : ''}`, OPTION_TEXT_MAX)),
      value: f.id,
    }));
    blocks.push(
      { type: 'divider' },
      input(ATTACHMENTS_BLOCK, '📎 Files from the conversation', { type: 'checkboxes', options, initial_options: options }, {
        optional: true,
        hint: 'Ticked files are linked in the issue. They stay in Slack, so only people in this workspace can open them.',
      }),
    );
  } else if (attachments.length) {
    blocks.push(notice(`:paperclip: Files from the conversation aren't added to *${template.repo ?? 'this repo'}* issues. Describe what they show.`));
  }

  blocks.push(
    { type: 'divider' },
    input(
      GITHUB_LOGIN_BLOCK,
      'Your GitHub username',
      {
        type: 'plain_text_input',
        max_length: 60,
        placeholder: text('octocat'),
        ...(githubLogin ? { initial_value: githubLogin } : {}),
      },
      { hint: "You're @mentioned on the issue so you get GitHub notifications. Alpieca remembers it for next time." },
    ),
  );

  return {
    type: 'modal',
    callback_id: CALLBACK.form,
    private_metadata: JSON.stringify({
      templateId: template.id,
      version: template.version,
      ...(drafted ? { drafted } : {}),
      ...(source ? { source } : {}),
      ...(origin ? { origin } : {}),
    }),
    title: text(truncate(template.name, MODAL_TITLE_MAX)),
    submit: text('Create issue'),
    close: text('Cancel'),
    blocks,
  };
}

/** Comment on an issue from Slack. `meta` carries { number, channel, ts } of the card to refresh. */
export function commentView(issue, meta) {
  return {
    type: 'modal',
    callback_id: CALLBACK.comment,
    private_metadata: JSON.stringify(meta),
    title: text(truncate(`Comment on #${issue.number}`, MODAL_TITLE_MAX)),
    submit: text('Post comment'),
    close: text('Cancel'),
    blocks: [
      notice(`*${truncate(issue.title, 200)}*`),
      input('comment', 'Comment', { type: 'plain_text_input', multiline: true, max_length: TEXTAREA_MAX }, {
        hint: 'Posted on GitHub with your name and GitHub username. Markdown works.',
      }),
    ],
  };
}

export function labelView(issue, allLabels, meta) {
  const current = new Set((issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)));
  const option = (name) => ({ text: text(truncate(name, OPTION_TEXT_MAX)), value: name.slice(0, 150) });
  const options = allLabels.slice(0, 100).map((l) => option(l.name));
  const initial = options.filter((o) => current.has(o.value));
  return {
    type: 'modal',
    callback_id: CALLBACK.label,
    private_metadata: JSON.stringify(meta),
    title: text(truncate(`Labels for #${issue.number}`, MODAL_TITLE_MAX)),
    submit: text('Save labels'),
    close: text('Cancel'),
    blocks: [
      notice(`*${truncate(issue.title, 200)}*`),
      input(
        'labels',
        'Labels',
        { type: 'multi_static_select', options, ...(initial.length ? { initial_options: initial } : {}) },
        { optional: true },
      ),
    ],
  };
}

/** Asks for a GitHub username before an action that needs one (e.g. "Assign to me"). */
export function githubLoginView(meta, { reason }) {
  return {
    type: 'modal',
    callback_id: CALLBACK.githubLogin,
    private_metadata: JSON.stringify(meta),
    title: text('Link your GitHub'),
    submit: text('Save'),
    close: text('Cancel'),
    blocks: [
      notice(reason),
      input(GITHUB_LOGIN_BLOCK, 'Your GitHub username', { type: 'plain_text_input', max_length: 60, placeholder: text('octocat') }, {
        hint: 'Alpieca remembers it, so you only do this once.',
      }),
    ],
  };
}

export function statusView(title, markdown) {
  return {
    type: 'modal',
    title: text(truncate(title, MODAL_TITLE_MAX)),
    close: text('Close'),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: markdown } }],
  };
}

/** Flattens view.state.values into { blockId: value } (every element uses action_id "value"). */
export function readAnswers(view) {
  const answers = {};
  for (const [blockId, actions] of Object.entries(view.state?.values ?? {})) {
    const el = actions.value;
    if (el?.selected_options) answers[blockId] = el.selected_options.map((o) => o.value);
    else answers[blockId] = el?.value ?? el?.selected_option?.value ?? '';
  }
  return answers;
}
