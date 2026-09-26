const { test } = require('node:test');
const assert = require('node:assert/strict');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { openTestDatabase } = require('./helpers.cjs');

test('schema creation, upgrade, deduplication, concurrent startup and rollback', async t => {
  const db = await openTestDatabase();
  t.after(() => db.close());
  await t.test('fresh initialization matches every ORM table', async () => {
    await db.initDb();
    for (const table of [db.conversations, db.messages, db.contacts, db.telegramSessions, db.approvalQueue, db.knowledgeItems, db.auditLogs, db.systemSettings, db.messageDuplicateArchive, db.moderationStates]) {
      assert.deepEqual(await db.db.select().from(table), []);
    }
    const rows = await db.db.insert(db.conversations).values({ chatId: '42' }).returning();
    assert.equal(rows[0].accountKey, 'default');
  });
  await t.test('upgrade restores missing columns and preserves duplicate contents in archive', async () => {
    await db.pool.query(`
      DROP INDEX messages_chat_telegram_message_uidx;
      ALTER TABLE conversations DROP COLUMN account_key;
      ALTER TABLE messages DROP COLUMN media_url;
      ALTER TABLE contacts DROP COLUMN notes;
      ALTER TABLE messages ADD COLUMN legacy_extra TEXT;
      INSERT INTO messages (telegram_message_id, chat_id, sender_id, is_outgoing, text, legacy_extra)
        VALUES (7, '42', '42', false, 'original', 'original extra'),
               (7, '42', '42', false, 'duplicate payload', 'preserve me'),
               (7, '43', '43', false, 'other chat', null);
    `);
    await Promise.all([db.initDb(), db.initDb(), execFile(process.execPath, [require.resolve('../../packages/db/dist/migrate.js')])]);
    const rows = await db.db.select().from(db.messages).orderBy(db.messages.id);
    assert.deepEqual(rows.map(r => r.text), ['original', 'other chat']);
    assert.equal((await db.db.select().from(db.conversations))[0].accountKey, 'default');
    assert.deepEqual(await db.db.select().from(db.contacts), []);
    const archived = await db.pool.query('SELECT original_row FROM messages_duplicate_archive');
    assert.equal(archived.rows.length, 1);
    assert.equal(archived.rows[0].original_row.text, 'duplicate payload');
    assert.equal(archived.rows[0].original_row.legacy_extra, 'preserve me');
    const results = await Promise.all(Array.from({ length: 6 }, () => db.db.insert(db.messages).values({
      telegramMessageId: 99, chatId: '42', senderId: '42', isOutgoing: false,
    }).onConflictDoNothing({ target: [db.messages.chatId, db.messages.telegramMessageId] }).returning()));
    assert.equal(results.flat().length, 1);
    await db.initDb();
    assert.equal((await db.pool.query('SELECT * FROM messages_duplicate_archive')).rows.length, 1);
  });
  await t.test('migration failure rolls back data moves and column changes', async () => {
    await db.pool.query(`
      DROP INDEX messages_chat_telegram_message_uidx;
      ALTER TABLE conversations DROP COLUMN account_key;
      ALTER TABLE messages_duplicate_archive RENAME TO saved_archive;
      CREATE TABLE messages_duplicate_archive (original_row INTEGER);
      INSERT INTO messages (telegram_message_id, chat_id, sender_id, is_outgoing, text)
        VALUES (7, '42', '42', false, 'must survive failed migration');
    `);
    await assert.rejects(db.initDb(), /original_row/);
    assert.equal((await db.pool.query("SELECT * FROM messages WHERE text = 'must survive failed migration'")).rows.length, 1);
    assert.equal((await db.pool.query("SELECT * FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'conversations' AND column_name = 'account_key'", [db.schema])).rows.length, 0);
    await db.pool.query('DROP TABLE messages_duplicate_archive; ALTER TABLE saved_archive RENAME TO messages_duplicate_archive');
    await db.initDb();
  });
});
