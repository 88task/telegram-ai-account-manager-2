import { TriageResult, TelegramIncomingMessage } from '../types.js';

export class UnansweredDetector {
  /**
   * Evaluates conversation context to determine if a response is truly necessary.
   */
  public analyze(
    currentMessage: TelegramIncomingMessage,
    recentHistory: Array<{ text?: string; isOutgoing: boolean; timestamp: number }>,
    myUserId: string
  ): TriageResult {
    // The current message itself is the decisive signal. Do not suppress a fresh inbound user message
    // simply because an earlier message in history was sent by us.
    if (currentMessage.senderId === myUserId) {
      return {
        replyRequired: false,
        reason: 'This message was sent by the account owner and does not require a reply.',
        lastMessageByMe: true,
        isConversationClosed: false,
        urgency: 'low'
      };
    }

    // A later outgoing message means this older/replayed inquiry was answered.
    // Earlier outgoing history must never hide a fresh inbound message.
    if (recentHistory.some(message => message.isOutgoing && message.timestamp > currentMessage.timestamp)) {
      return {
        replyRequired: false,
        reason: 'A newer outgoing message already answered this inquiry.',
        lastMessageByMe: true,
        isConversationClosed: false,
        urgency: 'low'
      };
    }

    const text = (currentMessage.text || '').trim().toLowerCase();

    // Polite conversation closers that do not require further follow-up
    const closingPhrases = [
      'thanks', 'thank you', 'okay thank you', 'ok thanks', 'ok got it',
      'noted', 'sounds good', 'sure thing', 'ok sir', 'ok bro', 'perfect thanks',
      'have a nice day', 'cool'
    ];

    const isClosed = closingPhrases.some(phrase => text === phrase || text.startsWith(phrase + '!') || text.startsWith(phrase + '.'));

    if (isClosed && recentHistory.length > 1) {
      return {
        replyRequired: false,
        reason: 'The message is a polite closing statement (e.g. "Thank you", "Noted").',
        lastMessageByMe: false,
        isConversationClosed: true,
        urgency: 'low'
      };
    }

    // Detect high urgency triggers
    const questionMarkers = ['?', 'when', 'how', 'status', 'update', 'urgent', 'asap', 'please confirm'];
    const hasQuestion = questionMarkers.some(q => text.includes(q));

    return {
      replyRequired: true,
      reason: hasQuestion ? 'Direct inquiry or request awaiting response.' : 'Incoming message requiring follow-up.',
      lastMessageByMe: false,
      isConversationClosed: false,
      urgency: hasQuestion ? 'high' : 'medium'
    };
  }
}
