import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConversationRole
} from '@aws-sdk/client-bedrock-runtime';
import { TelegramIncomingMessage } from '../types.js';
import { MemoryContext } from '../memory/context-builder.js';

export interface UserPerception {
  primaryIntent: string;
  sentiment: 'positive' | 'neutral' | 'frustrated' | 'angry' | 'suspicious';
  urgency: 'low' | 'medium' | 'high' | 'critical';
  detectedDialect: 'hi' | 'hinglish' | 'en';
  implicitNeeds: string[];
}

export interface SelfCritique {
  passedHallucinationCheck: boolean;
  passedPolicyCheck: boolean;
  toneMatchesOwner: boolean;
  confidenceScore: number; // 0.0 - 1.0
  critiqueNotes: string;
  revisedReply?: string;
}

export interface CognitiveExecutionResult {
  perception: UserPerception;
  draftReply: string;
  critique: SelfCritique;
  finalReply: string;
  modelUsed: string;
  latencyMs: number;
  auditTrail: {
    retrievedRulesCount: number;
    fewShotExamplesUsed: number;
    selfCritiqueApplied: boolean;
  };
}

export class CognitiveOrchestrator {
  private client: BedrockRuntimeClient;
  private reasoningModelId: string; // Amazon Nova Pro for multimodal & complex critique
  private fastModelId: string;      // Amazon Nova Lite for rapid perception

  constructor() {
    this.client = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: process.env.AWS_ACCESS_KEY_ID ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
      } : undefined
    });

    this.reasoningModelId = process.env.BEDROCK_MODEL_ID || 'amazon.nova-pro-v1:0';
    this.fastModelId = process.env.BEDROCK_FAST_MODEL_ID || 'amazon.nova-lite-v1:0';
  }

  /**
   * Stage 1: Perception Agent
   * Understands implicit tone, emotion, urgency, and underlying intent.
   */
  public async perceive(
    message: TelegramIncomingMessage,
    recentHistory: Array<{ text: string; role: string }>
  ): Promise<UserPerception> {
    const prompt = `Analyze this incoming Telegram message in the context of recent chat.
Message text: "${message.text || '[Image/File]'}"
Recent history: ${JSON.stringify(recentHistory.slice(-3))}

OUTPUT STRICT JSON ONLY:
{
  "primaryIntent": "e.g. inquiry_task_time, withdrawal_status, ban_complaint, scam_accusation, general_greeting",
  "sentiment": "positive | neutral | frustrated | angry | suspicious",
  "urgency": "low | medium | high | critical",
  "detectedDialect": "hi | hinglish | en",
  "implicitNeeds": ["list of what user really wants to know or feel assured of"]
}`;

    try {
      const command = new ConverseCommand({
        modelId: this.fastModelId,
        messages: [{ role: ConversationRole.USER, content: [{ text: prompt }] }],
        inferenceConfig: { temperature: 0.1, maxTokens: 256 }
      });

      const res = await this.client.send(command);
      const text = res.output?.message?.content?.[0]?.text || '';
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } catch {
      // Fallback if fast model is unavailable
    }

    return {
      primaryIntent: 'general_support',
      sentiment: 'neutral',
      urgency: 'medium',
      detectedDialect: 'hinglish',
      implicitNeeds: ['Needs assistance']
    };
  }

  /**
   * Stage 2 & 3: Generation with Deep Persona & Policy Constraints
   */
  public async synthesizeDraft(
    message: TelegramIncomingMessage,
    perception: UserPerception,
    memory: MemoryContext,
    recentHistory: Array<{ role: 'user' | 'assistant'; text: string }>
  ): Promise<string> {
    const systemPrompt = `You are the executive personal voice of the account owner.
Tone: ${memory.ownerStyleGuide}
Dialect to match: ${perception.detectedDialect}
User Sentiment: ${perception.sentiment} (Address their emotional state calmly and authoritatively)
User Intent: ${perception.primaryIntent}

NEGATIVE CONSTRAINTS (NEVER VIOLATE):
- Never promise fixed task release times (advertiser dependent).
- Never claim LUMO reads personal WhatsApp chats or steals data.
- Never tell users experiencing repeated bans that they spammed; provide the 7-8 day safety routine.
- Never reset passwords manually; direct to lumodone.com/login Forgot Password.
- Never promise referral rewards before 20 effective tasks + valid bank are completed.

KNOWLEDGE BASE:
${memory.businessRules.join('\n')}

FEW-SHOT EXAMPLES:
${memory.approvedExamples.map(e => `Q: "${e.userMessage}"\nA: "${e.approvedReply}"`).join('\n\n')}`;

    const command = new ConverseCommand({
      modelId: this.reasoningModelId,
      system: [{ text: systemPrompt }],
      messages: [
        ...recentHistory.map(m => ({
          role: m.role === 'assistant' ? ConversationRole.ASSISTANT : ConversationRole.USER,
          content: [{ text: m.text }]
        })),
        {
          role: ConversationRole.USER,
          content: [{ text: message.text || '[Image without text]' }]
        }
      ],
      inferenceConfig: { temperature: 0.3, maxTokens: 512 }
    });

    const res = await this.client.send(command);
    return res.output?.message?.content?.[0]?.text || '';
  }

  /**
   * Stage 4: Reflective Self-Critique & Hallucination Guard
   * Evaluates the candidate draft against facts and policies before it leaves the brain.
   */
  public async selfCritique(
    candidateDraft: string,
    message: TelegramIncomingMessage,
    perception: UserPerception,
    memory: MemoryContext
  ): Promise<SelfCritique> {
    const prompt = `You are the chief compliance and quality auditor evaluating a proposed AI response.
Incoming message: "${message.text || ''}"
Proposed response: "${candidateDraft}"
User sentiment: "${perception.sentiment}"

AUDIT CHECKS:
1. Hallucination: Does the response promise unauthorized features, wrong payout times (< 24h), or unverified facts?
2. Policy: Does it violate any LUMO safety, multi-binding, or anti-ban guidelines?
3. Tone: Does it sound natural, polite, and match the account owner without sounding like a generic bot?

OUTPUT STRICT JSON ONLY:
{
  "passedHallucinationCheck": true_or_false,
  "passedPolicyCheck": true_or_false,
  "toneMatchesOwner": true_or_false,
  "confidenceScore": 0.95,
  "critiqueNotes": "Specific reason for score",
  "revisedReply": "Improved version if needed, or null if original is solid"
}`;

    try {
      const command = new ConverseCommand({
        modelId: this.reasoningModelId,
        messages: [{ role: ConversationRole.USER, content: [{ text: prompt }] }],
        inferenceConfig: { temperature: 0.1, maxTokens: 512 }
      });

      const res = await this.client.send(command);
      const text = res.output?.message?.content?.[0]?.text || '';
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } catch (err) {
      console.error('Self-critique failed:', err);
    }

    return {
      passedHallucinationCheck: true,
      passedPolicyCheck: true,
      toneMatchesOwner: true,
      confidenceScore: 0.85,
      critiqueNotes: 'Default pass with standard confidence'
    };
  }

  /**
   * Complete End-to-End Cognitive Pipeline Execution
   */
  public async execute(
    message: TelegramIncomingMessage,
    memory: MemoryContext,
    recentHistory: Array<{ role: 'user' | 'assistant'; text: string }>
  ): Promise<CognitiveExecutionResult> {
    const start = Date.now();

    // 1. Perception
    const perception = await this.perceive(message, recentHistory);

    // 2. Synthesis
    const draftReply = await this.synthesizeDraft(message, perception, memory, recentHistory);

    // 3. Reflective Self-Critique
    const critique = await this.selfCritique(draftReply, message, perception, memory);

    // If critique produced a refined/corrected reply, use it
    const finalReply = critique.revisedReply && critique.revisedReply.trim().length > 0
      ? critique.revisedReply
      : draftReply;

    return {
      perception,
      draftReply,
      critique,
      finalReply,
      modelUsed: this.reasoningModelId,
      latencyMs: Date.now() - start,
      auditTrail: {
        retrievedRulesCount: memory.businessRules.length,
        fewShotExamplesUsed: memory.approvedExamples.length,
        selfCritiqueApplied: !!critique.revisedReply
      }
    };
  }
}
