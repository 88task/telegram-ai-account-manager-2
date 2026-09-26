const { test } = require('node:test');
const assert = require('node:assert/strict');
const { UnansweredDetector } = require('../packages/brain/dist/triage/unanswered-detector.js');
const { ScopeFilter } = require('../packages/brain/dist/filters/scope-filter.js');
const { ModeDispatcher } = require('../packages/brain/dist/dispatcher/mode-dispatcher.js');
const detector = new UnansweredDetector();
const incoming = { senderId: '42', chatId: '42', text: 'When is the next task?', timestamp: 100 };

test('fresh inbound message remains eligible after earlier outgoing history', () => {
  assert.equal(detector.analyze(incoming, [{ isOutgoing: true, timestamp: 99 }], '1').replyRequired, true);
});
test('owner and already answered older messages are ignored; equal timestamp stays eligible', () => {
  assert.equal(detector.analyze({ ...incoming, senderId: '1' }, [], '1').replyRequired, false);
  assert.equal(detector.analyze(incoming, [{ isOutgoing: true, timestamp: 101 }], '1').replyRequired, false);
  assert.equal(detector.analyze(incoming, [{ isOutgoing: true, timestamp: 100 }], '1').replyRequired, true);
});
test('closers and urgency retain their behavior', () => {
  assert.equal(detector.analyze({ ...incoming, text: 'Thanks!' }, [ {}, {} ], '1').isConversationClosed, true);
  assert.equal(detector.analyze(incoming, [], '1').urgency, 'high');
});
test('DM scope wins over contradictory flags; group allowlist, blocklist and admin guards remain', () => {
  const filter = new ScopeFilter(['-10042'], ['43']);
  assert.equal(filter.check({ ...incoming, isChannel: true }).allowed, true);
  assert.equal(filter.check({ ...incoming, senderId: '43' }).allowed, false);
  assert.equal(filter.check({ ...incoming, chatId: '-10042', isChannel: true }).allowed, true);
  assert.equal(filter.check({ ...incoming, chatId: '-10043', isChannel: true }).allowed, false);
  assert.equal(filter.check({ ...incoming, chatId: '-10042', isSenderAdmin: true }).allowed, false);
});
test('manual, draft, confidence and safety dispatch boundaries remain intact', () => {
  const dispatcher = new ModeDispatcher(0.85);
  const reply = { text: 'Hello', confidence: 0.95 };
  const safe = { safeForAutoPilot: true, escalationReasons: [] };
  assert.equal(dispatcher.dispatch('manual', reply, safe).action, 'draft_queued');
  assert.equal(dispatcher.dispatch('draft', reply, safe).action, 'approval_required');
  assert.equal(dispatcher.dispatch('auto_pilot', reply, safe).action, 'auto_sent');
  assert.equal(dispatcher.dispatch('auto_pilot', { ...reply, confidence: 0.84 }, safe).action, 'approval_required');
  assert.equal(dispatcher.dispatch('auto_pilot', reply, { safeForAutoPilot: false, escalationReasons: ['dispute'] }).action, 'approval_required');
});
