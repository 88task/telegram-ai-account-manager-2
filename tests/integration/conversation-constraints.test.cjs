const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openTestDatabase } = require('./helpers.cjs');

test('legacy conversation uniqueness upgrade preserves data and repairs worker upserts', async t => {
  const data = await openTestDatabase();
  t.after(() => data.close());
  await data.initDb();
  const upsert = text => data.db.insert(data.conversations).values({chatId:'42', lastMessageText:text})
    .onConflictDoUpdate({target:data.conversations.chatId, set:{lastMessageText:text}});
  await t.test('missing constraint is repaired even though the table already exists', async () => {
    await data.pool.query('ALTER TABLE conversations DROP CONSTRAINT conversations_chat_id_key');
    await data.initDb();
    await upsert('first');
    await upsert('updated');
    const rows = await data.db.select().from(data.conversations);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lastMessageText, 'updated');
  });
  await t.test('duplicate rows are archived with extra fields and review flags retained', async () => {
    await data.pool.query(`
      ALTER TABLE conversations DROP CONSTRAINT conversations_chat_id_unique;
      ALTER TABLE conversations ADD COLUMN legacy_extra TEXT;
      UPDATE conversations SET last_message_at = '2020-01-01', requires_human_review = true,
        unanswered = true, legacy_extra = 'preserve me' WHERE chat_id = '42';
      INSERT INTO conversations (chat_id, last_message_text, last_message_at, unanswered, requires_human_review)
        VALUES ('42', 'newest metadata', '2021-01-01', false, false), ('43', 'unrelated', '2021-01-01', false, false);
    `);
    await Promise.all([data.initDb(), data.initDb()]);
    const [row] = await data.db.select().from(data.conversations).where(data.eq(data.conversations.chatId,'42'));
    assert.equal(row.lastMessageText, 'newest metadata');
    assert.equal(row.requiresHumanReview, true);
    assert.equal(row.unanswered, true);
    const archived = await data.db.select().from(data.conversationDuplicateArchive);
    assert.equal(archived.length, 1);
    assert.equal(archived[0].originalRow.legacy_extra, 'preserve me');
    assert.equal(archived[0].originalRow.last_message_text, 'updated');
    await data.initDb();
    assert.equal((await data.db.select().from(data.conversationDuplicateArchive)).length, 1);
    assert.equal((await data.db.select().from(data.conversations)).length, 2);
    await Promise.all(Array.from({length:6},(_,i) => upsert(`concurrent ${i}`)));
    assert.equal((await data.db.select().from(data.conversations)).length, 2);
  });
  await t.test('archive failure rolls back the entire repair without losing duplicate rows', async () => {
    await data.pool.query(`
      ALTER TABLE conversations DROP CONSTRAINT conversations_chat_id_unique;
      ALTER TABLE conversations_duplicate_archive RENAME TO saved_conversation_archive;
      CREATE TABLE conversations_duplicate_archive (original_row INTEGER);
      INSERT INTO conversations (chat_id, last_message_text) VALUES ('42', 'rollback survivor');
    `);
    await assert.rejects(data.initDb(), /original_row/);
    assert.equal((await data.db.select().from(data.conversations).where(data.eq(data.conversations.chatId,'42'))).length, 2);
    await data.pool.query('DROP TABLE conversations_duplicate_archive; ALTER TABLE saved_conversation_archive RENAME TO conversations_duplicate_archive');
    await data.initDb();
    await upsert('recovered');
  });
  await t.test('an equivalent index with a different name is accepted', async () => {
    await data.pool.query('ALTER TABLE conversations DROP CONSTRAINT conversations_chat_id_unique; CREATE UNIQUE INDEX legacy_chat_uniqueness ON conversations(chat_id)');
    await data.initDb();
    await upsert('custom index');
    const {rows} = await data.pool.query("SELECT 1 FROM pg_constraint WHERE conrelid = 'conversations'::regclass AND conname = 'conversations_chat_id_unique'");
    assert.equal(rows.length, 0);
  });
  await t.test('a misleading nonunique message index prevents startup instead of dropping replies', async () => {
    await data.pool.query('DROP INDEX messages_chat_telegram_message_uidx; CREATE INDEX messages_chat_telegram_message_uidx ON messages(chat_id,telegram_message_id)');
    await assert.rejects(data.initDb(), error => error.code === '42P10');
    await data.pool.query('DROP INDEX messages_chat_telegram_message_uidx');
    await data.initDb();
  });
});
