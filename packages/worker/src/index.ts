import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { BrainPipeline, OperatingMode } from '@telegram-ai/brain';
import { TelegramSender } from './sender.js';
import crypto from 'crypto';
import { db, telegramSessions, systemSettings, messages, conversations, auditLogs, eq } from '@telegram-ai/db';
import 'dotenv/config';

function decryptSessionString(stored: string): string {
  if (!stored.startsWith('enc:')) return stored;
  const [, ivHex, tagHex, dataHex] = stored.split(':');
  const keyHex = (process.env.SESSION_ENCRYPTION_KEY || '').trim();
  if (!keyHex) throw new Error('SESSION_ENCRYPTION_KEY is required to decrypt the stored session');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

async function getSessionStringFromDb(): Promise<string> {
  try {
    const [row] = await db.select().from(telegramSessions).where(eq(telegramSessions.isActive, true)).limit(1);
    if (!row) return '';
    return decryptSessionString(row.encryptedSessionString);
  } catch (e: any) {
    console.error('Failed to read session from database:', e.message);
    return '';
  }
}

async function getLiveSettings() {
  try {
    const rows = await db.select().from(systemSettings);
    const map = new Map<string, string>();
    for (const r of rows) {
      map.set(r.key, r.value);
    }
    const mode = (map.get('operating_mode') as OperatingMode) || (process.env.OPERATING_MODE as OperatingMode) || 'auto_pilot';
    const killSwitch = map.get('emergency_kill_switch') === 'true';
    const allowedGroupIds = (map.get('allowed_group_ids') || process.env.ALLOWED_GROUP_IDS || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const blockedUserIds = (map.get('blocked_user_ids') || process.env.BLOCKED_USER_IDS || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    return {
      operatingMode: mode,
      emergencyKillSwitch: killSwitch,
      allowedGroupIds,
      blockedUserIds,
    };
  } catch (e: any) {
    console.warn('Could not read system_settings from DB, using fallback defaults:', e.message);
    return {
      operatingMode: (process.env.OPERATING_MODE as OperatingMode) || 'auto_pilot',
      emergencyKillSwitch: false,
      allowedGroupIds: (process.env.ALLOWED_GROUP_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
      blockedUserIds: (process.env.BLOCKED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
    };
  }
}

async function main() {
  const apiId = parseInt(process.env.TELEGRAM_API_ID || '', 10);
  const apiHash = process.env.TELEGRAM_API_HASH || '';

  if (!apiId || !apiHash) {
    console.error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH.');
    process.exit(1);
  }

  // Load session from env, or fall back to the active session saved from the Management Panel.
  let sessionString = process.env.TELEGRAM_SESSION_STRING || '';
  if (!sessionString) {
    sessionString = await getSessionStringFromDb();
  }
  while (!sessionString) {
    console.log('No Telegram session yet. Waiting for panel login... (check the Management Dashboard)');
    await new Promise((r) => setTimeout(r, 15000));
    sessionString = await getSessionStringFromDb();
  }

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 10,
  });

  await client.connect();
  console.log('Connected to Telegram MTProto socket.');

  const me = await client.getMe();
  const myUserId = me.id.toString();
  console.log(`Authenticated as: ${me.firstName} (ID: ${myUserId})`);

  const brain = new BrainPipeline(myUserId);
  const sender = new TelegramSender(client);

  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg) return;

    // Filter out our own sent messages from triggering replies
    if (msg.out) return;

    const chatId = msg.chatId?.toString() || '';
    const senderId = msg.senderId?.toString() || '';
    const isPrivate = msg.isPrivate;
    const isGroup = msg.isGroup;
    const isChannel = msg.isChannel;

    console.log(`[New Message] Chat: ${chatId} | Sender: ${senderId} | Text: "${msg.text?.slice(0, 50)}..."`);

    // Record incoming message in DB
    try {
      await db.insert(messages).values({
        telegramMessageId: msg.id,
        chatId,
        senderId,
        text: msg.text || '',
        isOutgoing: false,
        mediaType: msg.media ? 'image' : null,
      });

      // Upsert conversation summary
      const [existingConv] = await db.select().from(conversations).where(eq(conversations.chatId, chatId)).limit(1);
      if (existingConv) {
        await db.update(conversations)
          .set({
            lastMessageText: msg.text || '[Media]',
            lastMessageAt: new Date(),
            unanswered: true,
          })
          .where(eq(conversations.chatId, chatId));
      } else {
        await db.insert(conversations).values({
          chatId,
          chatTitle: senderId,
          chatType: isPrivate ? 'private' : isGroup ? 'group' : 'channel',
          lastMessageText: msg.text || '[Media]',
          lastMessageAt: new Date(),
          unanswered: true,
        });
      }
    } catch (dbErr: any) {
      console.warn('Could not record incoming message in DB:', dbErr.message);
    }

    // Check live settings from DB (Kill switch & Mode)
    const settings = await getLiveSettings();
    brain.updateScope(settings.allowedGroupIds, settings.blockedUserIds);
    if (settings.emergencyKillSwitch) {
      console.log(`[Kill Switch Active] Skipping AI reply for chat ${chatId}.`);
      return;
    }

    // Download photo buffer if present for Bedrock Nova Vision analysis (ignore link previews / webpages)
    let mediaBuffer: Buffer | undefined;
    let mediaMimeType: string | undefined;

    const isActualPhoto = !!(msg.photo || (msg.media && (msg.media as any).className === 'MessageMediaPhoto'));
    if (isActualPhoto && msg.media) {
      try {
        const buffer = await client.downloadMedia(msg.media);
        if (buffer && Buffer.isBuffer(buffer)) {
          mediaBuffer = buffer;
          mediaMimeType = 'image/jpeg';
        }
      } catch (err) {
        console.warn('Could not download media attachment:', err);
      }
    }

    let decision: any;
    try {
      decision = await brain.processMessage(
        {
          messageId: msg.id,
          chatId,
          senderId,
          isPrivateChat: !!isPrivate,
          isGroup: !!isGroup,
          isChannel: !!isChannel,
          text: msg.text,
          mediaBuffer,
          mediaMimeType,
          timestamp: msg.date,
        },
        [],
        settings.operatingMode
      );
    } catch (brainErr: any) {
      console.error('[Brain Error]:', brainErr);
      await db.insert(auditLogs).values({
        eventType: 'error',
        chatId,
        actionTaken: brainErr?.message || "AI processing failure",
        details: { stack: brainErr.stack?.slice(0, 300), name: brainErr.name },
      });
      return;
    }

    console.log(`[Decision] Mode: ${settings.operatingMode} | Action: ${decision.action} | Reason: ${decision.reason}`);

    // Log decision to auditLogs
    try {
      await db.insert(auditLogs).values({
        eventType: decision.action,
        chatId,
        actionTaken: decision.reason || 'AI evaluation completed',
        details: { confidence: decision.confidence, replyPreview: decision.replyText?.slice(0, 100) },
      });
    } catch (e: any) {
      // ignore audit log failure
    }

    if (decision.action === 'auto_sent' && decision.replyText) {
      console.log(`[Auto-Pilot] Sending reply to ${chatId}: "${decision.replyText}"`);
      await sender.sendReply(chatId, decision.replyText);

      // Record outgoing message and mark conversation answered
      try {
        await db.update(conversations)
          .set({ unanswered: false })
          .where(eq(conversations.chatId, chatId));
      } catch (e) {
        // ignore
      }
    }
  }, new NewMessage({}));

  console.log('Telegram AI Account Worker is listening for incoming private messages...');
}

main().catch(console.error);
