// Loaded only by the HTTP integration test child; never sends provider traffic.
const { createRequire } = require('node:module');
const { Server } = require('node:http');
const requireWeb = createRequire(require.resolve('../../packages/web/package.json'));
const { TelegramClient, Api } = requireWeb('telegram');
const { StringSession } = requireWeb('telegram/sessions/index.js');
const password = requireWeb('telegram/Password.js');
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  this.once('listening', () => process.send?.({ type: 'ready', port: this.address().port }));
  return listen.apply(this, args);
};
TelegramClient.prototype.connect = async function () {};
TelegramClient.prototype.disconnect = async function () {};
TelegramClient.prototype.destroy = async function () { process.send?.({ type: 'destroyed' }); };
TelegramClient.prototype.getMe = async function () { return { id: 1n, firstName: 'Test' }; };
TelegramClient.prototype.addEventHandler = function () {};
TelegramClient.prototype.sendCode = async function (_config, phone) {
  process.send?.({ type: 'sending', phone });
  await new Promise(resolve => setTimeout(resolve, 80));
  if (phone === '+10000000000') throw new Error('Synthetic send-code failure');
  return { phoneCodeHash: 'synthetic-code-hash' };
};
TelegramClient.prototype.invoke = async function (request) {
  if (request instanceof Api.auth.SignIn) {
    if (request.phoneCode === '2fa') throw Object.assign(new Error('2FA required'), { errorMessage: 'SESSION_PASSWORD_NEEDED' });
    if (request.phoneCode !== '12345') throw new Error('Synthetic invalid code');
  }
  return {};
};
password.computeCheck = async () => new Api.InputCheckPasswordEmpty();
StringSession.prototype.save = function () {
  const address = Buffer.from('127.0.0.1');
  const length = Buffer.alloc(2); length.writeInt16BE(address.length);
  const port = Buffer.alloc(2); port.writeInt16BE(443);
  return '1' + Buffer.concat([Buffer.from([1]), length, address, port, Buffer.alloc(256, 1)]).toString('base64');
};

let nextMessageId = 1000;
TelegramClient.prototype.getInputEntity = async value => value;
TelegramClient.prototype.sendMessage = async function (_chat, options) {
  process.send?.({ type: 'delivered', text: options.message });
  return { id: nextMessageId++ };
};
TelegramClient.prototype.getMessages = async function (chatId, { ids }) {
  return [{ id: ids[0], chatId, reply: options => this.sendMessage(chatId, options) }];
};
