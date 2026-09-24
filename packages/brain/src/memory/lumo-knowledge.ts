/**
 * LUMO Platform Knowledge Base
 * Business rules, support scripts, and safety policies for the LUMO task platform.
 * Loaded by the Brain's Context Builder (Layer 4) when composing replies.
 */

export interface KnowledgeEntry {
  id: string;
  category: 'safety' | 'banks' | 'earning' | 'referral' | 'withdrawal' | 'support' | 'policy' | 'anti_scam';
  title: string;
  content: string;
  keywords: string[];
}

export const LUMO_SAFETY_TIPS = `
📢 LUMO WhatsApp Safety Tips (to reduce ban/restriction risk):
1. Add 3-5 trusted contacts and chat with them every day (text, photos, or GIFs).
2. Make at least 5 voice calls daily (around 3 minutes each).
3. Make 3 video calls daily (around 10 minutes each).
4. Join WhatsApp Communities and browse content for at least 10 minutes every day.
5. Upload photos to WhatsApp Status 2-3 times a day (2-5 photos each time).

Important:
- Do NOT link the same WhatsApp account to multiple task platforms.
- Keep the account active with normal daily activity.
- If a user says their WhatsApp keeps getting banned: do NOT blame bulk messaging or spam. Instead, tell them to follow the LUMO safety tips for 7-8 days and never bind their WhatsApp to any platform other than LUMO.
`.trim();

export const LUMO_SUPPORTED_BANKS = [
  'State Bank of India (SBI)', 'Bank of Baroda (BoB)', 'Bank of India (BoI)',
  'Bank of Maharashtra', 'Canara Bank', 'Central Bank of India',
  'Indian Overseas Bank (IOB)', 'Indian Bank', 'Punjab National Bank (PNB)',
  'Punjab & Sind Bank', 'UCO Bank', 'Union Bank of India', 'HDFC Bank',
  'ICICI Bank', 'Kotak Mahindra Bank', 'IndusInd Bank', 'YES Bank',
  'IDFC FIRST Bank', 'Federal Bank', 'Bandhan Bank', 'South Indian Bank',
  'RBL Bank', 'City Union Bank', 'IDBI Bank',
];

export const LUMO_KNOWLEDGE: KnowledgeEntry[] = [
  {
    id: 'earning_model',
    category: 'earning',
    title: 'How users earn on LUMO',
    content: `Users earn by linking their WhatsApp and sending messages manually.
- ₹4 per successfully sent message.
- Only WhatsApp tasks are currently live on the platform; RCS tasks are a possible future feature.
- Task timing is NOT fixed. Tasks release depending on the advertiser. When a task is released, the group is notified immediately and users receive a notification.`,
    keywords: ['earn', 'money', 'paise', 'task', 'kab aayega', 'payment per message', 'rcs', 'fixed time'],
  },
  {
    id: 'referral_rewards',
    category: 'referral',
    title: 'Referral program',
    content: `- Referral reward: ₹20 + 16% lifetime commission.
- Condition: the friend must create a LUMO account using the referral link AND complete 20 WhatsApp message tasks.
- Reward is credited only after the user completes 20 effective tasks AND adds a valid bank account.
- Linking the same WhatsApp to multiple LUMO IDs is PROHIBITED. The system detects this and marks the accounts ineligible for referral bonus.`,
    keywords: ['referral', 'refer', 'bonus', 'commission', '20 inr', '16%', 'multiple id'],
  },
  {
    id: 'withdrawal_cycle',
    category: 'withdrawal',
    title: 'Withdrawal processing',
    content: `Withdrawal requests are processed and completed within 24 hours. Thank the user for their patience and assure them the request is being handled properly.`,
    keywords: ['withdrawal', 'withdraw', 'payout', 'bank transfer', '24 hours', 'paisa kab aayega'],
  },
  {
    id: 'password_reset',
    category: 'support',
    title: 'Password reset',
    content: `Users reset their own password using the "Forgot Password" option on the platform. Do not offer to reset it for them; guide them to the option.`,
    keywords: ['password', 'reset', 'forgot password', 'login problem'],
  },
  {
    id: 'official_links',
    category: 'support',
    title: 'Official LUMO links',
    content: `- Register: https://lumodone.com/register
- Login: https://lumodone.com/login
- Download: https://lumodone.com/download`,
    keywords: ['link', 'register', 'login', 'download', 'app', 'site'],
  },
  {
    id: 'download_32bit',
    category: 'support',
    title: 'App download / 32-bit vs 64-bit phones',
    content: `If a user cannot download LUMO, ask whether their phone is 32-bit or 64-bit. If the phone is 32-bit, tell them to download the 32-bit version from the download page.`,
    keywords: ['download nahi ho raha', 'install', '32 bit', '64 bit', 'apk'],
  },
  {
    id: 'scam_claims',
    category: 'anti_scam',
    title: 'Handling "LUMO is a scam" accusations',
    content: `Some users accuse the platform of being a scam and claim that linking WhatsApp sends their data away.
Response approach:
- Reassure politely: the platform does not access data; it only checks whether the message was sent or not.
- Control such users gently and intelligently.
- If a user repeatedly makes serious accusations or misbehaves, escalate to a human admin (approval queue) — the AI must never remove users from groups or issue threats on its own.
Note: there can be many scammers inside groups; stay cautious of impersonation claims.`,
    keywords: ['scam', 'fraud', 'data', 'cheat', 'galat', 'bakwas'],
  },
  {
    id: 'screenshot_support',
    category: 'support',
    title: 'Screenshot review',
    content: `If a user sends a screenshot of an issue: inspect the image, identify the visible problem, and if the issue is unclear, ask the user to explain what the issue is. (Multimodal image analysis is handled by the Bedrock vision engine.)`,
    keywords: ['screenshot', 'photo', 'image', 'error'],
  },
];

export function searchKnowledge(query: string): KnowledgeEntry[] {
  const q = query.toLowerCase();
  return LUMO_KNOWLEDGE.filter(entry =>
    entry.keywords.some(kw => q.includes(kw)) || q.includes(entry.title.toLowerCase())
  );
}
