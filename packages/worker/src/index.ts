import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { BrainPipeline, OperatingMode } from '@telegram-ai/brain';
import { TelegramSender } from './sender.js';
import crypto from 'crypto';
import { db, telegramSessions, systemSettings, messages, conversations, auditLogs, approvalQueue, eq } from '@telegram-ai/db';
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

function decryptGeminiKeys(stored: string): string[] {
  if (!stored) {
    const fallback = (process.env.GEMINI_API_KEY || '').trim();
    return fallback ? [fallback] : [];
  }
  let parsed: any[] = [];
  if (!stored.startsWith('enc:')) {
    try { parsed = JSON.parse(stored); } catch { parsed = []; }
  } else {
    try {
      const [, ivHex, tagHex, dataHex] = stored.split(':');
      const keyHex = (process.env.SESSION_ENCRYPTION_KEY || '').trim();
      if (keyHex) {
        const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'));
        decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
        const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
        parsed = JSON.parse(dec);
      }
    } catch (e: any) {
      console.warn('Failed to decrypt gemini keys:', e.message);
      parsed = [];
    }
  }
  const extracted = (Array.isArray(parsed) ? parsed : [])
    .map((k: any) => (typeof k === 'string' ? k : k?.key))
    .filter((k: any): k is string => Boolean(k && typeof k === 'string'));
  if (extracted.length === 0 && process.env.GEMINI_API_KEY) {
    extracted.push(process.env.GEMINI_API_KEY.trim());
  }
  return extracted;
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
    const ignoredAdminIds = (map.get('ignored_admin_ids') || process.env.IGNORED_ADMIN_IDS || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const geminiMode = (map.get('ai_provider_mode') || process.env.AI_PROVIDER_MODE || 'auto') as 'auto' | 'gemini' | 'bedrock';
    const geminiModel = map.get('gemini_model') || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const geminiKeys = decryptGeminiKeys(map.get('gemini_keys_encrypted') || '');

    return {
      operatingMode: mode,
      emergencyKillSwitch: killSwitch,
      allowedGroupIds,
      blockedUserIds,
      ignoredAdminIds,
      geminiKeys,
      geminiModel,
      geminiMode,
    };
  } catch (e: any) {
    console.warn('Could not read system_settings from DB, using fallback defaults:', e.message);
    return {
      operatingMode: (process.env.OPERATING_MODE as OperatingMode) || 'auto_pilot',
      emergencyKillSwitch: false,
      allowedGroupIds: (process.env.ALLOWED_GROUP_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
      blockedUserIds: (process.env.BLOCKED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
      ignoredAdminIds: (process.env.IGNORED_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
      geminiKeys: [] as string[],
      geminiModel: 'gemini-2.5-flash',
      geminiMode: 'auto' as const,
    };
  }
}



function normalizeId(id: any): string {
  if (id === null || id === undefined) return '';
  const str = typeof id === 'object' && id.toString ? id.toString() : String(id);
  return str.replace(/[^0-9-]/g, '');
}

let activeClient: TelegramClient | null = null;
let isStarting = false;
let workerStartupPromise: Promise<void> | null = null;

export async function stopWorker() {
  if (!activeClient) {
    return;
  }

  const client = activeClient;
  activeClient = null;
  console.log('[Worker] Stopping and destroying active TelegramClient...');
  try {
    await client.disconnect();
  } catch (err: any) {
    console.warn('[Worker] Error during client disconnect:', err.message);
  }

  try {
    await client.destroy();
  } catch (err: any) {
    console.warn('[Worker] Error during client destroy:', err.message);
  }
}

export async function startWorker(forcedSession?: string) {
  if (workerStartupPromise) {
    await workerStartupPromise;
    return;
  }

  if (isStarting) {
    console.log('[Worker] startWorker already in progress, skipping.');
    return;
  }

  isStarting = true;
  workerStartupPromise = (async () => {
    try {
      await stopWorker();

      const apiId = parseInt(process.env.TELEGRAM_API_ID || '', 10);
      const apiHash = process.env.TELEGRAM_API_HASH || '';

      if (!apiId || !apiHash) {
        console.warn('[Worker] Missing TELEGRAM_API_ID or TELEGRAM_API_HASH.');
        return;
      }

      let sessionString = forcedSession || process.env.TELEGRAM_SESSION_STRING || '';
      if (!sessionString) {
        sessionString = await getSessionStringFromDb();
      }

      if (!sessionString) {
        console.log('[Worker] No Telegram session yet. Waiting for panel login...');
        return;
      }

      console.log('[Worker] Connecting to Telegram MTProto socket...');
      const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 5,
      });

      await client.connect();
      console.log('[Worker] Connected to Telegram MTProto socket.');

      const me = await client.getMe();
      const myUserId = me.id.toString();
      console.log(`[Worker] Authenticated as: ${me.firstName} (ID: ${myUserId})`);

      activeClient = client;

      const brain = new BrainPipeline(myUserId);
      const sender = new TelegramSender(client);

      client.addEventHandler(async (event) => {
        const msg = event.message;
        if (!msg) return;

        if (msg.out) return;

        const chatId = normalizeId(msg.chatId);
        const senderId = normalizeId(msg.senderId);
        const isPrivateChat = chatId !== '' && Number(chatId) > 0;
        const isGroupChat = chatId !== '' && Number(chatId) < 0 && !msg.isChannel;
        const isChannelChat = !!msg.isChannel || (chatId.startsWith('-100') && !isGroupChat && !isPrivateChat);
        const isAnonymousAdminPost = chatId.startsWith('-100') && senderId && senderId === chatId;

        console.log(`[New Message] Chat: ${chatId} | Sender: ${senderId} | Text: "${msg.text?.slice(0, 50)}..."`);

        try {
          await db.insert(messages).values({
            telegramMessageId: msg.id,
            chatId,
            senderId,
            text: msg.text || '',
            isOutgoing: false,
            mediaType: msg.media ? 'image' : null,
          });

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
              accountKey: 'default',
              chatTitle: senderId,
              chatType: isPrivateChat ? 'private' : isGroupChat ? 'group' : 'channel',
              lastMessageText: msg.text || '[Media]',
              lastMessageAt: new Date(),
              unanswered: true,
            });
          }
        } catch (dbErr: any) {
          console.warn('Could not record incoming message in DB:', dbErr.message);
        }

        const settings = await getLiveSettings();
        brain.updateScope(settings.allowedGroupIds, settings.blockedUserIds, settings.ignoredAdminIds);
        brain.setGeminiConfig(settings.geminiKeys || [], settings.geminiModel, settings.geminiMode);
        if (settings.emergencyKillSwitch) {
          console.log(`[Kill Switch Active] Skipping AI reply for chat ${chatId}.`);
          return;
        }

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

        let isSenderAdmin = false;
        if (!isPrivateChat && isAnonymousAdminPost) {
          isSenderAdmin = true;
          console.log(`[worker] Ignored message from anonymous admin (senderId === chatId ${chatId})`);
        } else if (!isPrivateChat && settings.ignoredAdminIds.includes(senderId)) {
          isSenderAdmin = true;
          console.log(`[worker] Ignored message from configured admin ID (${senderId}) in chat (${chatId})`);
        }

        let decision: any;
        try {
          decision = await brain.processMessage(
            {
              messageId: msg.id,
              chatId,
              senderId,
              isPrivateChat: isPrivateChat,
              isGroup: isGroupChat || !!msg.isGroup,
              isChannel: isChannelChat || !!msg.isChannel,
              isSenderAdmin,
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
            actionTaken: brainErr?.message || 'AI processing failure',
            details: { stack: brainErr.stack?.slice(0, 300), name: brainErr.name },
          });
          return;
        }

        console.log(`[Decision] Mode: ${settings.operatingMode} | Action: ${decision.action} | Reason: ${decision.reason}`);

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

        if (decision.action === 'approval_required') {
          try {
            await db.insert(approvalQueue).values({
              chatId,
              incomingMessageId: msg.id,
              suggestedReply: decision.replyText || '[Human response required]',
              aiConfidence: decision.confidence ?? 0.5,
              aiReasoning: decision.reason || 'Flagged for human moderation',
              status: 'pending',
            });
            await db.update(conversations)
              .set({ requiresHumanReview: true, unanswered: true })
              .where(eq(conversations.chatId, chatId));
            console.log();
          } catch (err: any) {
            console.error('Failed to insert into approval_queue:', err);
          }
        }

        if (decision.action === 'auto_sent' && decision.replyText) {
          console.log(`[Auto-Pilot] Sending reply to ${chatId}: "${decision.replyText}"`);
          await sender.sendReply(msg, decision.replyText);

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
    } catch (err: any) {
      console.error('[Worker] Failed to start worker:', err);
    } finally {
      isStarting = false;
      workerStartupPromise = null;
    }
  })();

  await workerStartupPromise;
}

if (process.env.STANDALONE_WORKER === 'true' || (typeof process !== 'undefined' && process.argv[1]?.endsWith('worker/dist/index.js'))) {
  startWorker().catch(console.error);
}

