// Screenshots, recordings and other files shared in Slack: picking them out of a thread and showing
// images to Alpie. The files themselves stay in Slack; feedback issues link to them.

const MAX_FILES = 10;
const ALPIE_IMAGES = 4;
const ALPIE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const ALPIE_IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp)$/;
// Links to Google Drive etc., deleted files, and files hidden by the workspace's plan limits.
const UNUSABLE_MODES = new Set(['external', 'tombstone', 'hidden_by_limit']);

/** The parts of a Slack file object Alpieca uses. */
export const slackFile = (f) => ({
  id: f.id,
  name: f.name || f.title || f.id,
  mimetype: f.mimetype || 'application/octet-stream',
  size: f.size ?? 0,
  permalink: f.permalink ?? null,
  // Needed to show images to Alpie. Without it every download failed and Alpie never saw a screenshot.
  download: f.url_private_download ?? f.url_private ?? null,
});

/** The files attached to a thread's messages, oldest first, without duplicates. */
export function filesIn(messages) {
  const seen = new Map();
  for (const m of messages ?? []) {
    for (const f of m.files ?? []) {
      if (!f?.id || seen.has(f.id) || UNUSABLE_MODES.has(f.mode)) continue;
      seen.set(f.id, slackFile(f));
    }
  }
  return [...seen.values()].slice(0, MAX_FILES);
}

/** Human-readable size, e.g. "2.4 MB". */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Downloads a Slack file with the bot token. `file` is a files.info / message `files[]` object.
 * Without the files:read scope Slack answers with its HTML sign-in page instead of the file.
 */
export async function downloadSlackFile(file, { token, maxBytes, fetchImpl = globalThis.fetch }) {
  if (maxBytes && file.size > maxBytes) throw new Error(`larger than ${formatBytes(maxBytes)}`);
  const url = file.download ?? file.url_private_download ?? file.url_private;
  if (!url) throw new Error("Slack didn't provide a download link");
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Slack download failed (${res.status})`);
  if (/text\/html/.test(res.headers.get('content-type') ?? '') && !/html/.test(file.mimetype ?? '')) {
    throw new Error('Slack refused the download; the app needs the files:read scope (reinstall it)');
  }
  const content = Buffer.from(await res.arrayBuffer());
  if (maxBytes && content.length > maxBytes) throw new Error(`larger than ${formatBytes(maxBytes)}`);
  return content;
}

/**
 * Images Alpie can look at, as data URLs. Best effort: anything that's too big, not an image or
 * fails to download is left out, since the text alone still makes a draft.
 */
export async function imagesForAlpie(files, download, logger = console) {
  const picked = files.filter((f) => ALPIE_IMAGE_TYPES.test(f.mimetype) && f.size <= ALPIE_IMAGE_MAX_BYTES).slice(0, ALPIE_IMAGES);
  const images = await Promise.all(
    picked.map(async (f) => {
      try {
        const content = await download(f, ALPIE_IMAGE_MAX_BYTES);
        return { name: f.name, url: `data:${f.mimetype};base64,${content.toString('base64')}` };
      } catch (err) {
        logger.warn(`Couldn't show ${f.name} to Alpie: ${err.message}`);
        return null;
      }
    }),
  );
  return images.filter(Boolean);
}
