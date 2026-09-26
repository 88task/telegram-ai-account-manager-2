const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { randomBytes } = require('node:crypto');
const dbRequire = createRequire(require.resolve('../../packages/db/package.json'));

exports.openTestDatabase = async function () {
  assert.ok(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a disposable PostgreSQL database with TLS enabled');
  const { Pool } = dbRequire('pg');
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.delete('sslmode');
  const admin = new Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });
  const schema = `regression_${process.pid}_${randomBytes(5).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.DATABASE_SSL_REJECT_UNAUTHORIZED = 'false';
  const database = require('../../packages/db/dist/index.js');
  return {
    ...database,
    schema,
    async close() {
      await database.pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
};
