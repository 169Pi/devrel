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

// Someone asking for an issue to be filed, even as a question ("can you raise this?"). Always a draft.
const WANTS_FILED =
  /\b((raise|file|log|report|open|create|make|draft) (this|it|that|one|an? (issue|bug|ticket|feedback))|turn (this|it|that) into|feature request|bug report)\b/i;
// Asking about issues rather than raising one: counts, lists, people, status and access.
// "Total number of issues raised here" or "how many open issues by @vishal" is never feedback.
const ABOUT_ISSUES =
  /\b(how many|how much|total|number of|count of|stats|statistics|summar(y|ise|ize)|(give|show|send|get) me|i want (a |the )?(list|count|number)|list (all|the|of|every|open|closed|my|our)|status of|assigned to|opened by|raised by|filed by|created by|reported by|by (<@\w+>|@[\w-]+|me)|my( open| closed)? (issues|prs|pull requests)|(have|got) access|what (do|can) you (have access|access|see)|(which|what) repos)\b/i;
// Clear signs of a problem worth raising.
const PROBLEM =
  /\b(bug|broken|crash(es|ed|ing)?|doesn'?t work|not working|error|fails?|failing|freez(es|ing)|frozen|stuck|hangs|glitch(es|y)?|overlap(s|ping)?|cut off|can'?t (log|sign|load|open|see|send)|raise|report)\b/i;
// Softer signs that only count when the message isn't a question ("is there an issue about merch?").
const SOFT_ISSUE =
  /\b(issues?|ideas?|suggest(ion)?s?|propos(e|al)|requests?|merch|swag|hoodies?|t-?shirts?|stickers?|mugs?|showcase|built (a|an|with)|demo|we should|let'?s (make|build|add|do)|(would|it'?d) be (nice|great|cool|awesome))\b/i;
const QUESTION = /^\s*(what|how|why|when|where|who|which|is|are|can|could|does|do|did|any|should|has|have|tell me|list|show)\b|\?\s*$/i;
// "Hey, how many…" is still a question.
const GREETING = /^\s*(?:(?:hey|hi|hello|yo|ok(?:ay)?|so|um+|hmm+|please|pls)\b[\s,!.:-]*)+/i;

/** True when the message asks about issues, PRs or access, rather than raising something. */
export function asksAboutIssues(text) {
  const t = String(text ?? '').replace(GREETING, '');
  return !WANTS_FILED.test(t) && ABOUT_ISSUES.test(t);
}

/**
 * Cheap first guess at intent, so drafting can start before anyone clicks. When in doubt it says no:
 * a question gets an answer with a "Draft an issue" button, which is cheaper to undo than a public draft.
 */
export function looksLikeIssue(text) {
  const t = String(text ?? '').replace(GREETING, '');
  if (WANTS_FILED.test(t)) return true;
  if (ABOUT_ISSUES.test(t)) return false;
  // A word or two ("issues", "merch") isn't enough to draft from.
  if (t.trim().split(/\s+/).length < 3 && !PROBLEM.test(t)) return false;
  return PROBLEM.test(t) || (SOFT_ISSUE.test(t) && !QUESTION.test(t));
}

/** People a question is about: Slack mentions (<@U123>), typed GitHub usernames (@octocat), and "me"/"my". */
export function peopleAskedAbout(text) {
  const t = String(text ?? '');
  const slack = [...t.matchAll(/<@(\w+)(?:\|[^>]*)?>/g)].map((m) => m[1]);
  const github = [...t.replace(/<[^>]*>/g, ' ').matchAll(/(?:^|[\s(,])@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\b/g)].map((m) => m[1]);
  const me = /\b(my|mine|by me|to me|i (opened|raised|filed|reported|created))\b/i.test(t);
  return { slack: [...new Set(slack)], github: [...new Set(github)], me };
}

/**
 * Who raised what's being filed: the selected message's author, or whoever started the thread when
 * that message is only an @mention ("@Alpieca" under someone's bug report). Never a bot.
 */
export function raiserOf(messages, ts) {
  const person = (m) => (m?.user && !m.bot_id ? m.user : null);
  const selected = messages.find((m) => m.ts === ts);
  const bareMention = selected && !selected.files?.length && /^\s*(?:<@\w+>\s*)*$/.test(selected.text ?? '');
  return (bareMention ? person(messages[0]) : null) ?? person(selected) ?? person(messages[0]);
}
