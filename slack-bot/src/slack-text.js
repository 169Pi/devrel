/**
 * Converts Slack message markup into plain text Alpie can read:
 * <@U123> -> @Name, <#C123|general> -> #general, <https://x|label> -> label (https://x).
 */
export async function slackToPlain(text, resolveUser) {
  const ids = [...new Set([...(text ?? '').matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]))];
  const names = new Map(await Promise.all(ids.map(async (id) => [id, (await resolveUser(id)) ?? 'someone'])));
  return (text ?? '')
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${names.get(id)}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<!(here|channel|everyone)>/g, '@$1')
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label) => label ?? '@team')
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Renders a thread as "Name: text" lines, marking the message the shortcut was used on. */
export async function threadTranscript(messages, { selectedTs, resolveUser, maxChars = 12_000 }) {
  const lines = await Promise.all(
    messages.map(async (m) => {
      const who = m.user ? ((await resolveUser(m.user)) ?? 'someone') : (m.username ?? m.bot_profile?.name ?? 'bot');
      const mark = messages.length > 1 && m.ts === selectedTs ? ' (selected message)' : '';
      return `${who}${mark}: ${await slackToPlain(m.text, resolveUser)}`;
    }),
  );
  const transcript = lines.join('\n');
  if (transcript.length <= maxChars) return transcript;
  // Long thread: keep the opening message (the ask) and the latest replies (the conclusion).
  const head = lines[0].slice(0, maxChars / 3);
  return `${head}\n[…earlier replies omitted…]\n${transcript.slice(-(maxChars - head.length))}`;
}

/** Converts the Markdown Alpie writes into Slack mrkdwn, escaping anything that could ping or fake a link. */
export function markdownToMrkdwn(markdown) {
  const links = [];
  const text = String(markdown ?? '')
    // Pull links out first so escaping doesn't mangle their URLs.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => `\u0000${links.push(`<${url}|${label.replace(/[<>|]/g, '')}>`) - 1}\u0000`)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/^(\s*)[-*]\s+/gm, '$1• ');
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => links[Number(i)]);
}

// Clear signs someone wants something raised, even when phrased as a question ("can you file this?").
const STRONG_ISSUE = /\b(bug|broken|crash(es|ed|ing)?|doesn'?t work|not working|error|fails?|failing|feature request|raise|file|report|log (this|it))\b/i;
// Softer signs that only count when the message isn't a question ("is there an issue about merch?").
const SOFT_ISSUE =
  /\b(issues?|ideas?|suggest(ion)?s?|propos(e|al)|requests?|merch|swag|hoodies?|t-?shirts?|stickers?|mugs?|showcase|built (a|an|with)|demo|we should|let'?s (make|build|add|do)|(would|it'?d) be (nice|great|cool|awesome))\b/i;
const QUESTION = /^\s*(what|how|why|when|where|who|which|is|are|can|could|does|do|did|any|should|has|have|tell me)\b|\?\s*$/i;

/** Cheap first guess at intent, so drafting can start before anyone clicks. */
export function looksLikeIssue(text) {
  const t = String(text ?? '');
  return STRONG_ISSUE.test(t) || (SOFT_ISSUE.test(t) && !QUESTION.test(t));
}
