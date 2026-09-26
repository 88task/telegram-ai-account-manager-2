import { DecisionResult, GeneratedReply, OperatingMode, SafetyResult } from '../types.js';

export class ModeDispatcher {
  private confidenceThreshold: number;

  constructor(confidenceThreshold?: number) {
    const threshold = confidenceThreshold ?? Number(process.env.AUTO_PILOT_CONFIDENCE_THRESHOLD || '0.85');
    this.confidenceThreshold = Number.isFinite(threshold) && threshold >= 0 && threshold <= 1 ? threshold : 0.85;
  }

  public dispatch(
    mode: OperatingMode,
    reply: GeneratedReply,
    safety: SafetyResult
  ): DecisionResult {
    if (!reply.text?.trim() || !Number.isFinite(reply.confidence) || reply.confidence < 0 || reply.confidence > 1) {
      return { action: 'approval_required', replyText: reply.text || '', confidence: 0, reason: 'Invalid or empty model response requires human review.' };
    }

    // 1. Safety escalation always supersedes auto-pilot
    if (!safety.safeForAutoPilot) {
      return {
        action: 'approval_required',
        replyText: reply.text,
        confidence: reply.confidence,
        reason: `Escalated for human review: ${safety.escalationReasons.join('; ')}`
      };
    }

    // 2. Manual Mode: store suggestion, do not send
    if (mode === 'manual') {
      return {
        action: 'draft_queued',
        replyText: reply.text,
        confidence: reply.confidence,
        reason: 'Manual mode active: suggestion logged for manual review.'
      };
    }

    // 3. Draft Mode: queue in dashboard for 1-click approval
    if (mode === 'draft') {
      return {
        action: 'approval_required',
        replyText: reply.text,
        confidence: reply.confidence,
        reason: 'Draft mode active: waiting for one-click approval.'
      };
    }

    // 4. Auto-Pilot Mode: auto-send if confidence meets threshold
    if (mode === 'auto_pilot') {
      if (reply.confidence >= this.confidenceThreshold) {
        return {
          action: 'auto_sent',
          replyText: reply.text,
          confidence: reply.confidence,
          reason: `Auto-Pilot executed: Confidence ${reply.confidence} >= threshold ${this.confidenceThreshold}.`
        };
      }

      return {
        action: 'approval_required',
        replyText: reply.text,
        confidence: reply.confidence,
        reason: `Confidence ${reply.confidence} below auto-pilot threshold (${this.confidenceThreshold}). Routed to approvals.`
      };
    }

    return {
      action: 'draft_queued',
      replyText: reply.text,
      confidence: reply.confidence,
      reason: 'Default fallback action'
    };
  }
}
