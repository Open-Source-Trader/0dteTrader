// Metadata-only operational telemetry for the Apple Intelligence feature.
// Canonical spec: docs/apple-intelligence/testing-and-observability.md
// ("Required metrics") and security-boundary.md ("Logging" — stderr/telemetry
// may record request id, trigger category, duration, byte counts, omission
// codes, terminal state, safe error code, versions; never raw snapshots,
// prompts, full model output, exact positions, order details, credentials,
// or account identifiers).
//
// No existing shared logger fits this seam: apps/api has a NestJS
// ConsoleLogger subclass (AppLogger) that isn't usable outside Nest's DI
// container, and apps/desktop's Electron main process has no logging
// abstraction at all — every existing call site here uses plain
// `console.log`/`console.error` with a `[desktop]` prefix (main.cjs). This
// module follows that existing convention (a thin console wrapper, no new
// dependency) rather than introducing a second logging ecosystem, and adds
// only what's new: a stable `[apple-intelligence]` prefix, a single
// structured-event shape, and a payload allowlist so metadata-only stays
// true by construction rather than by every call site remembering the rule.
//
// Event field names are camelCase, matching this module's existing
// convention (RequestRegistry/NativeProcessSupervisor use camelCase
// properties throughout) rather than the snake_case names used as
// shorthand in testing-and-observability.md's metric table.

/** Every field an emitted event payload is allowed to carry. Anything else
 * passed to `emitTelemetryEvent` is dropped rather than logged — this is
 * the enforcement point for "metadata-only", not just a convention. */
const ALLOWED_PAYLOAD_FIELDS = new Set([
  'requestId',
  'shimStartDurationMs',
  'handshakeResult',
  'availabilityState',
  'availabilityReason',
  'analysisQueueWaitMs',
  'analysisDurationMs',
  'analysisTriggerKind',
  'analysisTerminalState',
  'restartAttempt',
  'exitCode',
  'exitSignal',
  'protocolViolationCode',
  'errorCode',
  'shimVersion',
  'protocolVersion',
]);

function sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object') return undefined;
  const safe = {};
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_PAYLOAD_FIELDS.has(key)) continue;
    const value = payload[key];
    if (value === undefined) continue;
    // `null` is a meaningful value for fields like exitSignal ("process
    // exited without a signal") and is not sensitive — keep it. Only
    // non-null objects/arrays are rejected, since that's the shape a
    // snapshot/prompt/position fragment would take if it slipped in under
    // an allowed key name.
    if (value !== null && typeof value === 'object') continue;
    safe[key] = value;
  }
  return safe;
}

/**
 * Emits one structured, metadata-only telemetry line. `event` is a short
 * stable name (e.g. "shim_start", "analysis_terminal") — not free text.
 * Uses `console.info` (matches this codebase's existing `[desktop]`-prefixed
 * console logging in main.cjs; no separate sink exists to route to).
 */
function emitTelemetryEvent(event, payload) {
  const safePayload = sanitizePayload(payload);
  const line = { scope: 'apple-intelligence', event, ...safePayload };
  console.info(`[apple-intelligence] ${JSON.stringify(line)}`);
}

/**
 * Verbose local debug logging — OFF by default, only enabled by explicit env
 * var, and clearly announced when on (security-boundary.md "Development
 * debug capture must be explicit, local, visibly enabled... and easy to
 * purge"). This is the only path in this module that may log richer detail
 * (e.g. every state transition, not just terminal ones); even then, callers
 * remain responsible for not passing raw prompts/snapshots — this flag
 * governs verbosity of *metadata* logging, not a license to log content.
 *
 * A function (not a frozen constant) so it re-reads `process.env` on every
 * call — required for tests to exercise both on/off behavior via
 * `vi.stubEnv`, and correct in production too since env vars don't change
 * mid-process anyway.
 */
function isPackagedBuild() {
  // electron's `app.isPackaged` isn't available to a plain require()'d cjs
  // module without importing electron here; NODE_ENV production is the
  // existing convention electron-builder sets for packaged output, and this
  // module deliberately avoids taking an `electron` dependency just to read
  // one flag.
  return process.env.NODE_ENV === 'production';
}

function isVerboseLoggingEnabled() {
  return process.env.AI_VERBOSE_LOGGING === '1' && !isPackagedBuild();
}

if (isVerboseLoggingEnabled()) {
  console.info('[apple-intelligence] verbose AI logging is ON (AI_VERBOSE_LOGGING=1) — local debug only');
}

function emitVerbose(event, payload) {
  if (!isVerboseLoggingEnabled()) return;
  emitTelemetryEvent(event, payload);
}

module.exports = {
  emitTelemetryEvent,
  emitVerbose,
  isVerboseLoggingEnabled,
  ALLOWED_PAYLOAD_FIELDS,
};
