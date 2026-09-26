import { getBedrockClient } from '../generator/client-factory.js';
import { GeminiClientPool } from '../generator/gemini-client.js';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConversationRole
} from '@aws-sdk/client-bedrock-runtime';

export type ScreenshotCategory =
  | 'download_architecture_error' // 32-bit vs 64-bit install failure
  | 'whatsapp_ban_screen'          // "This account is not allowed to use WhatsApp"
  | 'bank_account_error'          // Unsupported bank / invalid IFSC
  | 'task_submission_error'       // Failed upload, duplicate message
  | 'login_password_error'        // Invalid credentials
  | 'batch_task_verification'     // LUMO batch task screen, reward awaiting verification
  | 'whatsapp_linking'            // LUMO WhatsApp link/connection screen
  | 'ambiguous_unclear';          // Unreadable, cropped, or ambiguous

export interface ScreenshotTriageResult {
  category: ScreenshotCategory;
  providerUnavailable?: boolean;
  isAmbiguous: boolean;
  extractedErrorText?: string;
  confidence: number;
  identifiedIssue: string;
  suggestedAction: string;
  recommendedClarificationPrompt?: string;
}

function extractJsonObject(text: string): any | null {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

export class ScreenshotTriage {
  private client: BedrockRuntimeClient;
  private modelId: string;
  private geminiPool: GeminiClientPool = new GeminiClientPool();
  private providerMode: 'auto' | 'gemini' | 'bedrock' = 'auto';

  constructor() {
    this.client = getBedrockClient();
    this.modelId = process.env.BEDROCK_MODEL_ID || 'amazon.nova-pro-v1:0';
  }

  public setGeminiConfig(keys: string[], model?: string, mode?: 'auto' | 'gemini' | 'bedrock'): void {
    this.geminiPool.updateConfig(keys, model);
    if (mode) this.providerMode = mode;
  }

  /**
   * Analyzes an uploaded screenshot using Bedrock Amazon Nova Pro vision.
   * If the error is not clearly readable or does not match a known issue,
   * flags as ambiguous and generates a polite clarification question.
   */
  public async triageImage(
    imageBuffer: Buffer,
    mimeType: string = 'image/jpeg',
    userCaption?: string
  ): Promise<ScreenshotTriageResult> {
    const format = mimeType.includes('png') ? 'png' : 'jpeg';

    const prompt = `You are the lead technical support engineer triaging a user screenshot from the LUMO app or WhatsApp.
Analyze the provided image carefully.

CATEGORIES:
1. download_architecture_error: App installation fails, "App not installed", "Package appears corrupt", Android architecture mismatch (32-bit vs 64-bit device).
2. whatsapp_ban_screen: "This account is not allowed to use WhatsApp", banned or restricted prompt.
3. bank_account_error: Bank account linking failed, invalid IFSC, unsupported bank name.
4. task_submission_error: WhatsApp message task screenshot, failed upload, duplicate submission error.
5. login_password_error: Invalid password, account locked, OTP verification failed.
7. batch_task_verification: LUMO app batch task screen, task sent and awaiting verification, batch countdown timer, or reward credited/pending.
8. whatsapp_linking: LUMO WhatsApp link screen, "Preparing your WhatsApp connection", linked WhatsApp accounts list, or WhatsApp fetch/link status.
6. ambiguous_unclear: The image is blurry, cropped, shows an unrelated home screen, or the actual error message cannot be determined with certainty.

USER CAPTION: "${userCaption || 'No caption provided'}"

OUTPUT FORMAT: Strict JSON only:
{
  "category": "one of the categories above",
  "isAmbiguous": true_or_false,
  "extractedErrorText": "exact text of visible error dialog if legible",
  "confidence": 0.95,
  "identifiedIssue": "clear explanation of the problem",
  "suggestedAction": "what the support reply should tell the user",
  "recommendedClarificationPrompt": "Hinglish/English polite follow-up question if isAmbiguous is true, asking them to describe the issue"
}`;

    // If providerMode is 'gemini' and keys are configured, use Gemini directly
    if (this.providerMode === 'gemini') {
      try {
        return await this.triageWithGemini(prompt, imageBuffer, mimeType);
      } catch (gemErr: any) {
        return { providerUnavailable: true, category: 'ambiguous_unclear', isAmbiguous: true, confidence: 0, identifiedIssue: 'Gemini vision unavailable', suggestedAction: 'Human review required' };
      }
    }

    try {
      const command = new ConverseCommand({
        modelId: this.modelId,
        messages: [
          {
            role: ConversationRole.USER,
            content: [
              {
                image: {
                  format,
                  source: { bytes: imageBuffer }
                }
              },
              { text: prompt }
            ]
          }
        ],
        inferenceConfig: {
          temperature: 0.1, // low temperature for precise classification
          maxTokens: 512
        }
      });

      const response = await this.client.send(command, { abortSignal: AbortSignal.timeout(30_000) });
      const text = response.output?.message?.content?.[0]?.text || '';
      const parsed = extractJsonObject(text);

      if (parsed) {
        return {
          category: parsed.category || 'ambiguous_unclear',
          isAmbiguous: parsed.isAmbiguous ?? (parsed.category === 'ambiguous_unclear'),
          extractedErrorText: parsed.extractedErrorText,
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
          identifiedIssue: parsed.identifiedIssue || 'Screenshot parsed',
          suggestedAction: parsed.suggestedAction || 'Review issue with user',
          recommendedClarificationPrompt: parsed.recommendedClarificationPrompt ||
            'Screenshot me issue clearly nahi dikh raha hai. Please thoda detail me batayein kya problem aa rahi hai?'
        };
      }

      return {
        category: 'ambiguous_unclear',
        isAmbiguous: true,
        confidence: 0.5,
        providerUnavailable: true,
        identifiedIssue: 'Could not structure vision output',
        suggestedAction: 'Ask user for clarification',
        recommendedClarificationPrompt: 'Aapne jo photo bheji hai usme error clear nahi hai, please batayein screen par kya likha aa raha hai?'
      };
    } catch (err: any) {
      console.warn('[AI] Bedrock vision unavailable.');

      // Fallback to Gemini when Bedrock fails
      if (this.providerMode === 'auto' && this.geminiPool.hasKeys()) {
        try {
          return await this.triageWithGemini(prompt, imageBuffer, mimeType);
        } catch (geminiErr: any) {
          console.warn('[AI] Gemini vision unavailable.');
        }
      }

      return {
        category: 'ambiguous_unclear',
        isAmbiguous: true,
        confidence: 0,
        providerUnavailable: true,
        identifiedIssue: 'Vision triage unavailable',
        suggestedAction: 'Ask user for clarification',
        recommendedClarificationPrompt: 'Photo open nahi ho paayi, please batayein aapko kya dikkat aa rahi hai?'
      };
    }
  }

  private async triageWithGemini(
    prompt: string,
    imageBuffer: Buffer,
    mimeType: string
  ): Promise<ScreenshotTriageResult> {
    const text = await this.geminiPool.generateContent({
      prompt,
      imageBuffer,
      imageMimeType: mimeType,
      temperature: 0.1,
      maxOutputTokens: 1536,
      jsonMode: true,
    });

    const parsed = extractJsonObject(text);
    if (parsed) {
      return {
        category: parsed.category || 'ambiguous_unclear',
        isAmbiguous: parsed.isAmbiguous ?? (parsed.category === 'ambiguous_unclear'),
        extractedErrorText: parsed.extractedErrorText,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.85,
        identifiedIssue: parsed.identifiedIssue || 'Screenshot parsed via Gemini',
        suggestedAction: parsed.suggestedAction || 'Review issue with user',
        recommendedClarificationPrompt: parsed.recommendedClarificationPrompt ||
          'Screenshot me issue clearly nahi dikh raha hai. Please thoda detail me batayein kya problem aa rahi hai?'
      };
    }

    return {
      category: 'ambiguous_unclear',
      isAmbiguous: true,
      confidence: 0.5,
      providerUnavailable: true,
      identifiedIssue: 'Could not structure Gemini vision output',
      suggestedAction: 'Ask user for clarification',
      recommendedClarificationPrompt: 'Aapne jo photo bheji hai usme error clear nahi hai, please batayein screen par kya likha aa raha hai?'
    };
  }
}
