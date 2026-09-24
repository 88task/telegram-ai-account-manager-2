/**
 * Multilingual Response Templates & Evaluations
 * Covers Hindi (Devanagari), Hinglish (Roman Hindi), and English for core LUMO scenarios:
 * 1. Task Timing
 * 2. Password Reset
 * 3. Supported Banks
 * 4. Account Linking (Multiple WhatsApp Binding Prevention)
 * 5. Referral Rewards (₹20 + 16%, 20-task threshold, valid bank)
 * 6. Privacy & Data Concerns ("LUMO is scam" debunk)
 */

export type LanguageCode = 'hi' | 'hinglish' | 'en';

export type LumoScenario =
  | 'task_timing'
  | 'password_reset'
  | 'supported_banks'
  | 'account_linking'
  | 'referral_rewards'
  | 'privacy_concerns'
  | 'whatsapp_ban_safety';

export interface MultilingualTemplate {
  scenario: LumoScenario;
  responses: Record<LanguageCode, string>;
  triggers: Record<LanguageCode, string[]>;
  evaluationCriteria: string[];
}

export const MULTILINGUAL_TEMPLATES: Record<LumoScenario, MultilingualTemplate> = {
  task_timing: {
    scenario: 'task_timing',
    responses: {
      en: 'Tasks do not have a fixed schedule. They are released based on advertiser availability. As soon as a task goes live, we immediately announce it in the group and you will receive an in-app notification.',
      hinglish: 'Task ka koi fixed time nahi hota, ye advertiser ke release par depend karta hai. Jaise hi task aayega, group me turant update diya jayega aur aapko notification bhi milega.',
      hi: 'टास्क का कोई निश्चित समय नहीं होता है, यह विज्ञापनदाता (advertiser) के रिलीज पर निर्भर करता है। जैसे ही कोई टास्क आएगा, ग्रुप में तुरंत सूचना दी जाएगी और आपको ऐप में नोटिफिकेशन भी मिल जाएगा।',
    },
    triggers: {
      en: ['when will task come', 'task time', 'what time task', 'no task available'],
      hinglish: ['task kab aayega', 'kitne baje aayega', 'task timing', 'task nahi aa raha', 'kab task hoga'],
      hi: ['टास्क कब आएगा', 'कितने बजे टास्क आएगा', 'टास्क का समय', 'टास्क नहीं आ रहा'],
    },
    evaluationCriteria: [
      'Must NOT promise a specific hour or fixed schedule.',
      'Must explain advertiser dependency.',
      'Must assure immediate group update and push notification.'
    ]
  },

  password_reset: {
    scenario: 'password_reset',
    responses: {
      en: 'You can reset your password yourself directly on the platform. Go to the login page (lumodone.com/login) and click on "Forgot Password" to receive a password reset link.',
      hinglish: 'Aap apna password khud reset kar sakte ho. lumodone.com/login par jao aur "Forgot Password" option par click karo, wahan se easily reset ho jayega.',
      hi: 'आप अपना पासवर्ड खुद रीसेट कर सकते हैं। लॉगिन पेज (lumodone.com/login) पर जाएं और "Forgot Password" विकल्प पर क्लिक करें, वहां से आपका पासवर्ड रीसेट हो जाएगा।',
    },
    triggers: {
      en: ['forgot password', 'reset password', 'cannot login', 'lost password'],
      hinglish: ['password bhool gaya', 'password reset kaise kare', 'login nahi ho raha', 'password bhul gya'],
      hi: ['पासवर्ड भूल गया', 'पासवर्ड रीसेट कैसे करें', 'लॉगिन नहीं हो रहा'],
    },
    evaluationCriteria: [
      'Must direct user to self-service "Forgot Password".',
      'Must link to lumodone.com/login.',
      'Must NEVER ask the user to share their existing password or OTP.'
    ]
  },

  supported_banks: {
    scenario: 'supported_banks',
    responses: {
      en: 'LUMO currently supports 23 Indian banks, including SBI, Bank of Baroda, Bank of India, PNB, Canara Bank, Union Bank, HDFC, ICICI, Kotak Mahindra, Axis, IndusInd, YES Bank, and IDFC FIRST Bank. We are continuously adding more banks.',
      hinglish: 'LUMO me filhal 23 major Indian banks supported hain, jaise SBI, BoB, BoI, PNB, Canara Bank, Union Bank, HDFC, ICICI, Kotak Mahindra, aur IDFC FIRST. Baki banks bhi jaldi add ho rahe hain.',
      hi: 'LUMO वर्तमान में 23 प्रमुख भारतीय बैंकों का समर्थन करता है, जिनमें SBI, BoB, BoI, PNB, Canara Bank, Union Bank, HDFC, ICICI, Kotak Mahindra, और IDFC FIRST शामिल हैं। हम लगातार नए बैंक जोड़ रहे हैं।',
    },
    triggers: {
      en: ['supported bank', 'which bank', 'can i use sbi', 'bank list', 'hdfc supported'],
      hinglish: ['kaun sa bank chalega', 'bank list kya hai', 'sbi chalega kya', 'mera bank add nahi ho raha', 'supported banks'],
      hi: ['कौन सा बैंक चलेगा', 'बैंक लिस्ट', 'क्या SBI सपोर्टेड है', 'समर्थित बैंक'],
    },
    evaluationCriteria: [
      'Must confirm whether the queried bank is in the supported 23-bank list.',
      'Must mention continuous expansion of the supported list.'
    ]
  },

  account_linking: {
    scenario: 'account_linking',
    responses: {
      en: 'Important: Binding the same WhatsApp account across multiple LUMO IDs is strictly prohibited. Our automated system detects duplicate links and permanently disqualifies those accounts from referral bonuses and rewards.',
      hinglish: 'Dhyan rakhein: Ek hi WhatsApp number ko multiple LUMO IDs me link karna strictly prohibited hai. Agar koi referral bonus ke chakkar me aisa karega toh system detect karke account ko ineligible kar dega.',
      hi: 'ध्यान दें: एक ही WhatsApp नंबर को एक से अधिक LUMO आईडी में जोड़ना सख्त मना है। सिस्टम इसे तुरंत पकड़ लेता है और दोनों खातों को रेफरल बोनस और रिवार्ड के लिए अयोग्य (ineligible) कर देता है।',
    },
    triggers: {
      en: ['link multiple accounts', 'same whatsapp two accounts', 'bind multiple id', 'two lumo accounts'],
      hinglish: ['ek whatsapp do lumo me', 'multiple id link', 'same number use kar sakte hai', 'do account me ek whatsapp'],
      hi: ['एक व्हाट्सएप दो आईडी में', 'मल्टीपल अकाउंट', 'एक ही नंबर दो खातों में'],
    },
    evaluationCriteria: [
      'Must emphasize prohibition of multi-binding.',
      'Must state automated fraud detection.',
      'Must warn about ineligibility for rewards and referral bonuses.'
    ]
  },

  referral_rewards: {
    scenario: 'referral_rewards',
    responses: {
      en: 'With the LUMO referral program, you receive ₹20 plus a 16% lifetime commission. The reward is credited once your referred friend completes 20 effective WhatsApp tasks and links a valid supported bank account.',
      hinglish: 'LUMO me referral par aapko ₹20 aur 16% lifetime commission milta hai. Reward tabhi credit hota hai jab aapka dost 20 effective WhatsApp tasks complete kare aur ek valid bank account add kare.',
      hi: 'LUMO रेफरल प्रोग्राम में आपको ₹20 और 16% लाइफटाइम कमीशन मिलता है। यह रिवार्ड तभी मिलता है जब आपका दोस्त 20 प्रभावी (effective) व्हाट्सएप टास्क पूरे करता है और एक मान्य बैंक खाता जोड़ता है।',
    },
    triggers: {
      en: ['referral reward', 'referral bonus', 'how much refer', 'commission rate', 'refer rule'],
      hinglish: ['referral ka kitna milega', 'refer bonus kab aayega', '20 inr refer', '16% commission', 'referral rules'],
      hi: ['रेफरल का कितना मिलेगा', 'रेफरल बोनस', 'कमीशन कितना है', 'रेफरल नियम'],
    },
    evaluationCriteria: [
      'Must state ₹20 + 16% lifetime commission explicitly.',
      'Must specify the mandatory condition: 20 completed tasks + valid bank added.',
      'Must not promise instant credit prior to task completion.'
    ]
  },

  privacy_concerns: {
    scenario: 'privacy_concerns',
    responses: {
      en: 'We completely respect your privacy. LUMO does not access your personal chats, contacts, or media. We only verify whether the designated task message was sent. Your private data remains untouched and secure on your device.',
      hinglish: 'Bhai bilkul fikar mat karo. LUMO aapke personal chats, photos ya contact data ko bilkul access nahi karta. Hum sirf itna check karte hain ki task wala message send hua ya nahi. Aapka data 100% safe hai.',
      hi: 'आपकी गोपनीयता पूरी तरह सुरक्षित है। LUMO आपके व्यक्तिगत संदेशों, संपर्कों या फोटो को बिल्कुल भी एक्सेस नहीं करता है। हम केवल यह जांचते हैं कि निर्धारित टास्क संदेश भेजा गया है या नहीं। आपका डेटा पूरी तरह सुरक्षित है।',
    },
    triggers: {
      en: ['is this scam', 'data leak', 'access my chats', 'steal personal data', 'privacy safe'],
      hinglish: ['ye scam hai kya', 'mera data chori hoga', 'personal chat padhte ho', 'scam platform', 'fraud hai'],
      hi: ['क्या यह स्कैम है', 'डेटा चोरी', 'व्यक्तिगत चैट सुरक्षित है', 'धोखाधड़ी'],
    },
    evaluationCriteria: [
      'Must firmly but politely reassure without being defensive.',
      'Must clarify zero access to personal messages/contacts.',
      'Must explain minimal verification scope (message sent vs not sent).'
    ]
  },

  whatsapp_ban_safety: {
    scenario: 'whatsapp_ban_safety',
    responses: {
      en: 'To keep your WhatsApp account safe: 1) Chat with 3-5 trusted friends daily, 2) Make 5 voice calls (3 mins each), 3) Make 3 video calls daily, 4) Browse WhatsApp communities for 10 minutes, and 5) Post 2-3 status updates daily. Follow these steps for 7-8 days and do not connect your account to other platforms.',
      hinglish: 'WhatsApp account healthy rakhne ke liye ye tips 7-8 din follow karo: 1) Roz 3-5 dosto se chat karo, 2) 5 voice calls (3 min each), 3) 3 video calls, 4) Communities 10 min browse karo, 5) Status par 2-3 baar photo lagao. LUMO ke alawa kisi aur platform pe WhatsApp bind mat karna.',
      hi: 'व्हाट्सएप अकाउंट सुरक्षित रखने के लिए 7-8 दिन यह नियम अपनाएं: 1) रोज 3-5 परिचितों से चैट करें, 2) 5 वॉइस कॉल करें (लगभग 3 मिनट), 3) 3 वीडियो कॉल करें, 4) 10 मिनट कम्युनिटीज ब्राउज करें, 5) स्टेटस पर 2-3 बार फोटो लगाएं। LUMO के अलावा किसी अन्य प्लेटफॉर्म पर बाइंड न करें।',
    },
    triggers: {
      en: ['whatsapp banned', 'account restricted', 'how to prevent ban', 'whatsapp safety'],
      hinglish: ['whatsapp ban ho gaya', 'baar baar ban ho raha', 'ban se kaise bache', 'account block'],
      hi: ['व्हाट्सएप बैन हो गया', 'अकाउंट ब्लॉक', 'बैन से कैसे बचें', 'व्हाट्सएप सुरक्षा'],
    },
    evaluationCriteria: [
      'Must NOT accuse user of spamming or bulk messaging.',
      'Must list the 5 daily health routines.',
      'Must recommend 7-8 day warm-up period.',
      'Must forbid multi-platform binding.'
    ]
  }
};

/**
 * Detects language from message text (Hindi script, Hinglish phonetics, or English).
 */
export function detectLanguage(text: string): LanguageCode {
  // Check for Devanagari Unicode block (ऀ-ॿ)
  if (/[ऀ-ॿ]/.test(text)) {
    return 'hi';
  }

  const hinglishMarkers = [
    'kya', 'hai', 'kare', 'kaise', 'kab', 'aayega', 'nahi', 'bhai', 'baje',
    'chahiye', 'mera', 'meri', 'karo', 'hoga', 'paise', 'dost', 'dekho', 'kuch'
  ];

  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);
  const matchCount = words.filter(w => hinglishMarkers.includes(w)).length;

  if (matchCount >= 2 || (words.length <= 4 && matchCount >= 1)) {
    return 'hinglish';
  }

  return 'en';
}
