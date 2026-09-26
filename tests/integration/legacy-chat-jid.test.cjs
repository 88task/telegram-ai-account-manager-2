const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openTestDatabase } = require('./helpers.cjs');

test('legacy chat_jid remains preserved but is not required for Telegram writes', async t => {
  const data = await openTestDatabase();
  t.after(() => data.close());
  await data.pool.query(`
    CREATE TABLE conversations (
      id SERIAL PRIMARY KEY,
      chat_jid TEXT NOT NULL UNIQUE,
      chat_type TEXT NOT NULL DEFAULT 'private',
      legacy_note TEXT NOT NULL DEFAULT 'original'
    );
    INSERT INTO conversations (chat_jid) VALUES ('legacy-chat-a');
  `);
  await data.initDb();
  await data.db.transaction(async tx => {
    await tx.insert(data.messages).values({chatId:'42',telegramMessageId:1,senderId:'42',isOutgoing:false})
      .onConflictDoNothing({target:[data.messages.chatId,data.messages.telegramMessageId]});
    await tx.insert(data.conversations).values({chatId:'42',lastMessageText:'incoming'})
      .onConflictDoUpdate({target:data.conversations.chatId,set:{lastMessageText:'incoming'}});
  });
  const {rows} = await data.pool.query('SELECT chat_id, chat_jid, legacy_note FROM conversations ORDER BY id');
  assert.deepEqual(rows, [
    {chat_id:null,chat_jid:'legacy-chat-a',legacy_note:'original'},
    {chat_id:'42',chat_jid:null,legacy_note:'original'},
  ]);
  await t.test('repeated and concurrent initialization preserves legacy values and constraints', async () => {
    await Promise.all([data.initDb(), data.initDb()]);
    await data.db.insert(data.conversations).values({chatId:'43'});
    await assert.rejects(data.pool.query("INSERT INTO conversations (chat_id, chat_type) VALUES ('bad', NULL)"), error => error.code === '23502');
    await assert.rejects(data.pool.query("INSERT INTO conversations (chat_jid) VALUES ('legacy-chat-a')"), error => error.code === '23505');
    const {rows: [legacy]} = await data.pool.query("SELECT chat_jid, legacy_note FROM conversations WHERE id = 1");
    assert.deepEqual(legacy, {chat_jid:'legacy-chat-a',legacy_note:'original'});
  });
  await t.test('other required legacy columns are identified at startup without relaxing their constraints', async () => {
    await data.pool.query('ALTER TABLE conversations ALTER COLUMN legacy_note DROP DEFAULT');
    await assert.rejects(data.initDb(), /conversations requires omitted columns \(legacy_note\)/);
    const {rows: [column]} = await data.pool.query("SELECT attnotnull FROM pg_attribute WHERE attrelid = 'conversations'::regclass AND attname = 'legacy_note'");
    assert.equal(column.attnotnull, true);
    await data.pool.query("ALTER TABLE conversations ALTER COLUMN legacy_note SET DEFAULT 'original'");
    await data.initDb();
  });
  await t.test('a later migration failure rolls back the chat_jid nullability change', async () => {
    await data.pool.query(`
      DELETE FROM conversations WHERE chat_jid IS NULL;
      ALTER TABLE conversations ALTER COLUMN chat_jid SET NOT NULL;
      DROP INDEX messages_chat_telegram_message_uidx;
      CREATE INDEX messages_chat_telegram_message_uidx ON messages(chat_id,telegram_message_id);
    `);
    await assert.rejects(data.initDb(), error => error.code === '42P10');
    const {rows: [column]} = await data.pool.query("SELECT attnotnull FROM pg_attribute WHERE attrelid = 'conversations'::regclass AND attname = 'chat_jid'");
    assert.equal(column.attnotnull, true);
    assert.equal((await data.pool.query('SELECT * FROM conversations')).rows.length, 1);
    await data.pool.query('DROP INDEX messages_chat_telegram_message_uidx');
    await data.initDb();
    await data.db.insert(data.conversations).values({chatId:'44'});
  });
});
