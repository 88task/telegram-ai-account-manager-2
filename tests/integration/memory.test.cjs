const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openTestDatabase } = require('./helpers.cjs');

test('moderation persists across instances and isolates chats; contact context is loaded', async t => {
  const data = await openTestDatabase(); t.after(() => data.close()); await data.initDb();
  const { ModerationScorer } = require('../../packages/brain/dist/safety/moderation-scorer.js');
  const { ContextBuilder } = require('../../packages/brain/dist/memory/context-builder.js');
  const input = { chatId: '-42', senderId: '7', text: 'fuck you' };
  await new ModerationScorer().evaluatePersistent(input);
  const repeated = await new ModerationScorer().evaluatePersistent(input);
  assert.equal(repeated.recommendedAction, 'review_for_removal');
  const other = await new ModerationScorer().evaluatePersistent({ ...input, chatId: '-43', text: 'When is the next task?' });
  assert.equal(other.isSafeToAutoReply, true);
  const [{ state }] = await data.db.select().from(data.moderationStates).where(data.eq(data.moderationStates.key, '-42:7'));
  assert.equal(state.strikeCount, 2); assert.ok(state.history.every(item => item.text === ''));
  await data.db.insert(data.contacts).values({ telegramUserId: '7', notes: 'Needs concise responses', customInstructions: 'Use English' });
  const context = await new ContextBuilder().buildContextForContact('7', []);
  assert.equal(context.contactNotes, 'Needs concise responses');
  assert.ok(context.businessRules.includes('Contact instructions: Use English'));
});
