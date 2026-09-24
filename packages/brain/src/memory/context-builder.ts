export interface MemoryContext {
  approvedExamples: Array<{ userMessage: string; approvedReply: string }>;
  businessRules: string[];
  contactNotes?: string;
  ownerStyleGuide: string;
}

export class ContextBuilder {
  /**
   * Assembles relevant memory, style guide, and verified examples from the database.
   */
  public async buildContextForContact(
    contactId: string,
    queryKeywords: string[]
  ): Promise<MemoryContext> {
    // In production, queries the RDS knowledge_items and contact_profiles tables
    return {
      ownerStyleGuide: `
- Tone: Professional, warm, direct, concise.
- Never make unverified financial or technical promises.
- Mirror the user language (English / Hindi / Hinglish if addressed).
- Do not sound like an AI assistant. Use natural first-person phrasing ("I", "my team").
- Keep replies under 3-4 sentences whenever possible.
      `.trim(),
      businessRules: [
        'Payment confirmations are processed Monday to Friday between 10 AM and 6 PM IST.',
        'Technical onboarding takes 24 hours after credential verification.',
        'Support tickets can be submitted directly via email or the support panel.'
      ],
      approvedExamples: [
        {
          userMessage: "Sir, when will the payment be processed?",
          approvedReply: "Checking this with the accounts team right now. I'll get back to you with the confirmation within an hour."
        },
        {
          userMessage: "Can we hop on a quick call today?",
          approvedReply: "I'm tied up in meetings until 4 PM today. Does 5 PM work for you, or would tomorrow morning be better?"
        }
      ],
      contactNotes: "Valued client / partner contact."
    };
  }
}
