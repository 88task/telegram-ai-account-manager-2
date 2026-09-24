import { LUMO_KNOWLEDGE, LUMO_SAFETY_TIPS, LUMO_SUPPORTED_BANKS, searchKnowledge } from './lumo-knowledge.js';

export interface MemoryContext {
  approvedExamples: Array<{ userMessage: string; approvedReply: string }>;
  businessRules: string[];
  contactNotes?: string;
  ownerStyleGuide: string;
}

export class ContextBuilder {
  /**
   * Assembles relevant memory, style guide, and verified examples from the knowledge base.
   */
  public async buildContextForContact(
    contactId: string,
    queryKeywords: string[]
  ): Promise<MemoryContext> {
    // Pull the business rule set: LUMO platform policies + core operating rules
    const businessRules: string[] = [
      ...LUMO_KNOWLEDGE.map(e => `[${e.category.toUpperCase()}] ${e.title}: ${e.content}`),
      `Supported banks: ${LUMO_SUPPORTED_BANKS.join(', ')}.`,
      `WhatsApp safety tips to share with users:\n${LUMO_SAFETY_TIPS}`,
    ];

    return {
      ownerStyleGuide: `
- Tone: Friendly support agent for the LUMO platform. Warm, patient, direct, concise.
- Reply in the user's language: match Hinglish with Hinglish, English with English.
- Never sound like an AI assistant. Use natural first-person phrasing ("I", "our team").
- Keep replies short and reassuring. Do not over-explain.
- Never invent task timings: tasks depend on the advertiser's release; tell users they will get a notification and group update.
- Never promise a fix, refund, or exception outside documented policy.
- Escalate to a human (approval queue) for: ban complaints that persist, scam accusations, payment disputes beyond the 24-hour window, and any abuse.
      `.trim(),
      businessRules,
      approvedExamples: [
        {
          userMessage: "Sir, withdrawal kab tak aayega?",
          approvedReply: "Aapka withdrawal request process me hai aur 24 hours ke andar complete ho jayega. Patience ke liye dhanyawad!"
        },
        {
          userMessage: "Task kab aayega? Kitne baje aayega?",
          approvedReply: "Task ka fixed time nahi hota, wo advertiser ke release par depend karta hai. Jaise hi task release hoga, group me turant bataya jayega aur aapko notification bhi milega."
        },
        {
          userMessage: "Mera WhatsApp baar baar ban ho raha hai",
          approvedReply: "Aap LUMO ke safety tips 7-8 din follow karo: roz 3-5 trusted contacts se chat karo, 5 voice calls (3 min each), 3 video calls, communities browse karo, aur status par 2-3 baar photos daalo. Aur WhatsApp ko LUMO ke alawa kisi bhi platform se bind mat karo. Isse account healthy rahega."
        },
        {
          userMessage: "Ye platform scam hai, data hamare paas le jaate ho",
          approvedReply: "Bhai, aisa kuch nahi hota. Hum sirf check karte hain ki message sent hua ya nahi, koi data access nahi karte. Agar koi aur confusion hai to bataiye, main solve karne me help karunga."
        },
        {
          userMessage: "Password bhool gaya, kya karu?",
          approvedReply: "Aap Forgot Password option se apna password khud reset kar sakte ho. Wahan apna registered detail daalo, reset link mil jayega."
        },
      ],
      contactNotes: "LUMO platform user / group member."
    };
  }
}

export { LUMO_KNOWLEDGE, LUMO_SUPPORTED_BANKS, searchKnowledge };
