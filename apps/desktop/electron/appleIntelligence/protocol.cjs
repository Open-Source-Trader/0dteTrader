// Apple Intelligence native wire protocol (NDJSON over child stdin/stdout).
// Canonical spec: docs/apple-intelligence/protocol.md — this module is the
// runtime-validation implementation of that spec, not a second source of truth.
const { z } = require('zod');

const PROTOCOL_VERSION = 1;

const NATIVE_METHODS = [
  'runtime.hello',
  'runtime.availability',
  'runtime.prewarm',
  'analysis.run',
  'analysis.cancel',
  'runtime.shutdown',
];

const NATIVE_EVENTS = ['ready', 'accepted', 'progress', 'partial', 'completed', 'cancelled', 'failed'];

const ERROR_CODES = [
  'runtime_unavailable',
  'runtime_incompatible',
  'native_process_exited',
  'handshake_timeout',
  'request_timeout',
  'request_cancelled',
  'payload_invalid',
  'payload_too_large',
  'protocol_malformed_json',
  'protocol_unknown_method',
  'protocol_unknown_event',
  'protocol_sequence_violation',
  'protocol_duplicate_terminal',
  'context_budget_exceeded',
  'structured_output_invalid',
  'model_guardrail_rejection',
  'model_runtime_failure',
];

// Reject NaN/Infinity — protocol.md requires safe number representations.
const finiteNumber = z.number().finite();

const nativeErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string().max(2000),
});

const nativeRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1).max(200),
  method: z.enum(NATIVE_METHODS),
  deadlineAt: z.string().datetime({ offset: true }).optional(),
  payload: z.unknown(),
});

const nativeEventSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1).max(200),
  event: z.enum(NATIVE_EVENTS),
  sequence: finiteNumber.int().nonnegative().optional(),
  payload: z.unknown().optional(),
  error: nativeErrorSchema.optional(),
});

const runtimeReadyPayloadSchema = z.object({
  shimVersion: z.string().min(1),
  supportedProtocolVersions: z.array(finiteNumber.int()).min(1),
  snapshotSchemaVersions: z.array(finiteNumber.int()).min(1),
  resultSchemaVersions: z.array(finiteNumber.int()).min(1),
  capabilities: z.array(
    z.enum(['availability', 'prewarm', 'streaming', 'structured-generation', 'cancellation']),
  ),
});

/**
 * Parses one NDJSON line into a validated NativeEvent. Never throws — callers
 * treat a null return as a protocol violation (malformed JSON, oversized
 * line, or schema mismatch), never as a crash.
 */
function parseNativeEventLine(line, maxBytes) {
  if (typeof line !== 'string' || line.length === 0) return null;
  if (Buffer.byteLength(line, 'utf8') > maxBytes) return null;
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const result = nativeEventSchema.safeParse(raw);
  return result.success ? result.data : null;
}

module.exports = {
  PROTOCOL_VERSION,
  NATIVE_METHODS,
  NATIVE_EVENTS,
  ERROR_CODES,
  nativeErrorSchema,
  nativeRequestSchema,
  nativeEventSchema,
  runtimeReadyPayloadSchema,
  parseNativeEventLine,
};
