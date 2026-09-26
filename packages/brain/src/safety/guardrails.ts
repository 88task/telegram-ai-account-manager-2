import { SafetyResult, TelegramIncomingMessage } from '../types.js';

export class SafetyGuardrails {
  /**
   * Screens the conversation against high-risk categories that require human approval.
   */
  public evaluate(message: TelegramIncomingMessage, conversationHistoryText: string): SafetyResult {
    const text = ((message.text || '') + ' ' + conversationHistoryText).toLowerCase();
    const escalationReasons: string[] = [];
    let sensitiveCategory: SafetyResult['sensitiveCategory'] = undefined;

    // 1. Payment, Financial & Disputes
    const financialKeywords = ['refund', 'dispute', 'chargeback', 'bank transfer', 'wire', 'usdt', 'crypto', 'invoice error', 'payment missing'];
    if (financialKeywords.some(kw => text.includes(kw))) {
      escalationReasons.push('Financial, payment dispute, or refund request detected.');
      sensitiveCategory = 'payment';
    }

    // 2. Anger & Customer Frustration
    const angerKeywords = ['angry', 'unacceptable', 'scam', 'cheat', 'complaint', 'lawyer', 'legal action', 'sue', 'police', 'terrible service'];
    if (angerKeywords.some(kw => text.includes(kw))) {
      escalationReasons.push('Customer frustration, anger, or legal threat detected.');
      sensitiveCategory = ['lawyer', 'legal action', 'sue'].some(k => text.includes(k)) ? 'legal' : 'anger';
    }

    // 3. High-Value Business Deals & Partnerships
    const dealKeywords = ['partnership', 'contract', 'nda', 'acquisition', 'investor', 'equity', 'revenue share'];
    if (dealKeywords.some(kw => text.includes(kw))) {
      escalationReasons.push('Strategic business deal, partnership, or contract discussion.');
      sensitiveCategory = 'deal';
    }

    // If media is present without OCR or explanation, flag for human verification
    if (message.mediaBuffer && (!message.text || message.text.length < 5)) {
      escalationReasons.push('Standalone image attachment requires human inspection.');
    }

    return {
      safeForAutoPilot: escalationReasons.length === 0,
      escalationReasons,
      sensitiveCategory
    };
  }
}
