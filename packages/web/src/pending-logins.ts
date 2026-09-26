import type { TelegramClient } from 'telegram';

interface PendingLogin {
  client: TelegramClient;
  phone: string;
  phoneCodeHash: string;
  createdAt: number;
}

export async function disposeLoginClient(client: TelegramClient): Promise<void> {
  try {
    // destroy() already awaits disconnect() in GramJS.
    await client.destroy();
  } catch {
    console.warn('[Web] Failed to destroy a pending Telegram login client.');
  }
}

export class PendingLogins {
  private readonly entries = new Map<string, PendingLogin>();
  private readonly busy = new Set<string>();

  constructor(private readonly ttlMs = 10 * 60 * 1000) {}

  // Serialize send-code, verification, and password submission for each phone.
  acquire(phone: string): (() => void) | undefined {
    if (this.busy.has(phone)) return undefined;
    this.busy.add(phone);
    return () => { this.busy.delete(phone); };
  }

  async get(phone: string): Promise<PendingLogin | undefined> {
    const pending = this.entries.get(phone);
    if (pending && Date.now() - pending.createdAt >= this.ttlMs) {
      await this.cleanup(phone);
      return undefined;
    }
    return pending;
  }

  set(phone: string, pending: PendingLogin): void {
    this.entries.set(phone, pending);
  }

  async cleanup(phone: string): Promise<void> {
    const pending = this.entries.get(phone);
    // Remove before awaiting so completion cannot delete a replacement entry.
    this.entries.delete(phone);
    if (pending) await disposeLoginClient(pending.client);
  }

  async cleanupExpired(): Promise<void> {
    for (const [phone, pending] of this.entries) {
      if (!this.busy.has(phone) && Date.now() - pending.createdAt >= this.ttlMs) {
        await this.cleanup(phone);
      }
    }
  }
}
