const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { openTestDatabase } = require('./helpers.cjs');

function launch(env) {
  const child = fork(require.resolve('../../packages/web/dist/server.js'), [], {
    execArgv: ['--require', require.resolve('./telegram-fixture.cjs')],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: '0', NODE_ENV: 'test', PANEL_USERNAME: 'test', PANEL_PASSWORD: 'synthetic-test-password', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  return { child, logs: () => logs };
}

test('compiled web server APIs, static dashboard and login lifecycle', { timeout: 20000 }, async t => {
  const data = await openTestDatabase();
  t.after(() => data.close());
  const { child, logs } = launch({ DATABASE_URL: process.env.DATABASE_URL, TELEGRAM_API_ID: '12345', TELEGRAM_API_HASH: 'synthetic', SESSION_ENCRYPTION_KEY: randomBytes(32).toString('hex') });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  let destroyed = 0;
  child.on('message', msg => { if (msg.type === 'destroyed') destroyed++; });
  const ready = await Promise.race([
    new Promise(resolve => child.on('message', msg => { if (msg.type === 'ready') resolve(msg); })),
    once(child, 'exit').then(() => { throw new Error(`Server failed: ${logs()}`); }),
  ]);
  const auth = { Authorization: 'Basic ' + Buffer.from('test:synthetic-test-password').toString('base64') };
  const base = `http://127.0.0.1:${ready.port}`;
  async function api(path, body, method = 'POST') {
    const response = await fetch(base + path, body === undefined ? { headers: auth } : { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  await t.test('compiled dashboard and all read APIs load without broken imports/schema errors', async () => {
    assert.equal((await fetch(base)).status, 401);
    const page = await fetch(base, { headers: auth });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<!DOCTYPE html>/i);
    for (const path of ['/api/stats', '/api/conversations', '/api/conversations/42/messages', '/api/approvals', '/api/knowledge', '/api/audit-logs', '/api/gemini/settings']) {
      const result = await api(path);
      assert.equal(result.status, 200, path + JSON.stringify(result.body));
      assert.equal(result.body.success, true);
    }
  });
  await t.test('settings, knowledge, approvals and audit persistence', async () => {
    assert.equal((await api('/api/settings', { operatingMode: 'draft', emergencyKillSwitch: true })).status, 200);
    const stats = await api('/api/stats');
    assert.equal(stats.body.data.settings.operatingMode, 'draft');
    assert.equal(stats.body.data.settings.emergencyKillSwitch, true);
    await api('/api/knowledge', { category: 'rule', content: 'Synthetic API rule' });
    const knowledge = await api('/api/knowledge');
    assert.equal(knowledge.body.data[0].content, 'Synthetic API rule');
    await api('/api/knowledge/' + knowledge.body.data[0].id, {}, 'DELETE');
    const [approval] = await data.db.insert(data.approvalQueue).values({ chatId: '42', incomingMessageId: 1, suggestedReply: 'Draft', aiConfidence: 0.6, aiReasoning: 'Review needed' }).returning();
    assert.equal((await api(`/api/approvals/${approval.id}/decide`, { action: 'edit', editedReply: 'Human correction' })).status, 502);
    assert.equal((await data.db.select().from(data.approvalQueue))[0].status, 'pending');
    assert.ok((await api('/api/audit-logs')).body.data.some(row => row.eventType === 'settings_updated'));
  });
  await t.test('failed code sends dispose clients; same-phone requests cannot overlap', async () => {
    for (const route of ['send-code', 'verify-code', 'submit-password']) {
      assert.equal((await api('/api/auth/' + route, { phone: '   ' })).status, 400);
    }
    const failed = await api('/api/auth/send-code', { phone: '+10000000000' });
    assert.equal(failed.status, 500);
    if (destroyed === 0) await new Promise((resolve, reject) => {
      const listener = msg => { if (msg.type === 'destroyed') { clearTimeout(timer); child.off('message', listener); resolve(); } };
      const timer = setTimeout(() => { child.off('message', listener); reject(new Error('Login client cleanup timed out')); }, 2000);
      child.on('message', listener);
    });
    assert.equal(destroyed, 1);
    const sending = new Promise(resolve => child.on('message', msg => { if (msg.type === 'sending' && msg.phone === '+10000000001') resolve(); }));
    const first = api('/api/auth/send-code', { phone: '+10000000001' });
    await sending;
    assert.equal((await api('/api/auth/send-code', { phone: '+10000000001' })).status, 409);
    assert.equal((await first).status, 200);
    assert.equal((await api('/api/auth/verify-code', { phone: '+10000000001', code: 'invalid' })).status, 400);
    assert.equal((await api('/api/auth/verify-code', { phone: '+10000000001', code: '12345' })).status, 200);
    const sessions = await data.db.select().from(data.telegramSessions);
    assert.equal(sessions.length, 1);
    assert.ok(sessions[0].encryptedSessionString.startsWith('enc:'));
    assert.equal((await api('/api/auth/verify-code', { phone: '+10000000001', code: '12345' })).status, 400);
  });
  await t.test('authenticated manual/approval delivery and concurrent decision claims', async () => {
    const forbidden = await fetch(base + '/api/settings', { method: 'POST', headers: { ...auth, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(forbidden.status, 403);
    await api('/api/settings', { emergencyKillSwitch: false });
    const [approval] = await data.db.select().from(data.approvalQueue);
    await data.pool.query(`CREATE FUNCTION fail_delivery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type LIKE 'human_%' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_delivery_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_delivery_audit();`);
    const decisions = await Promise.all([api(`/api/approvals/${approval.id}/decide`, { action: 'edit', editedReply: 'Human correction' }), api(`/api/approvals/${approval.id}/decide`, { action: 'edit', editedReply: 'Human correction' })]);
    assert.deepEqual(decisions.map(d => d.status).sort(), [200, 409]);
    assert.equal((await data.db.select().from(data.approvalQueue))[0].status, 'edited');
    await data.pool.query('DROP TRIGGER fail_delivery_audit ON audit_logs');
    const [memory] = await data.db.select().from(data.knowledgeItems);
    assert.equal(JSON.parse(memory.content).approvedVersion, 'Human correction');
    const [stale] = await data.db.insert(data.approvalQueue).values({ chatId: '42', incomingMessageId: 2, suggestedReply: 'Old pending draft', aiConfidence: 0.6, aiReasoning: 'Synthetic review' }).returning();
    await data.db.insert(data.conversations).values({ chatId: '42', requiresHumanReview: true }).onConflictDoNothing();
    const manual = api('/api/conversations/42/send', { text: 'Manual reply' });
    const deadline = Date.now() + 5000;
    while ((await data.db.select().from(data.approvalQueue).where(data.eq(data.approvalQueue.id, stale.id)))[0].status === 'pending') {
      assert.ok(Date.now() < deadline, 'Manual send must claim existing drafts');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await api(`/api/approvals/${stale.id}/decide`, { action: 'approve' })).status, 409);
    const [later] = await data.db.insert(data.approvalQueue).values({ chatId: '42', incomingMessageId: 3, suggestedReply: 'New draft', aiConfidence: 0.5, aiReasoning: 'New inquiry' }).returning();
    assert.equal((await manual).status, 200);
    assert.equal((await data.db.select().from(data.approvalQueue).where(data.eq(data.approvalQueue.id, later.id)))[0].status, 'pending');
    assert.equal((await data.db.select().from(data.conversations).where(data.eq(data.conversations.chatId, '42')))[0].requiresHumanReview, true);
    assert.equal((await data.db.select().from(data.approvalQueue).where(data.eq(data.approvalQueue.id, stale.id)))[0].status, 'superseded');
    assert.equal((await api(`/api/approvals/${stale.id}/decide`, { action: 'approve' })).status, 409);
    assert.equal((await data.db.select().from(data.messages).where(data.eq(data.messages.isOutgoing, true))).length, 2);
    await api('/api/settings', { emergencyKillSwitch: true });
    assert.equal((await api('/api/conversations/42/send', { text: 'Should be blocked' })).status, 502);
  });
  await t.test('2FA handoff, session replacement and disconnect', async () => {
    await api('/api/auth/send-code', { phone: '+10000000002' });
    const twoFA = await api('/api/auth/verify-code', { phone: '+10000000002', code: '2fa' });
    assert.equal(twoFA.body.requiresPassword, true);
    assert.equal((await api('/api/auth/submit-password', { phone: '+10000000002', password: 'synthetic' })).status, 200);
    assert.equal((await data.db.select().from(data.telegramSessions).where(data.eq(data.telegramSessions.isActive, true))).length, 1);
    assert.equal((await api('/api/auth/disconnect', {})).status, 200);
    assert.equal((await data.db.select().from(data.telegramSessions).where(data.eq(data.telegramSessions.isActive, true))).length, 0);
  });
  assert.doesNotMatch(logs(), /UnhandledPromiseRejection|ERR_MODULE_NOT_FOUND|uncaughtException/);
});

test('database initialization failure terminates startup', { timeout: 10000 }, async () => {
  const { child, logs } = launch({ DATABASE_URL: 'postgresql://review@127.0.0.1:1/unavailable' });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(logs(), /Failed to initialize database tables/);
});
