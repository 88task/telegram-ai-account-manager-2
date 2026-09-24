import { ScopeFilter } from './filters/scope-filter.js';
import { UnansweredDetector } from './triage/unanswered-detector.js';
import { SafetyGuardrails } from './safety/guardrails.js';
import { ContextBuilder } from './memory/context-builder.js';
import { BedrockGenerator } from './generator/bedrock-client.js';
import { ModeDispatcher } from './dispatcher/mode-dispatcher.js';
import { DecisionResult, OperatingMode, TelegramIncomingMessage } from './types.js';

export class BrainPipeline {
  private scopeFilter: ScopeFilter;
  private triageDetector: UnansweredDetector;
  private safetyGuardrails: SafetyGuardrails;
  private contextBuilder: ContextBuilder;
  private generator: BedrockGenerator;
  private dispatcher: ModeDispatcher;
  private myUserId: string;

  constructor(myUserId: string) {
    this.myUserId = myUserId;
    this.scopeFilter = new ScopeFilter();
    this.triageDetector = new UnansweredDetector();
    this.safetyGuardrails = new SafetyGuardrails();
    this.contextBuilder = new ContextBuilder();
    this.generator = new BedrockGenerator();
    this.dispatcher = new ModeDispatcher();
  }

  public async processMessage(
    incoming: TelegramIncomingMessage,
    recentHistory: Array<{ role: 'user' | 'assistant'; text: string; isOutgoing: boolean; timestamp: number }>,
    mode: OperatingMode = 'draft'
  ): Promise<DecisionResult> {
    // 1. Scope & Blocklist Filter
    const scope = this.scopeFilter.check(incoming);
    if (!scope.allowed) {
      return {
        action: 'ignored',
        confidence: 1.0,
        reason: scope.reason || 'Filtered by scope rules.'
      };
    }

    // 2. Unanswered Detection
    const triage = this.triageDetector.analyze(incoming, recentHistory, this.myUserId);
    if (!triage.replyRequired) {
      return {
        action: 'ignored',
        confidence: 0.95,
        reason: triage.reason
      };
    }

    // 3. Safety Guardrails & Human Escalation
    const conversationText = recentHistory.map(m => m.text).join(' ');
    const safety = this.safetyGuardrails.evaluate(incoming, conversationText);

    // 4. Memory & Knowledge Assembly
    const memory = await this.contextBuilder.buildContextForContact(incoming.senderId, []);

    // 5. Multimodal Generation via AWS Bedrock (Amazon Nova Pro)
    const reply = await this.generator.generateReply(incoming, recentHistory, memory);

    // 6. Mode & Policy Dispatch
    return this.dispatcher.dispatch(mode, reply, safety);
  }
}

export * from './types.js';
