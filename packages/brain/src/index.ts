import { ScopeFilter } from './filters/scope-filter.js';
import { UnansweredDetector } from './triage/unanswered-detector.js';
import { SafetyGuardrails } from './safety/guardrails.js';
import { ContextBuilder } from './memory/context-builder.js';
import { BedrockGenerator } from './generator/bedrock-client.js';
import { ModeDispatcher } from './dispatcher/mode-dispatcher.js';
import { ModerationScorer, ModerationEvaluation } from './safety/moderation-scorer.js';
import { ScreenshotTriage, ScreenshotTriageResult } from './vision/screenshot-triage.js';
import { detectLanguage } from './evaluations/multilingual-responses.js';
import { DecisionResult, OperatingMode, TelegramIncomingMessage } from './types.js';

export interface EnrichedDecisionResult extends DecisionResult {
  moderation?: ModerationEvaluation;
  screenshotAnalysis?: ScreenshotTriageResult;
  detectedLanguage?: 'hi' | 'hinglish' | 'en';
}

export class BrainPipeline {
  private scopeFilter: ScopeFilter;
  private triageDetector: UnansweredDetector;
  private safetyGuardrails: SafetyGuardrails;
  private moderationScorer: ModerationScorer;
  private screenshotTriage: ScreenshotTriage;
  private contextBuilder: ContextBuilder;
  private generator: BedrockGenerator;
  private dispatcher: ModeDispatcher;
  private myUserId: string;

  constructor(myUserId: string) {
    this.myUserId = myUserId;
    this.scopeFilter = new ScopeFilter();
    this.triageDetector = new UnansweredDetector();
    this.safetyGuardrails = new SafetyGuardrails();
    this.moderationScorer = new ModerationScorer();
    this.screenshotTriage = new ScreenshotTriage();
    this.contextBuilder = new ContextBuilder();
    this.generator = new BedrockGenerator();
    this.dispatcher = new ModeDispatcher();
  }

  public async processMessage(
    incoming: TelegramIncomingMessage,
    recentHistory: Array<{ role: 'user' | 'assistant'; text: string; isOutgoing: boolean; timestamp: number }>,
    mode: OperatingMode = 'draft'
  ): Promise<EnrichedDecisionResult> {
    // 1. Scope & Blocklist Filter (Drop channels / unapproved groups / blocked users)
    const scope = this.scopeFilter.check(incoming);
    if (!scope.allowed) {
      return {
        action: 'ignored',
        confidence: 1.0,
        reason: scope.reason || 'Filtered by scope rules.'
      };
    }

    // 2. Moderation Scoring (Profanity, repeated scam claims, payment disputes)
    const moderation = this.moderationScorer.evaluate(incoming);

    // If moderation flags severe abuse, repeat scam claims, or removal review:
    // Route straight to Human Approval Queue instead of auto-responding or removing
    if (moderation.requiresHumanReview && !moderation.isSafeToAutoReply) {
      return {
        action: 'approval_required',
        confidence: 0.95,
        reason: `[Moderation Alert - ${moderation.recommendedAction.toUpperCase()}]: ${moderation.explanation}`,
        moderation
      };
    }

    // 3. Screenshot Triage (If image attachment is present)
    let screenshotAnalysis: ScreenshotTriageResult | undefined;
    if (incoming.mediaBuffer && (incoming.mediaMimeType?.startsWith('image/') || !incoming.mediaMimeType)) {
      screenshotAnalysis = await this.screenshotTriage.triageImage(
        incoming.mediaBuffer,
        incoming.mediaMimeType,
        incoming.text
      );

      // If the screenshot is ambiguous or unreadable, ask the user to clarify
      if (screenshotAnalysis.isAmbiguous && screenshotAnalysis.recommendedClarificationPrompt) {
        return {
          action: mode === 'auto_pilot' ? 'auto_sent' : 'approval_required',
          replyText: screenshotAnalysis.recommendedClarificationPrompt,
          confidence: 0.9,
          reason: `Screenshot ambiguous: asking user for clarification. Issue: ${screenshotAnalysis.identifiedIssue}`,
          screenshotAnalysis
        };
      }
    }

    // 4. Unanswered & Closing Statement Detection
    const triage = this.triageDetector.analyze(incoming, recentHistory, this.myUserId);
    if (!triage.replyRequired && !screenshotAnalysis) {
      return {
        action: 'ignored',
        confidence: 0.95,
        reason: triage.reason,
        moderation
      };
    }

    // 5. Language Detection (Hindi, Hinglish, English)
    const detectedLanguage = detectLanguage(incoming.text || '');

    // 6. Safety Guardrails & Human Escalation
    const conversationText = recentHistory.map(m => m.text).join(' ');
    const safety = this.safetyGuardrails.evaluate(incoming, conversationText);

    // 7. Memory & LUMO Knowledge Assembly
    const memory = await this.contextBuilder.buildContextForContact(incoming.senderId, []);

    // 8. Bedrock Multimodal Converse API (Amazon Nova Pro)
    const reply = await this.generator.generateReply(incoming, recentHistory, memory);

    // 9. Dispatch to Manual, Draft, or Auto-Pilot
    const dispatchResult = this.dispatcher.dispatch(mode, reply, safety);

    return {
      ...dispatchResult,
      moderation,
      screenshotAnalysis,
      detectedLanguage
    };
  }

  public getModerationScorer(): ModerationScorer {
    return this.moderationScorer;
  }
}

export * from './types.js';
export * from './evaluations/multilingual-responses.js';
export * from './safety/moderation-scorer.js';
export * from './vision/screenshot-triage.js';
