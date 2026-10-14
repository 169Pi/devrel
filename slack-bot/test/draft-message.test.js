import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DRAFT_ACTION, DRAFT_BLOCK, draftFailedMessage, draftingMessage, draftMessage } from '../src/draft-message.js';
import { qualify } from '../src/repos.js';
import { loadLocalTemplates } from '../src/templates.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const template = qualify(await loadLocalTemplates(path.resolve(HERE, '../feedback-templates'), { warn() {} }), '169Pi/app-alpie')[0];
const ids = Object.fromEntries(template.sections.flatMap((s) => s.fields.map((f) => [f.label, f.id])));
const answers = {
  title: 'iOS App Chat window: Long prompt overlaps the <greeting>',
  s0: ['iOS App'],
  [ids['Area or screen']]: 'Chat window',
  [ids.Type]: 'Bug',
  [ids.Severity]: 'Minor',
  s2: 'When the prompt is long, the input box grows over the greeting.',
};
const value = JSON.stringify({ channel: 'C1', ts: '1.2', thread: null, dm: false });
const actions = (m) => m.blocks.find((b) => b.type === 'actions');

test('the thread draft shows only the title, credits the reporter, and anyone can review it', () => {
  const m = draftMessage({ template, answers }, { value, raisedBy: 'UPRIYA', files: 2 });
  const text = JSON.stringify(m.blocks);
  assert.match(m.blocks[0].text.text, /Alpie drafted a \*Product Feedback 💬\* issue for <@UPRIYA> in \*169Pi\/app-alpie\*/);
  assert.match(text, /\[Feedback\]: iOS App Chat window: Long prompt overlaps the &lt;greeting&gt;/, 'escaped');
  assert.doesNotMatch(text, /Minor|Which products|When the prompt is long/, 'no field answers in the thread');
  assert.deepEqual(m.blocks.map((b) => b.type), ['section', 'actions', 'context']);
  assert.match(text, /2 files from the thread/);
  assert.match(text, /Anyone here can review it and file it/);
  const buttons = actions(m);
  assert.equal(buttons.block_id, DRAFT_BLOCK);
  assert.deepEqual(buttons.elements.map((e) => e.action_id), [DRAFT_ACTION.review, DRAFT_ACTION.pick]);
  assert.ok(buttons.elements.every((e) => e.value === value));
});

test('while drafting, and when drafting fails, the thread still has a way forward', () => {
  assert.match(draftingMessage('⠋ *Reading…*').text, /Drafting an issue from this…/);
  assert.match(draftingMessage('⠋', { raisedBy: 'U1' }).text, /for <@U1>/);
  const failed = draftFailedMessage({ value, reason: 'Alpie took too long to respond' });
  assert.match(failed.text, /couldn't draft an issue from this \(Alpie took too long to respond\)/);
  assert.deepEqual(actions(failed).elements.map((e) => e.text.text), ['🔁 Try again', 'Pick a template']);
  assert.deepEqual(actions(draftFailedMessage({ value, alpie: false })).elements.map((e) => e.action_id), [DRAFT_ACTION.pick]);
});
