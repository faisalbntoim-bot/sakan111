/**
 * AITourProvider — interface only.
 *
 * ⚠️  No AI tour narration / auto-scripting service is wired in. The
 *     default provider returns `not_available`. Do NOT stub a fake
 *     "AI-generated" script — that would mislead users into thinking
 *     the AI has seen their property.
 */

export interface AITourRequest {
  ownerUserId: string;
  propertyId: string;
  mediaAssetIds: string[];
  locale: 'ar' | 'en';
}

export interface AITourResponse {
  state: 'not_available' | 'queued' | 'ready' | 'failed';
  script?: string;                 // ONLY set when a real provider produced it
  audioAssetId?: string;
  message?: string;
}

export interface AITourProvider {
  readonly name: string;
  generate(req: AITourRequest): Promise<AITourResponse>;
}

export class UnavailableAITourProvider implements AITourProvider {
  readonly name = 'unavailable';
  async generate(_req: AITourRequest): Promise<AITourResponse> {
    return {
      state: 'not_available',
      message: 'AI Tour generation service is not configured on this deployment.',
    };
  }
}

let provider: AITourProvider = new UnavailableAITourProvider();
export function getAITourProvider(): AITourProvider { return provider; }
export function setAITourProvider(next: AITourProvider): void { provider = next; }
