import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const { Pool } = pg;

let connectionString = process.env.DATABASE_URL || '';
if (connectionString) {
  try {
    const url = new URL(connectionString);
    url.searchParams.delete('sslmode');
    connectionString = url.toString();
  } catch {}
}

export const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

export const db = drizzle(pool, { schema });
export * from './schema.js';
export * from 'drizzle-orm';

export async function initDb(): Promise<void> {
  const client = await pool.connect();
  try {
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

      CREATE UNIQUE INDEX IF NOT EXISTS messages_chat_telegram_message_uidx
        ON messages (chat_id, telegram_message_id);

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
    `);
    console.log('[DB] Database tables and schema columns initialized successfully.');
  } finally {
    client.release();
  }
}
