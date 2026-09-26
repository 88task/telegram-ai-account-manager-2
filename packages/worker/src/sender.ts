import { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl/index.js';

export class TelegramSender {
  constructor(private client: TelegramClient) {}

  /**
   * Sends a message with realistic typing simulation and anti-burst delays.
   * target can be a GramJS Message object, InputPeer, or string chat_id.
   */
  public async sendReply(target: any, text: string): Promise<number | undefined> {
    try {
      let peer: any = target;

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

      // 2. If target is a Message instance with respond(), use it directly
      if (target && typeof target.respond === 'function') {
        const result = await target.respond({
          message: text,
        });
        return result?.id;
      }

      // Fallback: send via client using resolved peer
      const result = await this.client.sendMessage(peer, {
        message: text,
      });

      return result?.id;
    } catch (err) {
      console.error(`Failed to send message:`, err);
      throw err;
    }
  }
}
