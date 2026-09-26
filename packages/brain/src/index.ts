import { ScopeFilter } from './filters/scope-filter.js';
import { UnansweredDetector } from './triage/unanswered-detector.js';
import { SafetyGuardrails } from './safety/guardrails.js';
import { ContextBuilder } from './memory/context-builder.js';
import { BedrockGenerator } from './generator/bedrock-client.js';
import { ModeDispatcher } from './dispatcher/mode-dispatcher.js';
import { ModerationScorer, ModerationEvaluation } from './safety/moderation-scorer.js';
import { ScreenshotTriage, ScreenshotTriageResult } from './vision/screenshot-triage.js';
import { CognitiveOrchestrator, CognitiveExecutionResult } from './llm/cognitive-orchestrator.js';
import { FeedbackLearner } from './memory/feedback-learner.js';
import { BrainToolsRegistry } from './tools/brain-tools.js';
import { detectLanguage } from './evaluations/multilingual-responses.js';
import { DecisionResult, OperatingMode, TelegramIncomingMessage } from './types.js';

export interface EnrichedDecisionResult extends DecisionResult {
  moderation?: ModerationEvaluation;
  screenshotAnalysis?: ScreenshotTriageResult;
  detectedLanguage?: 'hi' | 'hinglish' | 'en';
  cognitiveExecution?: CognitiveExecutionResult;
}

export class BrainPipeline {
  private scopeFilter: ScopeFilter;
  private triageDetector: UnansweredDetector;
  private safetyGuardrails: SafetyGuardrails;
  private moderationScorer: ModerationScorer;
  private screenshotTriage: ScreenshotTriage;
  private contextBuilder: ContextBuilder;
  private cognitiveOrchestrator: CognitiveOrchestrator;
  private feedbackLearner: FeedbackLearner;
  private toolsRegistry: BrainToolsRegistry;
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
    this.cognitiveOrchestrator = new CognitiveOrchestrator();
    this.feedbackLearner = new FeedbackLearner();
    this.toolsRegistry = new BrainToolsRegistry();
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

    // Severe abuse or repeated violations route straight to Human Approval Queue
    if (moderation.requiresHumanReview && !moderation.isSafeToAutoReply) {
      return {
        action: 'approval_required',
        confidence: 0.95,
        reason: `[Moderation Alert - ${moderation.recommendedAction.toUpperCase()}]: ${moderation.explanation}`,
        moderation
      };
    }

    // 3. Screenshot Triage (Bedrock Nova Vision for image attachments)
    let screenshotAnalysis: ScreenshotTriageResult | undefined;
    if (incoming.mediaBuffer && (incoming.mediaMimeType?.startsWith('image/') || !incoming.mediaMimeType)) {
      screenshotAnalysis = await this.screenshotTriage.triageImage(
        incoming.mediaBuffer,
        incoming.mediaMimeType,
        incoming.text
      );

      // If ambiguous, clarify politely in Hinglish/English
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

    // 5. Language Detection
    const detectedLanguage = detectLanguage(incoming.text || '');

    // 6. Safety Guardrails & Human Escalation
    const conversationText = recentHistory.map(m => m.text).join(' ');
    const safety = this.safetyGuardrails.evaluate(incoming, conversationText);

    // 7. Context & Dynamic Few-Shot Memory Assembly
    const memory = await this.contextBuilder.buildContextForContact(incoming.senderId, []);
    const dynamicExemplars = await this.feedbackLearner.getDynamicExemplars(3);
    if (dynamicExemplars.length > 0) {
      memory.approvedExamples.unshift(...dynamicExemplars);
    }

    // 8. Cognitive Orchestrator Execution (Perceive -> Synthesize -> Self-Critique)
    const formattedHistory = recentHistory.map(m => ({
      role: m.role,
      text: m.text
    }));

    const cognitiveExecution = await this.cognitiveOrchestrator.execute(
      incoming,
      memory,
      formattedHistory
    );

    // 9. Dispatch to Manual, Draft, or Auto-Pilot based on Self-Critique Confidence
    const dispatchResult = this.dispatcher.dispatch(
      mode,
      {
        text: cognitiveExecution.finalReply,
        confidence: cognitiveExecution.critique.confidenceScore,
        reasoning: cognitiveExecution.critique.critiqueNotes
      },
      safety
    );

    return {
      ...dispatchResult,
      moderation,
      screenshotAnalysis,
      detectedLanguage,
      cognitiveExecution
    };
  }

  public setGeminiConfig(keys: string[], model?: string, mode?: 'auto' | 'gemini' | 'bedrock'): void {
    this.cognitiveOrchestrator.setGeminiConfig(keys, model, mode);
  }

  public updateScope(allowedGroups: string[], blockedUsers: string[]): void {
    this.scopeFilter.updateAllowedGroups(allowedGroups);
    this.scopeFilter.updateBlockedUsers(blockedUsers);
  }

  public getFeedbackLearner(): FeedbackLearner {
    return this.feedbackLearner;
  }

  public getToolsRegistry(): BrainToolsRegistry {
    return this.toolsRegistry;
  }
}

export * from './types.js';
export * from './evaluations/multilingual-responses.js';
export * from './safety/moderation-scorer.js';
export * from './vision/screenshot-triage.js';
export * from './llm/cognitive-orchestrator.js';
export * from './memory/feedback-learner.js';
export * from './tools/brain-tools.js';
