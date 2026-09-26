import { TelegramClient, utils } from 'telegram';
import { Api } from 'telegram/tl/index.js';

export class TelegramSender {
  constructor(private client: TelegramClient) {}

  /**
   * Sends a message with realistic typing simulation and anti-burst delays.
   * Quotes the message and mentions the user in group chats.
   * target can be a GramJS Message object, InputPeer, or string chat_id.
   */
  public async sendReply(target: any, text: string, beforeSend?: () => Promise<void>): Promise<number | undefined> {
    try {
      let peer: any = target;

      // GramJS marks user IDs positive and group/channel IDs negative. A
      // message's own id and senderId do not identify the destination chat.
      let targetChatId = '';
      for (const candidate of [target?.chatId, target?.peerId, target?.chat, target]) {
        if (candidate === null || candidate === undefined) continue;
        try {
          targetChatId = utils.getPeerId(candidate);
          if (targetChatId) break;
        } catch {
          // Unresolved peers can still use the message's chat-kind flags below.
        }
      }
      const isPrivateChat = /^[1-9]\d*$/.test(targetChatId);
      const isGroupLikeChat = /^-[1-9]\d*$/.test(targetChatId);

      // If target is a GramJS Message object with async getInputChat()
      if (target && typeof target.getInputChat === 'function') {
        try {
          peer = await target.getInputChat();
        } catch {
          peer = target;
        }
      } else if (typeof target === 'string') {
        try {
          peer = await this.client.getInputEntity(target);
        } catch {
          peer = target;
        }
      }

      // 1. Simulate human typing state (safe try/catch)
      try {
        await this.client.invoke(
          new Api.messages.SetTyping({
            peer,
            action: new Api.SendMessageTypingAction(),
          })
        );
      } catch (err: any) {
        // Typing indicator is cosmetic; do not fail message delivery
      }

      // Short human delay (1-2 seconds)
      await new Promise(r => setTimeout(r, 1500));

      let messageText = text;

      // Tag/mention the user in group chats so they receive direct notification.
      // Use numeric chat ID semantics instead of brittle boolean flags.
      if (target && !isPrivateChat && (isGroupLikeChat || target.isGroup || target.isChannel)) {
        try {
          let mentionTag = '';
          const sender = typeof target.getSender === 'function' ? await target.getSender() : null;
          if (sender) {
            if (sender.username) {
              mentionTag = `@${sender.username}`;
            } else {
              const name = sender.firstName || 'User';
              const rawId = sender.id ? String(sender.id).replace(/[^0-9]/g, '') : '';
              if (rawId) {
                mentionTag = `[${name}](tg://user?id=${rawId})`;
              }
            }
          } else if (target.senderId) {
            const rawId = String(target.senderId).replace(/[^0-9]/g, '');
            if (rawId) {
              mentionTag = `[User](tg://user?id=${rawId})`;
            }
          }

          if (mentionTag && !messageText.startsWith(mentionTag)) {
            messageText = `${mentionTag} ${messageText}`;
          }
        } catch (mentionErr) {
          console.warn('[TelegramSender] Failed to resolve sender mention tag:', mentionErr);
        }
      }

      // 2. Direct Quote Reply: quotes the specific user message
      if (target && typeof target.reply === 'function') {
        await beforeSend?.();
        try {
          const result = await target.reply({
            message: messageText,
          });
          return result?.id;
        } catch (replyErr) {
          // A network failure can occur after Telegram accepted the message.
          // Never issue a second send when delivery is uncertain.
          throw replyErr;
        }
      }

      // Fallback: send via client using resolved peer and replyTo id
      const sendOptions: any = {
        message: messageText,
      };
      if (target && target.id && typeof target.id === 'number') {
        sendOptions.replyTo = target.id;
      }

      await beforeSend?.();
      const result = await this.client.sendMessage(peer, sendOptions);
      return result?.id;
    } catch (err) {
      console.error('[TelegramSender] Delivery failed or could not be confirmed.');
      throw err;
    }
  }
}
