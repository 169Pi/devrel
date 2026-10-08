import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAlpie, progressOf } from '../src/alpie.js';
import { createProgress, fractionDone, llamaTrack, startTicker, statusLine } from '../src/progress.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake Alpie that streams `content` as server-sent events, a few characters at a time. */
function streamingFetch(content, { chunk = 7 } = {}) {
  return async (url, init) => {
    assert.equal(JSON.parse(init.body).stream, true);
    const events = [];
    for (let i = 0; i < content.length; i += chunk) {
      events.push(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + chunk) } }] })}\n\n`);
    }
    events.push('data: [DONE]\n\n');
    // Split the byte stream at awkward places, as a real network would.
    const bytes = new TextEncoder().encode(events.join(''));
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13));
        controller.close();
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
}

test('the llama walks along the track and never claims 100% early', () => {
  assert.equal(llamaTrack(0), `🦙${'┄'.repeat(14)}`);
  assert.equal(llamaTrack(1), `${'━'.repeat(14)}🦙`);
  assert.equal(llamaTrack(0.5), `${'━'.repeat(7)}🦙${'┄'.repeat(7)}`);
  const p = createProgress();
  assert.equal(fractionDone(p), 0.02);
  assert.equal(fractionDone({ ...p, phase: 'writing', chars: 99_999 }), 0.95);
  assert.ok(fractionDone({ ...p, phase: 'thinking', chars: 600 }) < fractionDone({ ...p, phase: 'writing', chars: 1400 }));
});

test('status line shows a spinner frame, the stage, the track and elapsed seconds', () => {
  const p = { ...createProgress(), startedAt: Date.now() - 6_200 };
  assert.match(statusLine(p, 0), /^⠋ \*Reading the conversation…\*\n`🦙┄+`  6s$/);
  assert.match(statusLine({ ...p, phase: 'thinking', chars: 500 }, 1), /^⠙ \*Alpie is thinking it through…\*/);
  assert.match(statusLine({ ...p, phase: 'writing', chars: 1500 }, 2, 'draft'), /Alpie is writing the draft/);
  assert.match(statusLine({ ...p, phase: 'writing', chars: 1500 }, 2, 'answer'), /Alpie is writing an answer/);
});

test('progressOf splits reasoning from output at </think>', () => {
  assert.deepEqual(progressOf('Let me think'), { phase: 'thinking', chars: 12, output: '' });
  assert.deepEqual(progressOf('Hmm.\n</think>\n\nYes, #7'), { phase: 'writing', chars: 22, output: 'Yes, #7' });
});

test('drafts stream with progress updates and still parse', async () => {
  const content = `Reasoning about the hoodie at length…\n</think>\n\n${JSON.stringify({
    template_id: 'm.md',
    title: 'Neon hoodie',
    fields: { s0: 'Hoodie' },
    additional_context: '',
  })}`;
  const seen = [];
  const alpie = createAlpie({ apiKey: 'k', baseUrl: 'https://x', model: 'm', timeoutMs: 5000, fetchImpl: streamingFetch(content) });
  const template = { id: 'm.md', titlePrefix: '', sections: [{ id: 's0', fields: [] }] };
  const draft = await alpie.draft({ templates: [template], feedback: 'hoodie', onProgress: (p) => seen.push({ ...p }) });
  assert.equal(draft.answers.s0, 'Hoodie');
  assert.ok(seen.length > 10, 'many progress updates');
  assert.equal(seen[0].phase, 'thinking');
  assert.equal(seen.at(-1).phase, 'writing');
  assert.equal(seen.at(-1).chars, content.length);
  assert.ok(seen.every((p, i) => i === 0 || p.chars >= seen[i - 1].chars), 'progress only moves forward');
});

test('streamed answers are filtered for invented links while still partial', async () => {
  const content = 'Thinking.\n</think>\nSee https://fake.example/x and https://github.com/169Pi/devrel/issues/7 for more.';
  const partials = [];
  const alpie = createAlpie({ apiKey: 'k', baseUrl: 'https://x', model: 'm', timeoutMs: 5000, fetchImpl: streamingFetch(content, { chunk: 4 }) });
  const reply = await alpie.answer({
    repo: '169Pi/devrel',
    conversation: 'any issues?',
    templates: [],
    issues: [{ number: 7, title: 't', state: 'open', labels: [], url: 'https://github.com/169Pi/devrel/issues/7' }],
    onProgress: (p) => partials.push(p.output),
  });
  assert.equal(reply, 'See [link removed] and https://github.com/169Pi/devrel/issues/7 for more.');
  assert.ok(partials.every((o) => !o.includes('fake.example/x')), 'no partial ever shows the invented link');
});

test('ticker pushes frames, never overlaps them, and stop() waits for the last one', async () => {
  const frames = [];
  let active = 0;
  let maxActive = 0;
  const stop = startTicker(
    async (tick) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(35); // slower than the interval: frames must be skipped, not queued
      frames.push(tick);
      active--;
    },
    { intervalMs: 10 },
  );
  await sleep(120);
  await stop();
  const count = frames.length;
  assert.ok(count >= 2, `pushed ${count} frames`);
  assert.equal(maxActive, 1);
  assert.deepEqual(frames, [...frames.keys()], 'ticks are sequential');
  await sleep(40);
  assert.equal(frames.length, count, 'nothing is pushed after stop()');
});

test('ticker stops quietly when a push fails (e.g. the modal was closed)', async () => {
  let calls = 0;
  const stop = startTicker(
    async () => {
      calls++;
      throw new Error('view_not_found');
    },
    { intervalMs: 10 },
  );
  await sleep(80);
  await stop();
  assert.equal(calls, 1);
});
