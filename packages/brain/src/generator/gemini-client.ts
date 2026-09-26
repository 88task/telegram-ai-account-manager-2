// Uses Node 20+ global fetch

export interface GeminiContentOptions {
  prompt: string;
  systemInstruction?: string;
  imageBuffer?: Buffer;
  imageMimeType?: string;
  temperature?: number;
  maxOutputTokens?: number;
  jsonMode?: boolean;
}

export class GeminiClientPool {
  private keys: string[] = [];
  private model: string = 'gemini-2.5-flash';
  private currentKeyIndex: number = 0;

  constructor(keys: string[] = [], model: string = 'gemini-2.5-flash') {
    this.keys = keys.filter(k => k && k.trim().length > 0);
    this.model = model || 'gemini-2.5-flash';
  }

  public updateConfig(keys: string[], model?: string) {
    this.keys = keys.filter(k => k && k.trim().length > 0);
    if (model) this.model = model;
  }

  public hasKeys(): boolean {
    return this.keys.length > 0;
  }

  public getModel(): string {
    return this.model;
  }

  /**
   * Generates content using Google Gemini with automatic failover across multiple API keys.
   * Supports multimodal images (JPEG/PNG/WebP/GIF).
   */
  public async generateContent(opts: GeminiContentOptions): Promise<string> {
    if (this.keys.length === 0) {
      throw new Error('No Gemini API keys configured in pool');
    }

    const maxAttempts = this.keys.length;
    let lastError: any = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const keyIndex = (this.currentKeyIndex + attempt) % this.keys.length;
      const apiKey = this.keys[keyIndex];

      try {
        const result = await this.callGeminiApi(apiKey, this.model, opts);
        this.currentKeyIndex = keyIndex;
        return result;
      } catch (err: any) {
        console.warn(`[Gemini Pool] Key ${keyIndex + 1}/${this.keys.length} failed: ${err.message}. Trying next key...`);
        lastError = err;
      }
    }

    throw lastError || new Error('All Gemini API keys in pool failed');
  }

  private async callGeminiApi(apiKey: string, model: string, opts: GeminiContentOptions): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const parts: any[] = [];

    if (opts.imageBuffer && opts.imageBuffer.length > 0) {
      parts.push({
        inlineData: {
          mimeType: opts.imageMimeType || 'image/jpeg',
          data: opts.imageBuffer.toString('base64'),
        },
      });
    }

    parts.push({ text: opts.prompt });

    const requestBody: any = {
      contents: [
        {
          role: 'user',
          parts,
        },
      ],
      generationConfig: {
        temperature: opts.temperature ?? 0.3,
        maxOutputTokens: opts.maxOutputTokens ?? 1024,
        ...(opts.jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
    };

    if (opts.systemInstruction) {
      requestBody.systemInstruction = {
        role: 'system',
        parts: [{ text: opts.systemInstruction }],
      };
    }

    const response = await (globalThis.fetch || fetch)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API HTTP ${response.status}: ${errText}`);
    }

    const data: any = await response.json();
    const candidate = data.candidates?.[0];
    if (!candidate || !candidate.content?.parts) {
      throw new Error('Gemini returned empty or blocked response');
    }

    return candidate.content.parts.map((p: any) => p.text || '').join('').trim();
  }
}
