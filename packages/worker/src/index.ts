import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { BrainPipeline, OperatingMode } from '@telegram-ai/brain';
import { TelegramSender } from './sender.js';
import crypto from 'crypto';
import { db, initDb, defaultOperatingMode, encryptSecret, encryptionKey, contacts, desc, and, or, lt, telegramSessions, systemSettings, messages, conversations, auditLogs, approvalQueue, eq } from '@telegram-ai/db';
import 'dotenv/config';

function decryptSessionString(stored: string): string {
  if (!stored.startsWith('enc:')) return stored;
  const [, ivHex, tagHex, dataHex] = stored.split(':');
  const keyHex = encryptionKey().toString('hex');
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
    if (!row.encryptedSessionString.startsWith('enc:')) {
      await db.update(telegramSessions).set({ encryptedSessionString: encryptSecret(row.encryptedSessionString) }).where(eq(telegramSessions.id, row.id));
    }
    return decryptSessionString(row.encryptedSessionString);
  } catch (e: any) {
    throw new Error('Unable to load Telegram session: verify database access and SESSION_ENCRYPTION_KEY', { cause: e });
  }
}

async function getLiveSettings() {
  try {
    const rows = await db.select().from(systemSettings);
    const map = new Map<string, string>();
    for (const r of rows) {
      map.set(r.key, r.value);
    }
    const requestedMode = map.get('operating_mode') ?? defaultOperatingMode();
    const mode: OperatingMode = ['manual', 'draft', 'auto_pilot'].includes(requestedMode) ? requestedMode as OperatingMode : 'draft';
    const killSwitch = map.get('emergency_kill_switch') === 'true';
    const allowedGroupIds = (map.get('allowed_group_ids') ?? process.env.ALLOWED_GROUP_IDS ?? '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const blockedUserIds = (map.get('blocked_user_ids') ?? process.env.BLOCKED_USER_IDS ?? '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const ignoredAdminIds = (map.get('ignored_admin_ids') ?? process.env.IGNORED_ADMIN_IDS ?? '')
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
    console.warn('[Worker] Settings unavailable; sending disabled.');
    return {
      operatingMode: 'draft' as OperatingMode,
      emergencyKillSwitch: true,
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
let activeUserId = '';
let workerGeneration = 0;
let lifecycle: Promise<unknown> = Promise.resolve();

function enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const result = lifecycle.then(operation);
  lifecycle = result.catch(() => {});
  return result;
}

export function stopWorker(): Promise<void> {
  workerGeneration++;
  return enqueueLifecycle(stopWorkerInternal);
}

export function startWorker(forcedSession?: string): Promise<void> {
  const generation = ++workerGeneration;
  return enqueueLifecycle(() => startWorkerInternal(forcedSession, generation));
}

export async function sendManagedReply(chatId: string, text: string, replyTo?: number, automatic = false, senderId?: string): Promise<number> {
  const client = activeClient;
  const generation = workerGeneration;
  const userId = activeUserId;
  if (!client) throw new Error('Telegram worker is not connected');
  const ensureAllowed = async () => {
    const settings = await getLiveSettings();
    if (activeClient !== client || workerGeneration !== generation || settings.emergencyKillSwitch || (automatic && settings.operatingMode !== 'auto_pilot')) {
      throw new Error('Sending stopped by session change, kill switch, or operating mode');
    }
    if (settings.blockedUserIds.includes(senderId || chatId)) throw new Error('User is blocked');
    const [contact] = await db.select().from(contacts).where(eq(contacts.telegramUserId, senderId || chatId)).limit(1);
    if (contact?.isBlocked) throw new Error('Contact is blocked');
    if (activeClient !== client || workerGeneration !== generation) throw new Error('Session changed before delivery');
  };
  await ensureAllowed();
  let target: any = chatId;
  if (replyTo !== undefined) {
    const originals = await client.getMessages(chatId, { ids: [replyTo] });
    target = originals[0];
    if (!target) throw new Error('Original message is unavailable; review the conversation before sending');
    senderId = normalizeId(target.senderId) || senderId;
  }
  let id: number | undefined;
  let guardError: unknown;
  try { id = await new TelegramSender(client).sendReply(target, text, async () => {
    try { await ensureAllowed(); } catch (error) { guardError = error; throw error; }
  }); }
  catch (error) {
    if (guardError) throw guardError;
    throw Object.assign(new Error('Delivery could not be confirmed. Verify the Telegram chat before retrying.'), { deliveryUnknown: true }); }
  if (!Number.isInteger(id)) throw Object.assign(new Error('Telegram did not confirm delivery; verify the chat before retrying'), { deliveryUnknown: true });
  try {
  await db.insert(messages).values({ chatId, telegramMessageId: id!, senderId: userId, text, isOutgoing: true })
    .onConflictDoNothing({ target: [messages.chatId, messages.telegramMessageId] });
  await db.update(conversations).set({ unanswered: false, lastMessageText: text, lastMessageAt: new Date() }).where(eq(conversations.chatId, chatId));
  } catch { throw Object.assign(new Error('Message sent but recording failed. Verify the chat before retrying.'), { deliveryUnknown: true }); }
  return id!;
}

async function stopWorkerInternal() {
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

async function startWorkerInternal(forcedSession: string | undefined, generation: number) {
  let connectingClient: TelegramClient | undefined;
  try {
      await stopWorkerInternal();
      if (generation !== workerGeneration) return;
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

      connectingClient = client;
      await client.connect();
      console.log('[Worker] Connected to Telegram MTProto socket.');

      const me = await client.getMe();
      const myUserId = me.id.toString();
      if (generation !== workerGeneration) return;
      await db.insert(systemSettings).values({ key: 'managed_account_id', value: myUserId }).onConflictDoNothing({ target: systemSettings.key });
      const [binding] = await db.select().from(systemSettings).where(eq(systemSettings.key, 'managed_account_id'));
      if (binding.value !== myUserId) throw new Error('This database belongs to a different Telegram account. Use a separate database.');
      if (generation !== workerGeneration) return;
      console.log('[Worker] Telegram account authenticated.');
      activeUserId = myUserId;

      activeClient = client;

      const brain = new BrainPipeline(myUserId);
      const chatQueues = new Map<string, Promise<void>>();
      const handleMessage = async (event: any) => {


        const msg = event.message;
        if (!msg) return;

        if (activeClient !== client || generation !== workerGeneration) return;
        if (msg.out) {
          await db.insert(messages).values({ telegramMessageId: msg.id, chatId: normalizeId(msg.chatId), senderId: myUserId, text: msg.text || '', isOutgoing: true, createdAt: new Date(msg.date * 1000) })
            .onConflictDoNothing({ target: [messages.chatId, messages.telegramMessageId] });
          return;
        }

        const chatId = normalizeId(msg.chatId);
        const senderId = normalizeId(msg.senderId);
        const isPrivateChat = chatId !== '' && Number(chatId) > 0;
        const isGroupChat = chatId !== '' && Number(chatId) < 0 && !msg.isChannel;
        const isChannelChat = !!msg.isChannel || (chatId.startsWith('-100') && !isGroupChat && !isPrivateChat);
        const isAnonymousAdminPost = chatId.startsWith('-100') && senderId && senderId === chatId;

        console.log('[Worker] Received incoming message.');

        try {
          const recorded = await db.transaction(async (tx) => {
            const inserted = await tx.insert(messages).values({
              telegramMessageId: msg.id,
              chatId,
              senderId,
              text: msg.text || '',
              isOutgoing: false,
              createdAt: new Date(msg.date * 1000),
              mediaType: msg.media ? 'image' : null,
            }).onConflictDoNothing({
              target: [messages.chatId, messages.telegramMessageId],
            }).returning({ id: messages.id });
            // Only the process that persisted this event may evaluate or reply to it.
            if (inserted.length === 0) return false;

            await tx.insert(conversations).values({
              chatId,
              accountKey: 'default',
              chatTitle: senderId,
              chatType: isPrivateChat ? 'private' : isGroupChat ? 'group' : 'channel',
              lastMessageText: msg.text || '[Media]',
              lastMessageAt: new Date(),
              unanswered: true,
            }).onConflictDoUpdate({
              target: conversations.chatId,
              set: {
                lastMessageText: msg.text || '[Media]',
                lastMessageAt: new Date(),
                unanswered: true,
              },
            });
            return true;
          });
          if (!recorded) return;
        } catch (dbErr: any) {
          console.warn('Could not record incoming message in DB; skipping reply:', dbErr.message);
          return;
        }

        const [contact] = await db.select().from(contacts).where(eq(contacts.telegramUserId, senderId)).limit(1);
        if (contact?.isBlocked) return;
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

        const history = (await db.select().from(messages)
          .where(and(eq(messages.chatId, chatId), or(lt(messages.telegramMessageId, msg.id), eq(messages.isOutgoing, true))))
          .orderBy(desc(messages.createdAt), desc(messages.id)).limit(30)).reverse().map(row => ({
            role: row.isOutgoing ? 'assistant' as const : 'user' as const,
            text: row.text || '', isOutgoing: row.isOutgoing, timestamp: Math.floor(row.createdAt.getTime() / 1000),
          }));
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
            history,
            settings.operatingMode
          );
        } catch (brainErr: any) {
          console.warn('[Worker] AI processing failed; queuing for human review.');
          decision = { action: 'approval_required', replyText: '', confidence: 0, reason: 'AI processing failed. Compose a human response.' };
        }

        console.log(`[Decision] Mode: ${settings.operatingMode} | Action: ${decision.action}`);

        try {
          await db.insert(auditLogs).values({
            eventType: decision.action === 'auto_sent' ? 'auto_ready' : decision.action,
            chatId,
            actionTaken: decision.reason || 'AI evaluation completed',
            details: { confidence: decision.confidence },
          });
        } catch (e: any) {
          // ignore audit log failure
        }

        if (decision.action === 'approval_required' || decision.action === 'draft_queued') {
          try {
            await db.insert(approvalQueue).values({
              chatId,
              incomingMessageId: msg.id,
              suggestedReply: decision.replyText || '',
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
          if (generation !== workerGeneration || activeClient !== client) return;
          await sendManagedReply(chatId, decision.replyText, msg.id, true, senderId);
          await db.insert(auditLogs).values({ eventType: 'auto_sent', chatId, actionTaken: 'Reply delivered' })
            .catch(() => console.warn('[Worker] Delivery confirmed, but audit write failed.'));
        }
      };
      client.addEventHandler((event) => {
        const chatId = normalizeId(event.message?.chatId);
        const previous = chatQueues.get(chatId) || Promise.resolve();
        const next = previous.then(() => handleMessage(event)).catch(async (error) => {
          console.warn('[Worker] Message handling failed; human review required.');
          try {
            await db.insert(approvalQueue).values({ chatId, incomingMessageId: event.message.id, suggestedReply: '', aiConfidence: 0, aiReasoning: 'Processing or delivery failed. Verify the chat before sending a response.', status: error?.deliveryUnknown ? 'delivery_unknown' : 'pending' });
          } catch { console.error('[Worker] Could not persist failure for human review.'); }
        });
        chatQueues.set(chatId, next);
        void next.finally(() => { if (chatQueues.get(chatId) === next) chatQueues.delete(chatId); });
        return next;
      }, new NewMessage({}));

      console.log('Telegram AI Account Worker is listening for incoming private messages...');
  } catch (error) {
    throw error;
  } finally {
    if (connectingClient && connectingClient !== activeClient) {
      try { await connectingClient.destroy(); } catch { console.warn('[Worker] Client cleanup failed.'); }
    }
  }
}

if (process.env.STANDALONE_WORKER === 'true' || (typeof process !== 'undefined' && process.argv[1]?.endsWith('worker/dist/index.js'))) {
  initDb().then(() => startWorker()).catch(() => {
    console.error('[Worker] Startup failed.');
    process.exit(1);
  });
}

