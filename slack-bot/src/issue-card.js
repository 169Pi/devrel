// Slack "issue card": a preview of a GitHub issue with triage buttons.
// No dependencies, so the GitHub Action in .github/workflows can import it without `npm ci`.

export const ACTION = {
  assign: 'issue_assign_me',
  label: 'issue_label',
  comment: 'issue_comment',
  close: 'issue_close',
  reopen: 'issue_reopen',
};

// Hidden marker on issues filed from Slack. Carries the reporter's GitHub login so cards
// credit them rather than the bot token's owner, and lets the GitHub Action skip issues
// Alpieca already posted.
const MARKER = /<!--\s*alpieca(?::reporter=([A-Za-z0-9-]+))?\s*-->/;
export const slackMarker = (login) => (login ? `<!-- alpieca:reporter=${login} -->` : '<!-- alpieca -->');
export const isFromSlack = (body) => MARKER.test(body ?? '');
export const reporterFromBody = (body) => (body ?? '').match(MARKER)?.[1] ?? null;

const PREVIEW_MAX = 700;

/** Escapes text for Slack mrkdwn so issue content can't inject @channel pings or fake links. */
export function escapeSlack(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Turns an issue body (often one of our templates) into a short Slack preview:
 * headings become bold labels, unanswered sections, comments, images and the
 * Alpieca footer are dropped, and the result is cut at a line boundary.
 */
export function previewBody(body) {
  const cleaned = String(body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n---\n<sub>[\s\S]*$/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<img\b[^>]*>/gi, '');

  // Drop sections whose only content is "_No response_".
  const sections = cleaned.split(/\n(?=#{1,6} )/).filter((s) => !/^#{1,6} .*\n\s*_No response_\s*$/.test(s.trim()));

  const lines = sections
    .join('\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, i, all) => line || (all[i - 1] && all[i - 1] !== ''));

  let out = '';
  for (const line of lines) {
    if (out.length + line.length + 1 > PREVIEW_MAX) {
      out += '\n…';
      break;
    }
    out += `${out ? '\n' : ''}${line}`;
  }

  return escapeSlack(out.trim())
    .replace(/^#{1,6} (.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');
}

const button = (actionId, label, value, extra = {}) => ({
  type: 'button',
  action_id: actionId,
  text: { type: 'plain_text', text: label, emoji: true },
  value,
  ...extra,
});

/**
 * @param issue    GitHub issue object (REST shape: number, title, html_url, body, state, labels, user, assignees)
 * @param headline optional mrkdwn line above the card, e.g. ":memo: <@U1> raised an issue"
 * @param note     optional mrkdwn status line under the buttons, e.g. "Closed by Priya"
 */
export function issueCard(issue, { repo, headline, note } = {}) {
  const number = issue.number;
  const open = issue.state === 'open';
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean);
  const assignees = (issue.assignees ?? []).map((a) => a.login);
  const reporter = reporterFromBody(issue.body) ?? issue.user?.login;
  const state = open ? ':large_green_circle: Open' : issue.state_reason === 'not_planned' ? ':white_circle: Closed (not planned)' : ':large_purple_circle: Closed';

  const meta = [
    state,
    reporter && `by <https://github.com/${reporter}|@${reporter}>`,
    labels.length && labels.map((l) => `\`${escapeSlack(l)}\``).join(' '),
    assignees.length && `assigned to ${assignees.map((a) => `<https://github.com/${a}|@${a}>`).join(', ')}`,
  ].filter(Boolean);

  const preview = previewBody(issue.body);
  const value = String(number);
  const blocks = [
    ...(headline ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: headline }] }] : []),
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*<${issue.html_url}|#${number} ${escapeSlack(issue.title)}>*` },
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${meta.join('  ·  ')}  ·  ${escapeSlack(repo ?? '')}` }] },
    ...(preview ? [{ type: 'section', text: { type: 'mrkdwn', text: preview } }] : []),
    {
      type: 'actions',
      block_id: `issue_actions_${number}`,
      elements: [
        button('issue_view', 'View on GitHub', value, { url: issue.html_url }),
        ...(open
          ? [
              button(ACTION.assign, '🙋 Assign to me', value),
              button(ACTION.label, '🏷️ Label', value),
              button(ACTION.comment, '💬 Comment', value),
              button(ACTION.close, '✅ Close', value, {
                style: 'danger',
                confirm: {
                  title: { type: 'plain_text', text: `Close #${number}?` },
                  text: { type: 'mrkdwn', text: 'This closes the issue on GitHub as completed.' },
                  confirm: { type: 'plain_text', text: 'Close it' },
                  deny: { type: 'plain_text', text: 'Cancel' },
                },
              }),
            ]
          : [button(ACTION.comment, '💬 Comment', value), button(ACTION.reopen, '↩️ Reopen', value)]),
      ],
    },
    ...(note ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: note }] }] : []),
  ];

  return { text: `#${number} ${issue.title}`, blocks, unfurl_links: false, unfurl_media: false };
}
