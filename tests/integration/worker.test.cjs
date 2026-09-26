const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { openTestDatabase } = require('./helpers.cjs');
const workerRequire = createRequire(require.resolve('../../packages/worker/package.json'));
const brainRequire = createRequire(require.resolve('../../packages/brain/package.json'));

test('Telegram event -> SQL -> brain -> reply/approval flows with provider stubs', async t => {
  const data = await openTestDatabase();
  t.after(() => data.close());
  process.env.TELEGRAM_API_ID = '12345';
  process.env.TELEGRAM_API_HASH = 'synthetic-test-hash';
  const { TelegramClient } = workerRequire('telegram');
  const { StringSession } = workerRequire('telegram/sessions/index.js');
  const { AuthKey } = workerRequire('telegram/crypto/AuthKey.js');
  const { BedrockRuntimeClient } = brainRequire('@aws-sdk/client-bedrock-runtime');
  const session = new StringSession('');
  session.setDC(1, '127.0.0.1', 443);
  session.authKey = new AuthKey();
  await session.authKey.setKey(Buffer.alloc(256, 1));
  let handler;
  let replies = [];
  let modelCalls = [];
  let critiquePass = true;
  const originals = new Map();
  t.mock.method(TelegramClient.prototype, 'connect', async () => {});
  t.mock.method(TelegramClient.prototype, 'getMe', async () => ({ id: 1n, firstName: 'Synthetic' }));
  t.mock.method(TelegramClient.prototype, 'disconnect', async () => {});
  t.mock.method(TelegramClient.prototype, 'destroy', async () => {});
  t.mock.method(TelegramClient.prototype, 'addEventHandler', cb => { handler = cb; });
  t.mock.method(TelegramClient.prototype, 'getMessages', async (chatId, { ids }) => ids.map(id => originals.get(`${chatId}:${id}`)));
  t.mock.method(TelegramClient.prototype, 'invoke', async () => {});
  t.mock.method(TelegramClient.prototype, 'downloadMedia', async () => Buffer.from('synthetic image'));
  t.mock.method(BedrockRuntimeClient.prototype, 'send', async command => {
    modelCalls.push(command.input);
    const prompt = command.input.messages[0].content.find(c => c.text)?.text || '';
    let result = 'Support response';
    if (prompt.includes('Analyze this incoming')) result = JSON.stringify({ primaryIntent: 'general_support', sentiment: 'neutral', urgency: 'medium', detectedDialect: 'en', implicitNeeds: [] });
    if (prompt.includes('chief compliance')) result = JSON.stringify({ passedHallucinationCheck: critiquePass, passedPolicyCheck: critiquePass, toneMatchesOwner: critiquePass, confidenceScore: 0.95, critiqueNotes: 'Synthetic pass' });
    if (prompt.includes('lead technical support')) result = JSON.stringify({ category: 'ambiguous_unclear', isAmbiguous: true, confidence: 0.5, identifiedIssue: 'Synthetic ambiguity' });
    return { output: { message: { content: [{ text: result }] } } };
  });
  const nativeTimeout = setTimeout;
  t.mock.method(global, 'setTimeout', (fn, ms, ...args) => nativeTimeout(fn, ms === 1500 ? 0 : ms, ...args));
  const { startWorker, stopWorker } = require('../../packages/worker/dist/index.js');
  t.after(() => stopWorker());
  await data.initDb();
  // Reproduce an existing production table that was created without chat uniqueness.
  await data.pool.query('ALTER TABLE conversations DROP CONSTRAINT conversations_chat_id_key; ALTER TABLE conversations ALTER COLUMN chat_jid SET NOT NULL');
  await data.initDb();
  await startWorker(session.save());
  assert.equal(typeof handler, 'function');
  const setting = (key, value) => data.db.insert(data.systemSettings).values({ key, value }).onConflictDoUpdate({ target: data.systemSettings.key, set: { value } });
  const event = (id, extra = {}) => { const result = { message: {
    id, chatId: '42', senderId: '42', text: 'When is the next task?', date: Math.floor(Date.now() / 1000) + id,
    reply: async options => { replies.push(options); return { id: id + 1000 }; },
    getSender: async () => ({ username: 'member' }), ...extra,
  } }; originals.set(`${result.message.chatId}:${id}`, result.message); return result; };
  await data.db.insert(data.knowledgeItems).values({ category: 'rule', content: 'Synthetic knowledge rule' });
  await setting('operating_mode', 'auto_pilot');
  await t.test('simultaneous duplicate events produce one stored event, evaluation and reply', async () => {
    await Promise.all(Array.from({ length: 5 }, () => handler(event(7))));
    assert.equal(replies.length, 1);
    assert.equal(modelCalls.length, 3);
    assert.ok(modelCalls.some(c => c.system?.[0]?.text.includes('Synthetic knowledge rule')));
    assert.equal((await data.db.select().from(data.messages).where(data.eq(data.messages.isOutgoing, false))).length, 1);
    assert.equal((await data.db.select().from(data.messages).where(data.eq(data.messages.isOutgoing, true))).length, 1);
    assert.equal((await data.db.select().from(data.auditLogs)).length, 2);
    assert.equal((await data.db.select().from(data.conversations))[0].unanswered, false);
    await handler(event(7));
    assert.equal(replies.length, 1);
  });
  await t.test('concurrent distinct events in a new chat retain both messages', async () => {
    await Promise.all([handler(event(8, { chatId: '44' })), handler(event(9, { chatId: '44' }))]);
    assert.equal(replies.length, 3);
    assert.equal((await data.db.select().from(data.conversations).where(data.eq(data.conversations.chatId, '44'))).length, 1);
  });
  await t.test('draft, moderation, group scope, kill switch and outgoing guards', async () => {
    await setting('operating_mode', 'draft');
    await handler(event(10));
    assert.equal((await data.db.select().from(data.approvalQueue)).length, 1);
    await setting('operating_mode', 'auto_pilot');
    await handler(event(11, { text: 'fuck you' }));
    assert.equal((await data.db.select().from(data.approvalQueue)).length, 2);
    await handler(event(12, { chatId: '-99', isGroup: true }));
    await setting('emergency_kill_switch', 'true');
    await handler(event(13));
    await handler(event(14, { out: true }));
    assert.equal(replies.length, 3);
    await setting('emergency_kill_switch', 'false');
    await setting('allowed_group_ids', '-99');
    await handler(event(15, { chatId: '-99', senderId: '45', isGroup: true }));
    assert.equal(replies.length, 4);
    assert.equal(replies[3].message, '@member Support response');
    await setting('blocked_user_ids', '45');
    await handler(event(16, { chatId: '-99', senderId: '45', isGroup: true }));
    assert.equal(replies.length, 4);
    await handler(event(17, { senderId: '46', photo: true, media: { className: 'MessageMediaPhoto' } }));
    assert.equal(replies.length, 4); // ambiguous screenshot is ignored
  });
  await t.test('real history, manual drafts, contact blocks and late kill switch', async () => {
    const before = replies.length;
    await data.db.insert(data.messages).values({ chatId: '88', senderId: '1', telegramMessageId: 49, text: 'Earlier owner context', isOutgoing: true, createdAt: new Date(Date.now() - 60000) });
    await data.db.insert(data.contacts).values({ telegramUserId: '88', notes: 'Synthetic contact note', customInstructions: 'Use brief replies' });
    await handler(event(50, { chatId: '88', senderId: '88' }));
    assert.equal(replies.length, before + 1);
    assert.ok(modelCalls.some(call => call.messages.some(message => message.content.some(part => part.text === 'Earlier owner context'))));
    assert.ok(modelCalls.some(call => call.system?.[0]?.text.includes('Synthetic contact note')));
    await setting('operating_mode', 'manual');
    await handler(event(51, { chatId: '88', senderId: '88' }));
    assert.ok((await data.db.select().from(data.approvalQueue)).some(row => row.incomingMessageId === 51 && row.status === 'pending'));
    await setting('operating_mode', 'auto_pilot');
    await data.db.update(data.contacts).set({ isBlocked: true }).where(data.eq(data.contacts.telegramUserId, '88'));
    await handler(event(52, { chatId: '88', senderId: '88' }));
    assert.equal(replies.length, before + 1);
    const invoke = t.mock.method(TelegramClient.prototype, 'invoke', async () => { await setting('emergency_kill_switch', 'true'); });
    await handler(event(53, { chatId: '89', senderId: '89' }));
    assert.equal(replies.length, before + 1, 'Kill switch changed during typing must prevent delivery');
    assert.ok((await data.db.select().from(data.approvalQueue)).some(row => row.incomingMessageId === 53 && row.status === 'pending'));
    invoke.mock.restore();
    await setting('emergency_kill_switch', 'false');
  });
  await t.test('failed high-confidence critique and stale inbound messages never auto-send', async () => {
    const before = replies.length;
    critiquePass = false;
    await handler(event(54, { chatId: '90', senderId: '90' }));
    critiquePass = true;
    assert.equal(replies.length, before);
    assert.ok((await data.db.select().from(data.approvalQueue)).some(row => row.incomingMessageId === 54 && row.status === 'pending'));
    await data.db.insert(data.messages).values({ chatId: '91', senderId: '1', telegramMessageId: 99, text: 'Already answered', isOutgoing: true, createdAt: new Date(Date.now() + 120000) });
    await handler(event(55, { chatId: '91', senderId: '91' }));
    assert.equal(replies.length, before);
  });
  await t.test('audit failure after confirmed automatic delivery does not enqueue a second reply', async () => {
    await data.pool.query(`CREATE FUNCTION fail_delivery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'auto_sent' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_delivery_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_delivery_audit();`);
    const before = replies.length;
    await handler(event(56, { chatId: '92', senderId: '92' }));
    assert.equal(replies.length, before + 1);
    assert.ok(!(await data.db.select().from(data.approvalQueue)).some(row => row.incomingMessageId === 56));
    await data.pool.query('DROP TRIGGER fail_delivery_audit ON audit_logs');
  });
  await t.test('database recording failure fails closed and rolls back event claim', async () => {
    await data.pool.query(`CREATE FUNCTION reject_conversation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
      CREATE TRIGGER reject_conversation BEFORE INSERT ON conversations FOR EACH ROW EXECUTE FUNCTION reject_conversation();`);
    const before = modelCalls.length;
    const previousReplies = replies.length;
    await handler(event(18, { senderId: '47' }));
    assert.equal(modelCalls.length, before);
    assert.equal((await data.db.select().from(data.messages).where(data.eq(data.messages.telegramMessageId, 18))).length, 0);
    await data.pool.query('DROP TRIGGER reject_conversation ON conversations');
    await handler(event(18, { senderId: '47' }));
    assert.equal(replies.length, previousReplies + 1);
  });  await t.test('legacy sessions fail with an explicit configuration error when encryption is unavailable', async () => {
    await stopWorker();
    await data.db.insert(data.telegramSessions).values({ userId: 'legacy', phone: '+10000000001', encryptedSessionString: session.save(), isActive: true });
    const previousKey = process.env.SESSION_ENCRYPTION_KEY;
    process.env.SESSION_ENCRYPTION_KEY = 'invalid';
    try {
      await assert.rejects(startWorker(), /Unable to load Telegram session.*SESSION_ENCRYPTION_KEY/);
    } finally {
      previousKey === undefined ? delete process.env.SESSION_ENCRYPTION_KEY : process.env.SESSION_ENCRYPTION_KEY = previousKey;
    }
  });

});
