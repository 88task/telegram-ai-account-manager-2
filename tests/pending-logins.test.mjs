import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PendingLogins, disposeLoginClient } from '../packages/web/dist/pending-logins.js';
const entry = (client, createdAt = Date.now()) => ({ client, createdAt, phone: 'test', phoneCodeHash: 'synthetic' });

test('cleanup contains asynchronous rejection and removes entry', async () => {
  const store = new PendingLogins();
  store.set('test', entry({ destroy: async () => { throw new Error('disconnect failed'); } }));
  await store.cleanup('test');
  assert.equal(await store.get('test'), undefined);
  await disposeLoginClient({ destroy: async () => { throw new Error('failed during connect'); } });
});
test('cleanup completion cannot delete a replacement entry', async () => {
  const store = new PendingLogins();
  let finish;
  store.set('test', entry({ destroy: () => new Promise(resolve => { finish = resolve; }) }));
  const cleanup = store.cleanup('test');
  const replacement = entry({ destroy: async () => {} });
  store.set('test', replacement);
  finish();
  await cleanup;
  assert.equal(await store.get('test'), replacement);
});
test('expiration skips active verification and rejects expired sessions on access', async () => {
  const store = new PendingLogins(1000);
  let destroyed = 0;
  store.set('test', entry({ destroy: async () => { destroyed++; } }, Date.now() - 2000));
  const release = store.acquire('test');
  assert.equal(store.acquire('test'), undefined);
  const other = store.acquire('other');
  assert.ok(other);
  await store.cleanupExpired();
  assert.equal(destroyed, 0);
  release(); other();
  await store.cleanupExpired();
  assert.equal(destroyed, 1);
  assert.equal(await store.get('test'), undefined);
  store.set('test', entry({ destroy: async () => { destroyed++; } }, Date.now() - 2000));
  assert.equal(await store.get('test'), undefined);
  assert.equal(destroyed, 2);
});
test('fresh sessions survive the sweeper', async () => {
  const store = new PendingLogins();
  const fresh = entry({ destroy: async () => { assert.fail('fresh session destroyed'); } });
  store.set('test', fresh);
  await store.cleanupExpired();
  assert.equal(await store.get('test'), fresh);
});
