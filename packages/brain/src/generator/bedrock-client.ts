import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConversationRole,
  ContentBlock
} from '@aws-sdk/client-bedrock-runtime';
import { GeneratedReply, TelegramIncomingMessage } from '../types.js';
import { MemoryContext } from '../memory/context-builder.js';

export class BedrockGenerator {
  private client: BedrockRuntimeClient;
  private modelId: string;

  constructor() {
    this.client = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: process.env.AWS_ACCESS_KEY_ID ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
      } : undefined
    });
    // Amazon Nova Pro handles multimodal vision and reasoning
    this.modelId = process.env.BEDROCK_MODEL_ID || 'amazon.nova-pro-v1:0';
  }

  public async generateReply(
    message: TelegramIncomingMessage,
    conversationHistory: Array<{ role: 'user' | 'assistant'; text: string }>,
    memory: MemoryContext
  ): Promise<GeneratedReply> {
    const systemPrompt = `You are the personal AI executive assistant managing the private Telegram account of the account owner.
Your task is to draft an exact, authentic response that the owner would send.

COMMUNICATION STYLE GUIDE:
${memory.ownerStyleGuide}

BUSINESS KNOWLEDGE & POLICIES:
${memory.businessRules.map(r => '- ' + r).join('\n')}

APPROVED HISTORICAL EXAMPLES:
${memory.approvedExamples.map(ex => `User: "${ex.userMessage}"\nReply: "${ex.approvedReply}"`).join('\n\n')}

CRITICAL INSTRUCTIONS:
1. Reply directly as the account owner. Never say "As an AI" or "I am an assistant".
2. If an image is provided (screenshot, receipt, document), inspect its details carefully before responding.
3. Keep the reply natural, concise, and helpful.
4. Output your response formatted as a strict JSON object:
{
  "reply": "the exact reply string",
  "confidence": 0.95,
  "reasoning": "brief explanation of chosen response"
}`;

    // Assemble Bedrock Converse messages
    const messages = conversationHistory.map(m => ({
      role: m.role === 'assistant' ? ConversationRole.ASSISTANT : ConversationRole.USER,
      content: [{ text: m.text }] as ContentBlock[]
    }));

    // Current message content (multimodal support for images)
    const currentContent: ContentBlock[] = [];
    if (message.text) {
      currentContent.push({ text: message.text });
    }

    if (message.mediaBuffer && message.mediaMimeType?.startsWith('image/')) {
      const format = message.mediaMimeType.includes('png') ? 'png' : 'jpeg';
      currentContent.push({
        image: {
          format,
          source: { bytes: message.mediaBuffer }
        }
      });
    }

    if (currentContent.length === 0) {
      currentContent.push({ text: '[User sent media/file without text]' });
    }

    messages.push({
      role: ConversationRole.USER,
      content: currentContent
    });

    try {
      const command = new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: systemPrompt }],
        messages,
        inferenceConfig: {
          temperature: parseFloat(process.env.BEDROCK_TEMPERATURE || '0.3'),
          maxTokens: parseInt(process.env.BEDROCK_MAX_TOKENS || '512', 10)
        }
      });

      const response = await this.client.send(command);
      const outputText = response.output?.message?.content?.[0]?.text || '';

      // Parse JSON output from Bedrock
      const jsonMatch = outputText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          text: parsed.reply || outputText,
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.85,
          reasoning: parsed.reasoning || 'Generated via Amazon Nova Pro'
        };
      }

      return {
        text: outputText.trim(),
        confidence: 0.8,
        reasoning: 'Direct model output without JSON envelope'
      };
    } catch (err: any) {
      console.error('Error generating reply from Bedrock:', err);
      throw new Error(`Bedrock Converse API failed: ${err.message}`);
    }
  }
}
