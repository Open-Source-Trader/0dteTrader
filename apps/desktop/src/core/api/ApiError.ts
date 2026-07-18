import type { ApiError as ApiErrorEnvelope } from '@0dtetrader/shared-types';

/** Typed API failure, mirroring APIError.swift including the user messages. */
export type ApiFailure =
  | { kind: 'server'; code: string; message: string; status: number }
  | { kind: 'httpStatus'; status: number }
  | { kind: 'network'; underlying: string }
  | { kind: 'decoding' }
  | { kind: 'invalidRequest' }
  | { kind: 'unauthorized' };

export class ApiError extends Error {
  readonly failure: ApiFailure;

  constructor(failure: ApiFailure) {
    super(userMessage(failure));
    this.name = 'ApiError';
    this.failure = failure;
  }

  get userMessage(): string {
    return userMessage(this.failure);
  }

  static isUnauthorized(error: unknown): boolean {
    return error instanceof ApiError && error.failure.kind === 'unauthorized';
  }
}

function userMessage(failure: ApiFailure): string {
  switch (failure.kind) {
    case 'server':
      return failure.message;
    case 'httpStatus':
      return `Request failed (HTTP ${failure.status}).`;
    case 'network':
      return `Network error: ${failure.underlying}`;
    case 'decoding':
      return 'Unexpected response from server.';
    case 'invalidRequest':
      return 'Invalid request.';
    case 'unauthorized':
      return 'Session expired. Please log in again.';
  }
}

/** Error message shown to the user for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.userMessage;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function parseErrorEnvelope(body: unknown): { code: string; message: string } | null {
  const envelope = body as Partial<ApiErrorEnvelope> | null;
  if (
    envelope &&
    typeof envelope === 'object' &&
    envelope.error &&
    typeof envelope.error.code === 'string' &&
    typeof envelope.error.message === 'string'
  ) {
    return envelope.error;
  }
  return null;
}
