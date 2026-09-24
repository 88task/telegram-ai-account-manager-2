import { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl/index.js';

export class TelegramSender {
  constructor(private client: TelegramClient) {}

  /**
   * Sends a message with realistic typing simulation and anti-burst delays.
   */
  public async sendReply(chatId: string, text: string): Promise<number | undefined> {
    try {
      // 1. Simulate human typing state
      await this.client.invoke(
        new Api.messages.SetTyping({
          peer: chatId,
          action: new Api.SendMessageTypingAction(),
        })
      );

      // Short human delay (1-2 seconds)
      await new Promise(r => setTimeout(r, 1500));

      const result = await this.client.sendMessage(chatId, {
        message: text,
      });

      return result.id;
    } catch (err) {
      console.error(`Failed to send message to chat ${chatId}:`, err);
      throw err;
    }
  }
}
