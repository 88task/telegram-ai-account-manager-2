import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { BrainPipeline, OperatingMode } from '@telegram-ai/brain';
import { TelegramSender } from './sender.js';
import 'dotenv/config';

async function main() {
  const apiId = parseInt(process.env.TELEGRAM_API_ID || '', 10);
  const apiHash = process.env.TELEGRAM_API_HASH || '';
  const sessionString = process.env.TELEGRAM_SESSION_STRING || '';

  if (!apiId || !apiHash || !sessionString) {
    console.error('Missing TELEGRAM_API_ID, TELEGRAM_API_HASH, or TELEGRAM_SESSION_STRING.');
    process.exit(1);
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
