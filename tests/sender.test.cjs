const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const workerRequire = createRequire(require.resolve('../packages/worker/package.json'));
const { Api } = workerRequire('telegram');
const { TelegramSender } = require('../packages/worker/dist/sender.js');

for (const [label, target, mentioned] of [
  ['DM overrides wrong group flags', { chatId: '42', isGroup: true }, false],
  ['negative marked group', { chatId: '-42' }, true],
  ['supergroup', { chatId: '-10042', isChannel: true }, true],
  ['uncached peer chat with positive message id', { peerId: new Api.PeerChat({ chatId: 42n }), id: 123, isGroup: true }, true],
  ['uncached peer channel', { peerId: new Api.PeerChannel({ channelId: 42n }), id: 123 }, true],
  ['raw chat entity id is not a user id', { chat: new Api.Chat({ id: 42n, title: 'Test' }), isGroup: true, id: 123 }, true],
  ['group flag with only message and sender IDs', { id: 123, senderId: '42', isGroup: true }, true],
]) {
  test(label, async t => {
    // Bypass only the cosmetic delay; keep peer resolution and send code real.
    const nativeTimeout = setTimeout;
    t.mock.method(global, 'setTimeout', (fn, ms, ...args) => nativeTimeout(fn, ms === 1500 ? 0 : ms, ...args));
    let sent;
    const sender = new TelegramSender({ invoke: async () => {}, sendMessage: async (_peer, opts) => { sent = opts; return { id: 999 }; } });
    const result = await sender.sendReply({ ...target, getSender: async () => ({ username: 'member' }) }, 'Hello');
    assert.equal(result, 999);
    assert.equal(sent.message, mentioned ? '@member Hello' : 'Hello');
    if (target.id) assert.equal(sent.replyTo, target.id);
  });
}

test('quote reply, uncertain delivery, typing failure and string peers', async t => {
  const nativeTimeout = setTimeout;
  t.mock.method(global, 'setTimeout', (fn, ms, ...args) => nativeTimeout(fn, ms === 1500 ? 0 : ms, ...args));
  let sent;
  const sender = new TelegramSender({
    invoke: async () => { throw new Error('typing unavailable'); },
    getInputEntity: async id => ({ resolved: id }),
    sendMessage: async (peer, opts) => { sent = { peer, ...opts }; return { id: 999 }; },
  });
  assert.equal(await sender.sendReply({ chatId: '42', reply: async () => ({ id: 888 }) }, 'Hi'), 888);
  await assert.rejects(sender.sendReply({ chatId: '-42', id: 7, reply: async () => { throw new Error('connection lost after send'); } }, 'Hi'), /connection lost/);
  assert.equal(sent, undefined, 'An uncertain reply must not trigger a second send');
  await assert.rejects(sender.sendReply('42', 'Hi', async () => { throw new Error('kill switch'); }), /kill switch/);
  assert.equal(sent, undefined, 'Final guard must prevent network delivery');
  await sender.sendReply('42', 'Hi');
  assert.deepEqual(sent, { peer: { resolved: '42' }, message: 'Hi' });
});
