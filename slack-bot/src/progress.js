// Loading animations for the ~15s Alpie takes. Slack can't animate text on its own, so the bot
// re-renders the message or modal every couple of seconds from Alpie's streamed progress.

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TRACK = 14;

// A typical Alpie reply: ~1,200 characters of reasoning, then the output (~400 for a draft).
const EXPECTED_CHARS = { draft: 1700, answer: 1900 };

export const STAGES = {
  reading: 'Reading the conversation',
  thinking: 'Alpie is thinking it through',
  writing: { draft: 'Alpie is writing the draft', answer: 'Alpie is writing an answer' },
};

export function createProgress() {
  return { phase: 'reading', chars: 0, output: '', startedAt: Date.now() };
}

/** Fraction done, from how much Alpie has streamed. Never claims 100% before it's finished. */
export function fractionDone(progress, kind = 'draft') {
  if (progress.phase === 'reading') return 0.02;
  return Math.min(0.95, 0.05 + progress.chars / EXPECTED_CHARS[kind]);
}

/** "━━━━━🦙┄┄┄┄┄┄┄┄": the llama walks along the track as Alpie streams. */
export function llamaTrack(fraction) {
  const at = Math.round(Math.min(1, Math.max(0, fraction)) * TRACK);
  return `${'━'.repeat(at)}🦙${'┄'.repeat(TRACK - at)}`;
}

export function statusLine(progress, tick, kind = 'draft') {
  const stage = progress.phase === 'writing' ? STAGES.writing[kind] : STAGES[progress.phase];
  const seconds = Math.max(0, Math.round((Date.now() - progress.startedAt) / 1000));
  return `${SPINNER[tick % SPINNER.length]} *${stage}…*\n\`${llamaTrack(fractionDone(progress, kind))}\`  ${seconds}s`;
}

/**
 * Calls push(tick) every intervalMs until stopped. Updates never overlap, and stop() waits for
 * the one in flight, so a late animation frame can't overwrite the final result. A failed push
 * (e.g. the person closed the modal) ends the animation quietly.
 */
export function startTicker(push, { intervalMs = 2000 } = {}) {
  let tick = 0;
  let stopped = false;
  let busy = false;
  let inflight = Promise.resolve();
  const timer = setInterval(() => {
    // If Slack is slow, skip this frame rather than queueing frames behind it.
    if (stopped || busy) return;
    busy = true;
    inflight = Promise.resolve()
      .then(() => push(tick++))
      .catch(() => {
        stopped = true;
        clearInterval(timer);
      })
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  timer.unref?.();
  return async function stop() {
    stopped = true;
    clearInterval(timer);
    await inflight;
  };
}
