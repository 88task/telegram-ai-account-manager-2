import { pgTable, text, timestamp, boolean, doublePrecision, jsonb, serial, bigserial, integer, uniqueIndex } from 'drizzle-orm/pg-core';

export const telegramSessions = pgTable('telegram_sessions', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull().unique(),
  phone: text('phone').notNull(),
  encryptedSessionString: text('encrypted_session_string').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const contacts = pgTable('contacts', {
  id: serial('id').primaryKey(),
  telegramUserId: text('telegram_user_id').notNull().unique(),
  username: text('username'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  phone: text('phone'),
  notes: text('notes'),
  customInstructions: text('custom_instructions'),
  isBlocked: boolean('is_blocked').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const conversations = pgTable('conversations', {
  id: serial('id').primaryKey(),
  // Legacy rows can have only chatJid; all new Telegram writes supply chatId.
  chatId: text('chat_id').unique(),
  // Retained only to preserve data from legacy deployments; Telegram uses chatId.
  chatJid: text('chat_jid'),
  accountKey: text('account_key').default('default'),
  chatTitle: text('chat_title'),
  chatType: text('chat_type').default('private').notNull(), // 'private' | 'group'
  lastMessageText: text('last_message_text'),
  lastMessageAt: timestamp('last_message_at').defaultNow().notNull(),
  unanswered: boolean('unanswered').default(false).notNull(),
  requiresHumanReview: boolean('requires_human_review').default(false).notNull(),
});

export const messages = pgTable('messages', {
  id: serial('id').primaryKey(),
  telegramMessageId: integer('telegram_message_id').notNull(),
  chatId: text('chat_id').notNull(),
  senderId: text('sender_id').notNull(),
  text: text('text'),
  isOutgoing: boolean('is_outgoing').notNull(),
  mediaType: text('media_type'), // 'image', 'document', etc.
  mediaUrl: text('media_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  chatTelegramMessageUnique: uniqueIndex('messages_chat_telegram_message_uidx')
    .on(table.chatId, table.telegramMessageId),
}));

// Keep the recovery archive in the schema so db:push does not propose deleting it.
export const messageDuplicateArchive = pgTable('messages_duplicate_archive', {
  archiveId: bigserial('archive_id', { mode: 'number' }).primaryKey(),
  archivedAt: timestamp('archived_at').defaultNow().notNull(),
  originalRow: jsonb('original_row').notNull(),
});

// Preserve legacy conversation rows removed when restoring chat uniqueness.
export const conversationDuplicateArchive = pgTable('conversations_duplicate_archive', {
  archiveId: bigserial('archive_id', { mode: 'number' }).primaryKey(),
  archivedAt: timestamp('archived_at').defaultNow().notNull(),
  originalRow: jsonb('original_row').notNull(),
});

export const approvalQueue = pgTable('approval_queue', {
  id: serial('id').primaryKey(),
  chatId: text('chat_id').notNull(),
  incomingMessageId: integer('incoming_message_id').notNull(),
  suggestedReply: text('suggested_reply').notNull(),
  editedReply: text('edited_reply'),
  aiConfidence: doublePrecision('ai_confidence').notNull(),
  aiReasoning: text('ai_reasoning').notNull(),
  status: text('status').default('pending').notNull(), // 'pending' | 'approved' | 'rejected' | 'edited'
  reviewedAt: timestamp('reviewed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const knowledgeItems = pgTable('knowledge_items', {
  id: serial('id').primaryKey(),
  category: text('category').notNull(), // 'rule' | 'faq' | 'approved_reply'
  questionOrTrigger: text('question_or_trigger'),
  content: text('content').notNull(),
  tags: text('tags').array(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const auditLogs = pgTable('audit_logs', {
  id: serial('id').primaryKey(),
  eventType: text('event_type').notNull(), // 'message_received' | 'auto_reply_sent' | 'approval_created' | 'manual_sent'
  chatId: text('chat_id').notNull(),
  actionTaken: text('action_taken').notNull(),
  details: jsonb('details'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const systemSettings = pgTable('system_settings', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const moderationStates = pgTable('moderation_states', {
  key: text('key').primaryKey(),
  state: jsonb('state').notNull(),
});
