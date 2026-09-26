const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openTestDatabase } = require('./helpers.cjs');

test('older acknowledgement FAQ ranks ahead of 60 newer unrelated entries and reaches the model prompt', async t => {
  const data = await openTestDatabase(); t.after(() => data.close()); await data.initDb();
  const { ContextBuilder } = require('../../packages/brain/dist/memory/context-builder.js');
  const { knowledgeQueries } = require('../../packages/brain/dist/triage/contextual-reply.js');
  const { CognitiveOrchestrator } = require('../../packages/brain/dist/llm/cognitive-orchestrator.js');
  await data.db.insert(data.knowledgeItems).values({ category:'faq', questionOrTrigger:'ok okay thik hai theek hai got it acknowledgement', content:'ACK_SENTINEL: Acknowledge the previous instruction briefly.', createdAt:new Date('2020-01-01') });
  await data.db.insert(data.knowledgeItems).values(Array.from({length:60}, (_,i) => ({category:'faq', questionOrTrigger:`Unrelated ${i}`, content:'Download instructions.'})));
  await data.db.insert(data.knowledgeItems).values({category:'rule', content:'GLOBAL_SENTINEL: Never disclose private account details.', createdAt:new Date('2019-01-01')});
  await data.db.insert(data.knowledgeItems).values(Array.from({length:55}, (_,i) => ({category:'faq', questionOrTrigger:`ok ${i}`, content:'Brief answer.'})));
  const history = [{role:'assistant', text:'Please wait for WhatsApp Support to review your appeal.'}];
  const context = await new ContextBuilder().buildContextForContact('7', knowledgeQueries('thik hai', history));
  assert.ok(context.businessRules.some(rule => rule.includes('ACK_SENTINEL')));
  assert.ok(context.businessRules.some(rule => rule.includes('GLOBAL_SENTINEL')));
  const ai = new CognitiveOrchestrator();
  ai.generate = async (_, options) => { assert.match(options.systemInstruction, /ACK_SENTINEL/); assert.ok(options.prompt.includes(history[0].text)); return 'Thik hai.'; };
  assert.equal(await ai.synthesizeDraft({text:'thik hai'}, {detectedDialect:'hinglish'}, context, history), 'Thik hai.');
});
