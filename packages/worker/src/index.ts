import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { BrainPipeline, OperatingMode } from '@telegram-ai/brain';
import { TelegramSender } from './sender.js';
import crypto from 'crypto';
import { db, telegramSessions, eq } from '@telegram-ai/db';
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

async function main() {
  const apiId = parseInt(process.env.TELEGRAM_API_ID || '', 10);
  const apiHash = process.env.TELEGRAM_API_HASH || '';
  const sessionString = process.env.TELEGRAM_SESSION_STRING || '';

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

    // Download photo buffer if present for Bedrock Nova Vision analysis
    let mediaBuffer: Buffer | undefined;
    let mediaMimeType: string | undefined;

    if (msg.media) {
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

    const currentMode = (process.env.OPERATING_MODE as OperatingMode) || 'draft';

    const decision = await brain.processMessage(
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
      [], // recent history fetched from DB or MTProto
      currentMode
    );

    console.log(`[Decision] Action: ${decision.action} | Reason: ${decision.reason}`);

    if (decision.action === 'auto_sent' && decision.replyText) {
      console.log(`[Auto-Pilot] Sending reply to ${chatId}: "${decision.replyText}"`);
      await sender.sendReply(chatId, decision.replyText);
    }
  }, new NewMessage({}));

  console.log('Telegram AI Account Worker is listening for incoming private messages...');
}

main().catch(console.error);
