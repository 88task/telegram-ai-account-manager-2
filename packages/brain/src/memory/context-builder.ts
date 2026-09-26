import { LUMO_KNOWLEDGE, LUMO_SAFETY_TIPS, LUMO_SUPPORTED_BANKS, searchKnowledge } from './lumo-knowledge.js';
import { db, knowledgeItems, desc } from '@telegram-ai/db';

export interface MemoryContext {
  approvedExamples: Array<{ userMessage: string; approvedReply: string }>;
  businessRules: string[];
  contactNotes?: string;
  ownerStyleGuide: string;
}

export class ContextBuilder {
  /**
   * Assembles relevant memory, style guide, and verified examples from static knowledge
   * and dynamic active knowledgeItems from PostgreSQL.
   */
  public async buildContextForContact(
    contactId: string,
    queryKeywords: string[]
  ): Promise<MemoryContext> {
    const dynamicRules: string[] = [];
    const dynamicApprovedExamples: Array<{ userMessage: string; approvedReply: string }> = [];

    try {
      const items = await db.select().from(knowledgeItems).orderBy(desc(knowledgeItems.createdAt)).limit(50);
      for (const item of items) {
        if (item.category === 'rule' || item.category === 'faq') {
          const prefix = item.category.toUpperCase();
          const trigger = item.questionOrTrigger ? `${item.questionOrTrigger}: ` : '';
          dynamicRules.push(`[${prefix}] ${trigger}${item.content}`);
        } else if (item.category === 'approved_reply') {
          try {
            const parsed = JSON.parse(item.content);
            dynamicApprovedExamples.push({
              userMessage: item.questionOrTrigger || '',
              approvedReply: parsed.approvedVersion || item.content
            });
          } catch {
            dynamicApprovedExamples.push({
              userMessage: item.questionOrTrigger || '',
              approvedReply: item.content
            });
          }
        }
      }
    } catch (err) {
      console.warn('[ContextBuilder] Failed to query dynamic knowledgeItems from database:', err);
    }

    // Business rule set: dynamic DB knowledge + LUMO platform policies + permanent ban rules
    const businessRules: string[] = [
      ...dynamicRules,
      ...LUMO_KNOWLEDGE.map(e => `[${e.category.toUpperCase()}] ${e.title}: ${e.content}`),
      `Supported banks: ${LUMO_SUPPORTED_BANKS.join(', ')}.`,
      `WhatsApp safety tips to share with users (ONLY for account warm-up and temporary ban prevention, NOT for permanent bans):
${LUMO_SAFETY_TIPS}`,
      `Permanent WhatsApp Ban Policy: If user's WhatsApp is permanently banned or shows "This account can't use WhatsApp" / "Requesting a review is not available", do NOT suggest the 7-8 day warm-up tips. Instead, instruct them to appeal via WhatsApp Support in-app, visit whatsapp.com/contact, or email support@whatsapp.com with their country code and phone number stating it was a mistake, and wait 24-72 hours. Advise avoiding modified apps (GBWhatsApp) and bulk spam.`
    ];

    return {
      ownerStyleGuide: `
- Tone: Friendly support agent for the LUMO platform. Warm, patient, direct, concise.
- Reply in the user's language: match Hinglish with Hinglish, English with English.
- Never sound like an AI assistant. Use natural first-person phrasing ("I", "our team").
- Keep replies short and reassuring. Do not over-explain.
- Current task payout is ₹2.50 per successfully sent message. Never quote old ₹4 or ₹5 rates.
- Never invent task timings: tasks depend on advertiser release; inform users that notifications are sent as soon as tasks drop.
- Tasks run in batches; background verification takes ~10 minutes before auto-crediting wallet.
- WhatsApp fetch/connecting takes ~10 minutes.
- If WhatsApp is PERMANENTLY banned ("can't use WhatsApp"), do NOT give 7-8 day safety tips. Instruct them to appeal to WhatsApp Support / support@whatsapp.com (24-72h wait).
- Escalate to a human (approval queue) for: scam accusations, payment disputes beyond 24 hours, and severe abuse.
      `.trim(),
      businessRules,
      approvedExamples: [
        ...dynamicApprovedExamples,
        {
          userMessage: "WhatsApp permanently ban ho geya",
          approvedReply: "Agar aapka WhatsApp permanently ban ho gaya hai ya 'This account can't use WhatsApp' show ho raha hai, toh WhatsApp support team se appeal karein: 1. WhatsApp open karke 'Support' par jayein ya whatsapp.com/contact par Account Issue -> Banned Account chunein. 2. Ya support@whatsapp.com par email karein (+country code + phone number) aur review request karein. 24-72 ghante wait karein aur GBWhatsApp jaisi modified apps use na karein."
        },
        {
          userMessage: "My WhatsApp is permanently banned, what should I do?",
          approvedReply: "If your WhatsApp is permanently banned, please appeal directly to WhatsApp: 1) Tap 'Support' in WhatsApp or go to whatsapp.com/contact -> Account Issue -> Banned Account. 2) Or email support@whatsapp.com with your phone number explaining it was a mistake. Wait 24-72 hours for review."
        },
        {
          userMessage: "Per task kitna paise milega",
          approvedReply: "LUMO me har successful WhatsApp task message send karne par ₹2.50 milta hai. Iske sath referral reward ₹20 + 16% lifetime commission milta hai jab friend valid bank add karke 20 tasks complete karta hai."
        },
        {
          userMessage: "Task reward wallet me credit nahi hua",
          approvedReply: "Tasks batch-wise hote hain aur message send karne ke baad background verification me lagbhag 10 minutes lagte hain. Verification complete hote hi reward automatically aapke wallet me credit ho jata hai."
        },
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
        }
      ],
      contactNotes: "LUMO platform user / group member."
    };
  }
}

export { LUMO_KNOWLEDGE, LUMO_SUPPORTED_BANKS, searchKnowledge };
