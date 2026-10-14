// The draft Alpieca posts in the thread it was mentioned in: anyone there can review it and file
// it, as often as they like until someone does, and it then becomes the issue's card.

import { escapeSlack } from './issue-card.js';

export const DRAFT_BLOCK = 'issue_offer';
export const DRAFT_ACTION = { review: 'mention_draft', pick: 'mention_pick' };

const TEXT_MAX = 2900;

const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, TEXT_MAX) } });
const context = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

function buttons(value, { review = true, reviewText = '📝 Review and file', pickText = 'Pick another template' } = {}) {
  return {
    type: 'actions',
    block_id: DRAFT_BLOCK,
    elements: [
      ...(review ? [{ type: 'button', action_id: DRAFT_ACTION.review, style: 'primary', text: { type: 'plain_text', text: reviewText }, value }] : []),
      { type: 'button', action_id: DRAFT_ACTION.pick, text: { type: 'plain_text', text: pickText }, value },
    ],
  };
}

const forWhom = (raisedBy) => (raisedBy ? ` for <@${raisedBy}>` : '');

/** While Alpie drafts: the loading animation (a statusLine) and who it's for. */
export function draftingMessage(status, { raisedBy } = {}) {
  const text = `:llama: Drafting an issue from this${forWhom(raisedBy)}…`;
  return { text, blocks: [section(text), context(status)] };
}

/**
 * The finished draft: just its title and the buttons, so the details stay in the form until someone
 * opens it. `value` is what the buttons carry.
 */
export function draftMessage(draft, { value, raisedBy, files = 0 }) {
  const { template, answers } = draft;
  const title = `${template.titlePrefix}${answers.title ?? ''}`.trim() || template.name;
  const where = template.repo ? ` in *${escapeSlack(template.repo)}*` : '';
  const text = `:llama: Alpie drafted a *${escapeSlack(template.name)}* issue${forWhom(raisedBy)}`;
  return {
    text: `${text}: ${title}`,
    blocks: [
      section(`${text}${where}:\n*${escapeSlack(title)}*`),
      buttons(value),
      context(
        [
          files && `:paperclip: ${files} file${files === 1 ? '' : 's'} from the thread`,
          "Anyone here can review it and file it. Nothing is filed until someone clicks *Create issue*, and Alpie can make mistakes, so check each field.",
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    ],
  };
}

/** Alpie couldn't draft it (or isn't set up): people can still try again or fill in a template. */
export function draftFailedMessage({ value, reason, raisedBy, alpie = true }) {
  const text = alpie
    ? `:warning: Alpie couldn't draft an issue from this (${reason}). Try again, or pick a template and fill it in.`
    : `:llama: Want to raise an issue from this${forWhom(raisedBy)}? Pick a template and I'll file it.`;
  return { text, blocks: [section(text), buttons(value, { review: alpie, reviewText: '🔁 Try again', pickText: 'Pick a template' })] };
}
