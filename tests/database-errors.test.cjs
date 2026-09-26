const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pool, initDb } = require('../packages/db/dist/index.js');

for (const rollbackFails of [false, true]) {
  test(`migration keeps original error; rollback failure=${rollbackFails}`, async t => {
    const original = new Error('migration failed');
    let released;
    t.mock.method(pool, 'connect', async () => ({
      query: async sql => {
        if (sql === 'BEGIN') return;
        if (sql === 'ROLLBACK') {
          if (rollbackFails) throw new Error('connection lost during rollback');
          return;
        }
        throw original;
      },
      release: discard => { released = discard; },
    }));
    await assert.rejects(initDb(), error => error === original);
    assert.equal(released, rollbackFails);
  });
}
