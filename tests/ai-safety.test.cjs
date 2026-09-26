const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CognitiveOrchestrator } = require('../packages/brain/dist/llm/cognitive-orchestrator.js');
const { ModeDispatcher } = require('../packages/brain/dist/dispatcher/mode-dispatcher.js');
const { encryptionKey, encryptSecret, defaultOperatingMode } = require('../packages/db/dist/configuration.js');
const message = { text: 'When is the task?', chatId: '42', senderId: '42' };
const memory = { ownerStyleGuide: 'Brief', businessRules: [], approvedExamples: [] };
const perception = { sentiment: 'neutral', primaryIntent: 'support', detectedDialect: 'en' };

test('provider selection is strict and fallback is restricted to auto mode', async () => {
  const ai = new CognitiveOrchestrator();
  let bedrockCalls = 0, geminiCalls = 0;
  ai.client = { send: async () => { bedrockCalls++; throw new Error('provider offline'); } };
  ai.geminiPool = { updateConfig() {}, hasKeys: () => true, generateContent: async () => { geminiCalls++; return 'synthetic reply'; } };
  ai.setGeminiConfig(['synthetic'], undefined, 'gemini');
  assert.equal(await ai.synthesizeDraft(message, perception, memory, []), 'synthetic reply');
  assert.equal(bedrockCalls, 0);
  ai.setGeminiConfig([], undefined, 'bedrock');
  await ai.synthesizeDraft(message, perception, memory, []);
  assert.equal(geminiCalls, 1);
  ai.setGeminiConfig([], undefined, 'auto');
  assert.equal(await ai.synthesizeDraft(message, perception, memory, []), 'synthetic reply');
  assert.equal(geminiCalls, 2);
  assert.equal(bedrockCalls, 2);
});

test('critique failure, malformed confidence and non-boolean flags fail closed', async () => {
  const ai = new CognitiveOrchestrator();
  ai.setGeminiConfig([], undefined, 'bedrock');
  for (const response of [null, 'not JSON', '{"confidenceScore":1.5}', '{"confidenceScore":0.99,"passedPolicyCheck":"true"}']) {
    ai.client = { send: async () => { if (response === null) throw new Error('offline'); return { output: { message: { content: [{ text: response }] } } }; } };
    const result = await ai.selfCritique('candidate', message, perception, memory);
    assert.equal(result.passedPolicyCheck, false);
    assert.equal(result.passedHallucinationCheck, false);
  }
  const safe = { safeForAutoPilot: true, escalationReasons: [] };
  const dispatcher = new ModeDispatcher(NaN);
  for (const confidence of [NaN, Infinity, -1, 1.5]) assert.equal(dispatcher.dispatch('auto_pilot', { text: 'reply', confidence }, safe).action, 'approval_required');
  assert.equal(dispatcher.dispatch('auto_pilot', { text: '', confidence: 1 }, safe).action, 'approval_required');
});

test('configuration rejects weak encryption and uses a safe default', t => {
  const original = { ...process.env };
  t.after(() => { for (const k of ['SESSION_ENCRYPTION_KEY','DEFAULT_OPERATING_MODE','OPERATING_MODE']) original[k] === undefined ? delete process.env[k] : process.env[k] = original[k]; });
  delete process.env.DEFAULT_OPERATING_MODE; delete process.env.OPERATING_MODE;
  assert.equal(defaultOperatingMode(), 'draft');
  process.env.DEFAULT_OPERATING_MODE = 'invalid';
  assert.equal(defaultOperatingMode(), 'draft');
  process.env.SESSION_ENCRYPTION_KEY = 'weak';
  assert.throws(encryptionKey, /64/);
  process.env.SESSION_ENCRYPTION_KEY = 'ab'.repeat(32);
  const encrypted = encryptSecret('synthetic secret');
  assert.match(encrypted, /^enc:/); assert.ok(!encrypted.includes('synthetic secret'));
});

test('vision outages require review while genuinely unclear screenshots stay ignored', async () => {
  const { BrainPipeline } = require('../packages/brain/dist/index.js');
  const { ScreenshotTriage } = require('../packages/brain/dist/vision/screenshot-triage.js');
  const vision = new ScreenshotTriage();
  vision.setGeminiConfig([], undefined, 'gemini');
  const result = await vision.triageImage(Buffer.from('synthetic'));
  assert.equal(result.providerUnavailable, true);
  vision.setGeminiConfig([], undefined, 'bedrock');
  vision.client = { send: async () => { throw new Error('offline'); } };
  assert.equal((await vision.triageImage(Buffer.from('synthetic'))).providerUnavailable, true);
  const brain = new BrainPipeline('1');
  brain.moderationScorer = { evaluatePersistent: async () => ({ requiresHumanReview: false }) };
  brain.screenshotTriage = { triageImage: async () => result };
  const image = { ...message, messageId: 1, isPrivateChat: true, mediaBuffer: Buffer.from('synthetic'), mediaMimeType: 'image/jpeg' };
  assert.equal((await brain.processMessage(image, [], 'auto_pilot')).action, 'approval_required');
  brain.screenshotTriage = { triageImage: async () => ({ ...result, providerUnavailable: false }) };
  assert.equal((await brain.processMessage(image, [], 'auto_pilot')).action, 'ignored');
});

test('runtime and migrations share verified TLS; connection URL cannot override it', t => {
  const { databaseConnectionOptions } = require('../packages/db/dist/configuration.js');
  const keys = ['DATABASE_URL', 'DATABASE_SSL_CA', 'DATABASE_SSL_REJECT_UNAUTHORIZED'];
  const previous = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, i) => previous[i] === undefined ? delete process.env[key] : process.env[key] = previous[i]));
  process.env.DATABASE_URL = 'postgresql://local@localhost/test?ssl=0&sslmode=disable&sslrootcert=bad&sslcert=bad&sslkey=bad';
  process.env.DATABASE_SSL_CA = 'first\\nsecond';
  delete process.env.DATABASE_SSL_REJECT_UNAUTHORIZED;
  const options = databaseConnectionOptions();
  assert.equal(new URL(options.connectionString).search, '');
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(options.ssl.ca, 'first\nsecond');
  process.env.DATABASE_SSL_REJECT_UNAUTHORIZED = 'false';
  assert.equal(databaseConnectionOptions().ssl.rejectUnauthorized, false);
});
