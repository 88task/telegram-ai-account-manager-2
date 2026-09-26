import 'dotenv/config';
import { databaseConnectionOptions } from './configuration.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const { Pool } = pg;

export const pool = new Pool(databaseConnectionOptions());

export const db = drizzle(pool, { schema });
export * from './schema.js';
export * from './configuration.js';
export * from 'drizzle-orm';

export async function initDb(): Promise<void> {
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query('BEGIN');
    // Serialize startup migrations across the web and standalone worker processes.
    await client.query('SELECT pg_advisory_xact_lock(817246031)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS telegram_sessions (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        phone TEXT NOT NULL,
        encrypted_session_string TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        telegram_user_id TEXT NOT NULL UNIQUE,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        phone TEXT,
        notes TEXT,
        custom_instructions TEXT,
        is_blocked BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL UNIQUE,
        account_key TEXT DEFAULT 'default',
        chat_title TEXT,
        chat_type TEXT NOT NULL DEFAULT 'private',
        last_message_text TEXT,
        last_message_at TIMESTAMP NOT NULL DEFAULT NOW(),
        unanswered BOOLEAN NOT NULL DEFAULT false,
        requires_human_review BOOLEAN NOT NULL DEFAULT false
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        telegram_message_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        text TEXT,
        is_outgoing BOOLEAN NOT NULL,
        media_type TEXT,
        media_url TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS approval_queue (
        id SERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        incoming_message_id INTEGER NOT NULL,
        suggested_reply TEXT NOT NULL,
        edited_reply TEXT,
        ai_confidence DOUBLE PRECISION NOT NULL,
        ai_reasoning TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        reviewed_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS knowledge_items (
        id SERIAL PRIMARY KEY,
        category TEXT NOT NULL,
        question_or_trigger TEXT,
        content TEXT NOT NULL,
        tags TEXT[],
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        chat_id TEXT,
        action_taken TEXT NOT NULL,
        details JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS system_settings (
        id SERIAL PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS moderation_states (key TEXT PRIMARY KEY, state JSONB NOT NULL);

      -- Comprehensive column backfill for pre-existing tables
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS id SERIAL;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS chat_id TEXT;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS chat_title TEXT;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS chat_type TEXT DEFAULT 'private';
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_text TEXT;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMP DEFAULT NOW();
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS unanswered BOOLEAN DEFAULT false;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS requires_human_review BOOLEAN DEFAULT false;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS account_key TEXT DEFAULT 'default';
      ALTER TABLE conversations ALTER COLUMN account_key SET DEFAULT 'default';

      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS id SERIAL;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS telegram_user_id TEXT;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS username TEXT;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS first_name TEXT;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_name TEXT;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone TEXT;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notes TEXT;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS custom_instructions TEXT;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT false;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

      ALTER TABLE messages ADD COLUMN IF NOT EXISTS id SERIAL;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS telegram_message_id INTEGER;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS chat_id TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_id TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS text TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_outgoing BOOLEAN DEFAULT false;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_type TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_url TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

      ALTER TABLE approval_queue ADD COLUMN IF NOT EXISTS id SERIAL;
      ALTER TABLE approval_queue ADD COLUMN IF NOT EXISTS chat_id TEXT;
      ALTER TABLE approval_queue ADD COLUMN IF NOT EXISTS incoming_message_id INTEGER;
      ALTER TABLE approval_queue ADD COLUMN IF NOT EXISTS suggested_reply TEXT;
      ALTER TABLE approval_queue ADD COLUMN IF NOT EXISTS edited_reply TEXT;
      ALTER TABLE approval_queue ADD COLUMN IF NOT EXISTS ai_confidence DOUBLE PRECISION;
      ALTER TABLE approval_queue ADD COLUMN IF NOT EXISTS ai_reasoning TEXT;
      ALTER TABLE approval_queue ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
      ALTER TABLE approval_queue ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;
      ALTER TABLE approval_queue ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

      ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS id SERIAL;
      ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS category TEXT;
      ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS question_or_trigger TEXT;
      ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS content TEXT;
      ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS tags TEXT[];
      ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

      ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS id SERIAL;
      ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS event_type TEXT;
      ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS chat_id TEXT;
      ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS action_taken TEXT;
      ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS details JSONB;
      ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

      ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS id SERIAL;
      ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS key TEXT;
      ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS value TEXT;
      ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

      ALTER TABLE telegram_sessions ADD COLUMN IF NOT EXISTS id SERIAL;
      ALTER TABLE telegram_sessions ADD COLUMN IF NOT EXISTS user_id TEXT;
      ALTER TABLE telegram_sessions ADD COLUMN IF NOT EXISTS phone TEXT;
      ALTER TABLE telegram_sessions ADD COLUMN IF NOT EXISTS encrypted_session_string TEXT;
      ALTER TABLE telegram_sessions ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
      ALTER TABLE telegram_sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
      ALTER TABLE telegram_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

      CREATE TABLE IF NOT EXISTS messages_duplicate_archive (
        archive_id BIGSERIAL PRIMARY KEY,
        archived_at TIMESTAMP NOT NULL DEFAULT NOW(),
        original_row JSONB NOT NULL
      );

      -- Deduplication is a one-time upgrade, not a full history scan on every login.
      DO $$ BEGIN
        IF to_regclass('messages_chat_telegram_message_uidx') IS NULL THEN
          LOCK TABLE messages IN ACCESS EXCLUSIVE MODE;
          -- Old releases allowed repeated delivery of the same Telegram event. Keep
          -- the oldest row live and preserve every other row in a recovery archive.
          WITH duplicates AS (
            SELECT ctid, ROW_NUMBER() OVER (
              PARTITION BY chat_id, telegram_message_id ORDER BY id, ctid
            ) AS occurrence
            FROM messages
            WHERE chat_id IS NOT NULL AND telegram_message_id IS NOT NULL
          ), archived AS (
            DELETE FROM messages
            WHERE ctid IN (SELECT ctid FROM duplicates WHERE occurrence > 1)
            RETURNING *
          )
          INSERT INTO messages_duplicate_archive (original_row)
            SELECT to_jsonb(archived) FROM archived;

          CREATE UNIQUE INDEX IF NOT EXISTS messages_chat_telegram_message_uidx
            ON messages (chat_id, telegram_message_id);
        END IF;
      END $$;
    `);
    await client.query('COMMIT');
    console.log('[DB] Database tables and schema columns initialized successfully.');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discardClient = true;
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
}
