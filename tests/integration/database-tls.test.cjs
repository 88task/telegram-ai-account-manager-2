const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openTestDatabase } = require('./helpers.cjs');

test('database startup works without a CA and keeps the connection encrypted', async t => {
  delete process.env.DATABASE_SSL_CA;
  delete process.env.DATABASE_SSL_REJECT_UNAUTHORIZED;
  const data = await openTestDatabase();
  t.after(() => data.close());
  await data.initDb();
  const { rows: [connection] } = await data.pool.query(
    'SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()'
  );
  assert.equal(connection.ssl, true);
  assert.match(connection.version, /^TLS/);
  assert.ok(connection.cipher);
  assert.equal(data.pool.options.ssl.rejectUnauthorized, false);
  assert.equal(data.pool.options.ssl.ca, undefined);
});
