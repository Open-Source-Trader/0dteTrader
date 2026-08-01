// Renderer-side adapter for the preload's window.appleIntelligence bridge.
// Canonical spec: docs/apple-intelligence/protocol.md (renderer-to-main IPC
// is deliberately not the native protocol). This module is the only place
// in the renderer that touches window.appleIntelligence.

export interface NativeEventPayload {
  protocolVersion: 1;
  requestId: string;
  event: 'ready' | 'accepted' | 'progress' | 'partial' | 'completed' | 'cancelled' | 'failed';
  sequence?: number;
  payload?: unknown;
  error?: { code: string; message: string };
}

export interface AppleIntelligenceBridge {
  getAvailability(): Promise<{ state: string; reason?: string }>;
  analyze(request: { requestId: string; payload: unknown }): Promise<{ requestId: string }>;
  cancel(requestId: string): Promise<void>;
  subscribe(listener: (event: NativeEventPayload) => void): () => void;
}

export function getAppleIntelligenceBridge(): AppleIntelligenceBridge | null {
  if (typeof window === 'undefined') return null;
  return window.appleIntelligence ?? null;
}
