import type { NativeEventPayload } from '../core/desktop/appleIntelligence';

declare global {
  interface Window {
    appleIntelligence?: {
      getAvailability(): Promise<{ state: string; reason?: string }>;
      analyze(request: { requestId: string; payload: unknown }): Promise<{ requestId: string }>;
      cancel(requestId: string): Promise<void>;
      subscribe(listener: (event: NativeEventPayload) => void): () => void;
    };
  }
}

export {};
