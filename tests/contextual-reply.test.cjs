const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CognitiveOrchestrator } = require('../packages/brain/dist/llm/cognitive-orchestrator.js');
const { shortReplyKind, knowledgeQueries } = require('../packages/brain/dist/triage/contextual-reply.js');
const { BrainPipeline } = require('../packages/brain/dist/index.js');
const memory = { ownerStyleGuide: 'Brief', businessRules: ['ACK FAQ: Use the prior assistant message.'], approvedExamples: [] };
const texts = ['ok', 'okay', 'yes', 'thik hai', 'theek hai', 'samajh gaya', 'got it', 'haan', 'nahi', 'acha', 'hmm', 'sure', 'thanks'];
const contexts = {
  support: 'Please wait 24-72 hours for WhatsApp Support to review your appeal.',
  task: 'Please wait for the task notification.',
  withdrawal: 'Please check the withdrawal status in your wallet.',
  new: undefined,
};
const safeCritique = { passedHallucinationCheck: true, passedPolicyCheck: true, toneMatchesOwner: true, confidenceScore: .95 };
for (const [topic, previous] of Object.entries(contexts)) for (const text of texts) {
  test(`${JSON.stringify(text)} after ${topic}: failed synthesis retains context through full brain pipeline`, async () => {
    const history = previous ? [{ role: 'assistant', text: previous, isOutgoing: true, timestamp: 99 }] : [];
    const brain = new BrainPipeline('owner');
    brain.moderationScorer = { evaluatePersistent: async () => ({ requiresHumanReview: false }) };
    brain.contextBuilder = { buildContextForContact: async (_, queries) => {
      assert.ok(queries.includes(text));
      if (previous) assert.ok(queries.includes(previous));
      return memory;
    } };
    const ai = brain.cognitiveOrchestrator;
    let calls = 0;
    ai.generate = async (command, options) => {
      calls++;
      if (calls === 1) { if (previous) assert.ok(options.prompt.includes(previous)); throw Error('offline perception'); }
      if (calls === 2) {
        assert.ok(options.systemInstruction.includes(memory.businessRules[0]));
        if (previous) assert.ok(options.prompt.includes(previous));
        throw Error('offline synthesis');
      }
      assert.ok(options.prompt.includes(memory.businessRules[0]));
      if (previous) assert.ok(options.prompt.includes(previous));
      return JSON.stringify(safeCritique);
    };
    const result = await brain.processMessage({ senderId: '42', chatId: '42', messageId: 3, timestamp: 100, text, isPrivateChat: true }, history, 'draft');
    if (text === 'thanks' && previous && result.action === 'ignored') return;
    assert.equal(calls, 3);
    assert.doesNotMatch(result.replyText, /Namaste|Hello|how can i|kya sahayata/i);
    if (!previous) assert.match(result.replyText, /referring|kis baat/i);
    else if (['nahi', 'acha', 'hmm'].includes(text)) assert.match(result.replyText, /clarify|thoda aur/i);
    else if (text !== 'thanks') assert.match(result.replyText, new RegExp(topic, 'i'));
  });
}
test('generic synthesis and critique revisions cannot restart a short contextual exchange', async () => {
  for (const revision of [false, true]) {
    const ai = new CognitiveOrchestrator();
    let calls = 0;
    ai.generate = async () => {
      calls++;
      if (calls === 1) return JSON.stringify({ primaryIntent: 'general_greeting', detectedDialect: 'hinglish', sentiment: 'neutral' });
      if (calls === 2) return revision ? 'Thik hai.' : 'Namaste! LUMO tasks, withdrawal ya earning ke baare me main aapki kya sahayata kar sakta hoon?';
      return JSON.stringify({ ...safeCritique, ...(revision ? { revisedReply: 'Hello! How can I assist you with LUMO today?' } : {}) });
    };
    const result = await ai.execute({ text: 'Thik hai' }, memory, [{ role: 'assistant', text: contexts.support }]);
    assert.match(result.finalReply, /support team/i);
    assert.equal(result.critique.toneMatchesOwner, false);
    assert.equal(result.critique.confidenceScore, 0);
  }
});
test('short answers to questions clarify on outage; full questions are not reduced to acknowledgements', () => {
  const ai = new CognitiveOrchestrator();
  for (const text of texts) assert.match(ai.generateKnowledgeFallback(text, 'en', [{role:'assistant', text:'Have you submitted the appeal?'}]), /clarify/);
  for (const text of ['ok but where is my withdrawal?', 'yes please explain the task', 'this is broken', 'ok?', 'thanks! Payment is missing']) assert.equal(shortReplyKind(text), undefined);
  assert.match(ai.generateKnowledgeFallback('hi', 'en'), /Hello/);
  assert.deepEqual(knowledgeQueries('new issue', []), ['new issue']);
});
test('successful contextual model response survives and both provider payloads contain the prior assistant turn', async () => {
  const ai = new CognitiveOrchestrator();
  let calls = 0;
  const reply = 'Thik hai. Support se update na mile to batayein.';
  ai.generate = async (command, options) => {
    calls++;
    assert.ok(options.prompt.includes(contexts.support));
    if (calls === 1) return JSON.stringify({ primaryIntent:'acknowledgement', detectedDialect:'hinglish', sentiment:'neutral' });
    if (calls === 2) {
      assert.ok(command.input.messages.some(m => m.role === 'assistant' && m.content[0].text === contexts.support));
      assert.match(command.input.system[0].text, /not as a new conversation/);
      return reply;
    }
    return JSON.stringify(safeCritique);
  };
  const result = await ai.execute({text:'thik hai'}, memory, [{role:'assistant', text:contexts.support}]);
  assert.equal(result.finalReply, reply);
});

test('retrieval does not equate negative answers with acknowledgements or carry old topics into new questions', () => {
  const history = [{role:'assistant', text:'Please wait for the withdrawal.'}];
  for (const text of ['nahi', 'yes', 'thanks']) {
    const queries = knowledgeQueries(text, history);
    assert.ok(!queries.includes('acknowledgement'));
    assert.ok(!queries.includes('thik hai'));
    assert.ok(queries.includes(history[0].text));
  }
  assert.deepEqual(knowledgeQueries('How do I reset my password?', history), ['How do I reset my password?']);
});
test('language-neutral acknowledgements inherit the preceding assistant language during fallback', () => {
  const ai = new CognitiveOrchestrator();
  assert.match(ai.generateKnowledgeFallback('ok', 'en', [{role:'assistant', text:'Support team se update aane tak wait karein.'}]), /Thik hai/);
});
