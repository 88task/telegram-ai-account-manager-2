import { TelegramIncomingMessage } from '../types.js';

export interface UserModerationState {
  userId: string;
  chatId: string;
  strikeCount: number;
  scamAccusationCount: number;
  abusiveMessageCount: number;
  lastViolationAt: number;
  isFlaggedForRemoval: boolean;
  history: Array<{ text: string; score: number; violations: string[]; timestamp: number }>;
}

export interface ModerationEvaluation {
  riskScore: number; // 0 (completely safe) to 100 (severe violation)
  isSafeToAutoReply: boolean;
  requiresHumanReview: boolean;
  recommendedAction: 'allow' | 'warn_in_approval_queue' | 'review_for_removal' | 'blocked';
  detectedViolations: string[];
  explanation: string;
}

export class ModerationScorer {
  // In-memory state cache (backed by RDS in production)
  private userStates: Map<string, UserModerationState> = new Map();

  // Keyword rules with weighted severity
  private severeAbuseKeywords = [
    'madarchod', 'behenchod', 'bhosdike', 'chutiya', 'harami', 'gaand', 'randi',
    'motherfucker', 'fuck you', 'asshole', 'bastard', 'bitch'
  ];

  private scamAccusationKeywords = [
    'scam', 'fraud', 'chor', 'lootera', '420', 'fake platform', 'data chor',
    'cheat', 'bogus', 'police complaint', 'cyber crime', 'fir karunga'
  ];

  private paymentDisputeKeywords = [
    'paisa nahi mila', 'payment stuck', 'chargeback', 'refund now', 'scammed my money',
    '24 hours passed', 'withdrawal failed', 'bank rejected'
  ];

  private policyViolationKeywords = [
    'multiple accounts', 'fake referral', 'script bot', 'auto clicker', 'bypass verification'
  ];

  private getOrCreateState(userId: string, chatId: string): UserModerationState {
    let state = this.userStates.get(userId);
    if (!state) {
      state = {
        userId,
        chatId,
        strikeCount: 0,
        scamAccusationCount: 0,
        abusiveMessageCount: 0,
        lastViolationAt: 0,
        isFlaggedForRemoval: false,
        history: []
      };
      this.userStates.set(userId, state);
    }
    return state;
  }

  /**
   * Scores incoming message for risk and manages progressive escalation.
   * Safety invariant: The AI NEVER removes a user autonomously.
   * Severe/repeat offenders are queued for Human Admin Approval.
   */
  public evaluate(message: TelegramIncomingMessage): ModerationEvaluation {
    const text = (message.text || '').toLowerCase();
    const state = this.getOrCreateState(message.senderId, message.chatId);

    const detectedViolations: string[] = [];
    let riskScore = 0;

    // 1. Severe Profanity / Abuse
    const hasSevereAbuse = this.severeAbuseKeywords.some(kw => text.includes(kw));
    if (hasSevereAbuse) {
      riskScore += 65;
      detectedViolations.push('Severe verbal abuse / profanity');
      state.abusiveMessageCount++;
    }

    // 2. Scam Accusations
    const hasScamAccusation = this.scamAccusationKeywords.some(kw => text.includes(kw));
    if (hasScamAccusation) {
      riskScore += 35;
      detectedViolations.push('Scam accusation / fraud claim');
      state.scamAccusationCount++;
    }

    // 3. Payment Disputes & Overdue Payouts
    const hasPaymentDispute = this.paymentDisputeKeywords.some(kw => text.includes(kw));
    if (hasPaymentDispute) {
      riskScore += 30;
      detectedViolations.push('Payment dispute / withdrawal grievance');
    }

    // 4. Cheating / Script / Multi-account exploits
    const hasExploit = this.policyViolationKeywords.some(kw => text.includes(kw));
    if (hasExploit) {
      riskScore += 40;
      detectedViolations.push('Platform exploitation / unauthorized manipulation');
    }

    // 5. Factor in previous strikes
    if (state.strikeCount > 0) {
      riskScore += Math.min(30, state.strikeCount * 10);
    }

    // Cap score at 100
    riskScore = Math.min(100, riskScore);

    // Update state history
    if (detectedViolations.length > 0) {
      state.strikeCount++;
      state.lastViolationAt = Date.now();
      state.history.push({
        text: message.text || '',
        score: riskScore,
        violations: detectedViolations,
        timestamp: Date.now()
      });
    }

    // Determine Action & Human Routing
    let recommendedAction: ModerationEvaluation['recommendedAction'] = 'allow';
    let requiresHumanReview = false;
    let isSafeToAutoReply = true;

    // RULE: Repeated scam accusations (>= 2) or repeated abuse (>= 2)
    // must NOT be auto-answered. Route to human with "review_for_removal" recommendation.
    if (state.scamAccusationCount >= 2 || state.abusiveMessageCount >= 2 || state.strikeCount >= 3) {
      recommendedAction = 'review_for_removal';
      requiresHumanReview = true;
      isSafeToAutoReply = false;
      state.isFlaggedForRemoval = true;
    } else if (riskScore >= 40 || hasPaymentDispute) {
      recommendedAction = 'warn_in_approval_queue';
      requiresHumanReview = true;
      isSafeToAutoReply = false;
    }

    return {
      riskScore,
      isSafeToAutoReply,
      requiresHumanReview,
      recommendedAction,
      detectedViolations,
      explanation: detectedViolations.length > 0
        ? `Violations detected: ${detectedViolations.join(', ')}. (Strikes: ${state.strikeCount}, Scam Accusations: ${state.scamAccusationCount})`
        : 'Message is compliant with community guidelines.'
    };
  }

  public getHistory(userId: string): UserModerationState | undefined {
    return this.userStates.get(userId);
  }

  public resetStrikes(userId: string): void {
    const s = this.userStates.get(userId);
    if (s) {
      s.strikeCount = 0;
      s.isFlaggedForRemoval = false;
    }
  }
}
