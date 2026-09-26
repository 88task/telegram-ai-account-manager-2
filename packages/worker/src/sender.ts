import { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl/index.js';

export class TelegramSender {
  constructor(private client: TelegramClient) {}

  /**
   * Sends a message with realistic typing simulation and anti-burst delays.
   * target can be an InputPeer, Entity, or string chat_id.
   */
  public async sendReply(target: any, text: string): Promise<number | undefined> {
    try {
      let peer = target;
      try {
        if (typeof target === 'string') {
          peer = await this.client.getInputEntity(target);
        }
      } catch (e) {
        peer = target;
      }

      // 1. Simulate human typing state (non-fatal if SetTyping fails)
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

      const result = await this.client.sendMessage(peer, {
        message: text,
      });

      return result.id;
    } catch (err) {
      console.error(`Failed to send message:`, err);
      throw err;
    }
  }
}
