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
