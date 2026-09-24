import { LUMO_SUPPORTED_BANKS } from '../memory/lumo-knowledge.js';

export interface ToolDefinition {
  name: string;
  description: string;
  execute: (params: any) => Promise<any>;
}

export class BrainToolsRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  constructor() {
    this.registerTools();
  }

  private registerTools(): void {
    // 1. Check Bank Support Status
    this.tools.set('check_bank_support', {
      name: 'check_bank_support',
      description: 'Checks if a specific Indian bank is supported for withdrawals on LUMO',
      execute: async ({ bankName }: { bankName: string }) => {
        const query = (bankName || '').toLowerCase();
        const matched = LUMO_SUPPORTED_BANKS.find(b => b.toLowerCase().includes(query));
        return {
          supported: !!matched,
          matchedBank: matched || null,
          totalSupportedBanks: LUMO_SUPPORTED_BANKS.length
        };
      }
    });

    // 2. Query Withdrawal Policy
    this.tools.set('get_withdrawal_policy', {
      name: 'get_withdrawal_policy',
      description: 'Retrieves current SLA and conditions for user payout withdrawals',
      execute: async () => ({
        processingWindowHours: 24,
        policyNote: 'Withdrawal requests are processed and completed within 24 hours.'
      })
    });

    // 3. Verify WhatsApp Safety Routine
    this.tools.set('get_whatsapp_health_routine', {
      name: 'get_whatsapp_health_routine',
      description: 'Retrieves the 5-step daily account warmup routine to reduce WhatsApp ban rates',
      execute: async () => ({
        recommendedDays: '7-8 days',
        steps: [
          '3-5 trusted chats daily',
          '5 voice calls (3 mins each)',
          '3 video calls (10 mins each)',
          '10 mins community browsing',
          '2-3 status updates daily'
        ]
      })
    });
  }

  public async invoke(name: string, params: any): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool ${name} not found`);
    return await tool.execute(params);
  }

  public getAvailableTools(): Array<{ name: string; description: string }> {
    return Array.from(this.tools.values()).map(t => ({
      name: t.name,
      description: t.description
    }));
  }
}
