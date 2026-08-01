// Canonical spec: docs/apple-intelligence/testing-and-observability.md
// ("Required metrics", "Logging constraints") and security-boundary.md
// ("Logging"). Unit tests for the telemetry module itself: the payload
// allowlist actually drops disallowed/non-primitive fields, verbose logging
// is off by default and only turns on with the explicit env var, and the
// startup banner appears when it does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const telemetryPath = fileURLToPath(new URL('./telemetry.cjs', import.meta.url));

/** Node's require cache persists across vi.resetModules() (that API only
 * resets vitest's own ESM module graph) — since telemetry.cjs runs
 * env-dependent code at module-load time, tests that need a fresh
 * evaluation must evict it from require.cache explicitly. */
function freshRequireTelemetry() {
  delete require.cache[telemetryPath];
  return require('./telemetry.cjs');
}

describe('telemetry — payload allowlist', () => {
  let infoSpy;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('drops fields not on the allowlist', () => {
    const { emitTelemetryEvent } = require('./telemetry.cjs');
    emitTelemetryEvent('analysis_terminal', {
      analysisDurationMs: 42,
      // Not an allowed field — must never reach the log line.
      snapshotAccountId: 'acct-4429',
    });

    const line = infoSpy.mock.calls[0][0];
    expect(line).toContain('analysisDurationMs');
    expect(line).not.toContain('snapshotAccountId');
    expect(line).not.toContain('acct-4429');
  });

  it('drops nested-object values even under an allowed key name', () => {
    const { emitTelemetryEvent } = require('./telemetry.cjs');
    emitTelemetryEvent('analysis_terminal', {
      // requestId is allowed, but a nested object under it is not a
      // metadata primitive — must be dropped rather than serialized.
      requestId: { nested: 'SENSITIVE-SNAPSHOT-CONTENT' },
    });

    const line = infoSpy.mock.calls[0][0];
    expect(line).not.toContain('SENSITIVE-SNAPSHOT-CONTENT');
  });

  it('keeps allowed primitive fields', () => {
    const { emitTelemetryEvent } = require('./telemetry.cjs');
    emitTelemetryEvent('shim_exit', { exitCode: 1, exitSignal: 'SIGKILL' });

    const line = infoSpy.mock.calls[0][0];
    expect(line).toContain('"exitCode":1');
    expect(line).toContain('"exitSignal":"SIGKILL"');
  });

  it('prefixes every emitted line with the apple-intelligence scope', () => {
    const { emitTelemetryEvent } = require('./telemetry.cjs');
    emitTelemetryEvent('handshake', { handshakeResult: 'ok' });

    expect(infoSpy.mock.calls[0][0]).toMatch(/^\[apple-intelligence\] /);
  });
});

describe('telemetry — verbose logging gate', () => {
  let infoSpy;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is disabled by default (no env var set)', () => {
    vi.stubEnv('AI_VERBOSE_LOGGING', '');
    vi.stubEnv('NODE_ENV', '');
    const { isVerboseLoggingEnabled, emitVerbose } = freshRequireTelemetry();

    expect(isVerboseLoggingEnabled()).toBe(false);
    infoSpy.mockClear();
    emitVerbose('state', { availabilityState: 'starting' });
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('turns on only with the explicit env var and logs a startup banner', () => {
    vi.stubEnv('AI_VERBOSE_LOGGING', '1');
    vi.stubEnv('NODE_ENV', '');
    freshRequireTelemetry();

    const banner = infoSpy.mock.calls.map((c) => c[0]).find((line) => line.includes('verbose AI logging is ON'));
    expect(banner).toBeDefined();
  });

  it('stays disabled in a packaged/production build even if the env var is set', () => {
    vi.stubEnv('AI_VERBOSE_LOGGING', '1');
    vi.stubEnv('NODE_ENV', 'production');
    const { isVerboseLoggingEnabled } = freshRequireTelemetry();

    expect(isVerboseLoggingEnabled()).toBe(false);
  });

  it('emitVerbose forwards through the same allowlist as emitTelemetryEvent when enabled', () => {
    vi.stubEnv('AI_VERBOSE_LOGGING', '1');
    vi.stubEnv('NODE_ENV', '');
    const { emitVerbose } = freshRequireTelemetry();
    infoSpy.mockClear();

    emitVerbose('state', { availabilityState: 'ready', rawSnapshot: 'SHOULD-NOT-APPEAR' });

    const line = infoSpy.mock.calls.find((c) => c[0].includes('"event":"state"'))?.[0];
    expect(line).toBeDefined();
    expect(line).not.toContain('SHOULD-NOT-APPEAR');
  });
});
