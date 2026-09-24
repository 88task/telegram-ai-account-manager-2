export type OperatingMode = 'manual' | 'draft' | 'auto_pilot';

export interface TelegramIncomingMessage {
  messageId: number;
  chatId: string;
  senderId: string;
  senderUsername?: string;
  senderName?: string;
  isPrivateChat: boolean;
  isGroup: boolean;
  isChannel: boolean;
  text?: string;
  mediaBuffer?: Buffer;
  mediaMimeType?: string;
  timestamp: number;
}

export interface ScopeCheckResult {
  allowed: boolean;
  reason?: string;
  chatType: 'private' | 'group' | 'channel';
}

export interface TriageResult {
  replyRequired: boolean;
  reason: string;
  lastMessageByMe: boolean;
  isConversationClosed: boolean;
  urgency: 'low' | 'medium' | 'high';
}

export interface SafetyResult {
  safeForAutoPilot: boolean;
  escalationReasons: string[];
  sensitiveCategory?: 'payment' | 'dispute' | 'anger' | 'legal' | 'deal' | 'unknown';
}

export interface GeneratedReply {
  text: string;
  confidence: number;
  reasoning: string;
}

export interface DecisionResult {
  action: 'ignored' | 'draft_queued' | 'approval_required' | 'auto_sent';
  replyText?: string;
  confidence: number;
  reason: string;
}
