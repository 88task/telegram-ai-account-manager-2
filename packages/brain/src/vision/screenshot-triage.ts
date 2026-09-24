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
  | 'ambiguous_unclear';          // Unreadable, cropped, or ambiguous

export interface ScreenshotTriageResult {
  category: ScreenshotCategory;
  isAmbiguous: boolean;
  extractedErrorText?: string;
  confidence: number;
  identifiedIssue: string;
  suggestedAction: string;
  recommendedClarificationPrompt?: string;
}

export class ScreenshotTriage {
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
    this.modelId = process.env.BEDROCK_MODEL_ID || 'amazon.nova-pro-v1:0';
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

      const response = await this.client.send(command);
      const text = response.output?.message?.content?.[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
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
        identifiedIssue: 'Could not structure vision output',
        suggestedAction: 'Ask user for clarification',
        recommendedClarificationPrompt: 'Aapne jo photo bheji hai usme error clear nahi hai, please batayein screen par kya likha aa raha hai?'
      };
    } catch (err: any) {
      console.error('Bedrock vision triage failed:', err);
      return {
        category: 'ambiguous_unclear',
        isAmbiguous: true,
        confidence: 0.3,
        identifiedIssue: `Vision triage unavailable: ${err.message}`,
        suggestedAction: 'Ask user for clarification',
        recommendedClarificationPrompt: 'Photo open nahi ho paayi, please batayein aapko kya dikkat aa rahi hai?'
      };
    }
  }
}
