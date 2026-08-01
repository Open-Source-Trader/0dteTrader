// Canonical spec: docs/apple-intelligence/testing-and-observability.md
// ("Logging constraints" / "Log-safety tests prove sample sensitive
// payloads do not appear in emitted logs"). Runs full request lifecycles —
// success, malformed protocol, crash mid-stream — with a sensitive marker
// planted in the payload, capturing everything the supervisor could emit
// as diagnostics (console.* plus its own event stream's non-payload
// fields), and proves the marker never surfaces outside protocol payloads.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { NativeProcessSupervisor } = require('./supervisor.cjs');
const { RequestRegistry } = require('./requestRegistry.cjs');
const { spawn: realSpawn } = require('node:child_process');

const fakeShimPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/fakeShim.cjs',
);

// Stands in for account identifiers, exact positions, order details —
// content the logging constraints forbid in production telemetry.
const SENSITIVE_MARKER = 'SENSITIVE-ACCT-4429-POS-17-SHORT';

function makeSupervisor(behavior) {
  return new NativeProcessSupervisor({
    resolvePath: () => process.execPath,
    spawnFn: (_binary, _args, options) =>
      realSpawn(process.execPath, [fakeShimPath], {
        ...options,
        env: { ...options.env, FAKE_SHIM_BEHAVIOR: behavior },
      }),
  });
}

function sensitiveRequest(requestId) {
  return {
    protocolVersion: 1,
    requestId,
    method: 'analysis.run',
    payload: {
      snapshotSchemaVersion: 1,
      identity: {
        snapshotId: `snap-${SENSITIVE_MARKER}`,
        capturedAt: '2026-07-31T00:00:00Z',
        symbol: 'SPY',
        timeframe: '1m',
        snapshotSequence: 1,
        positionVersion: 7,
      },
      trigger: { kind: 'manual', priority: 'manual', reason: SENSITIVE_MARKER },
      market: { accountNote: SENSITIVE_MARKER },
      candles: {},
      indicators: {},
      levels: [],
      quality: { capturedAt: '2026-07-31T00:00:00Z', candlesFreshAsOf: '', isChainStale: false },
      omissions: [],
    },
  };
}

describe('log safety', () => {
  /** Everything a production log sink could see: console output plus the
   * supervisor's diagnostic (non native-event) emissions. */
  let captured;

  beforeEach(() => {
    captured = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
      vi.spyOn(console, method).mockImplementation((...args) => {
        captured.push(args.map(String).join(' '));
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runLifecycle(behavior, { alsoCrash = false } = {}) {
    const supervisor = makeSupervisor(behavior);
    supervisor.onEvent((event) => {
      // Diagnostic events (state changes, protocol violations, crash
      // notices) are what a telemetry sink would record. native-event
      // payloads go to the renderer's validation layer, not to logs.
      if (event.type !== 'native-event') captured.push(JSON.stringify(event));
    });
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });

    if (supervisor.state === 'ready') {
      supervisor.send(sensitiveRequest('req-1'));
      // Give the child a beat to respond (or crash) before shutdown.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (alsoCrash && supervisor.child) supervisor.child.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await supervisor.stop();
  }

  it('keeps sensitive payload content out of diagnostics on the success path', async () => {
    await runLifecycle('valid-handshake');
    expect(captured.join('\n')).not.toContain(SENSITIVE_MARKER);
  });

  it('keeps sensitive payload content out of diagnostics when the child emits malformed JSON', async () => {
    await runLifecycle('malformed-json');
    const all = captured.join('\n');
    expect(all).not.toContain(SENSITIVE_MARKER);
  });

  it('keeps sensitive payload content out of diagnostics across a crash', async () => {
    await runLifecycle('valid-handshake', { alsoCrash: true });
    expect(captured.join('\n')).not.toContain(SENSITIVE_MARKER);
  });

  it('diagnostic events never embed the request payload structure', async () => {
    await runLifecycle('valid-handshake');
    const all = captured.join('\n');
    expect(all).not.toContain('snapshotSchemaVersion');
    expect(all).not.toContain('"payload"');
  });
});

// Phase 3: the same guarantee, specifically for the new telemetry module —
// wired through RequestRegistry exactly as main.cjs composes it, with
// sentinels shaped like each forbidden category
// (testing-and-observability.md "Logging constraints": prompts, raw
// snapshots, full model output, account identifiers, exact positions, order
// details, credentials).
describe('log safety — telemetry (RequestRegistry + NativeProcessSupervisor)', () => {
  let captured;

  const PROMPT_SENTINEL = 'PROMPT-SENTINEL-Analyze SPY 0DTE call spread entry near VWAP reclaim';
  const SNAPSHOT_SENTINEL = 'SNAPSHOT-SENTINEL-candles-indicators-levels-blob';
  const POSITION_SENTINEL = 'POSITION-SENTINEL-3xSPY260JULCALL-qty12-avg1.42';
  const CREDENTIAL_SENTINEL = 'sk-live-CREDENTIAL-SENTINEL-4f9a8b7c6d5e';
  const ACCOUNT_SENTINEL = 'ACCOUNT-SENTINEL-8823910-webull';

  beforeEach(() => {
    captured = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
      vi.spyOn(console, method).mockImplementation((...args) => {
        captured.push(args.map(String).join(' '));
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function wireRegistry(supervisor) {
    const dispatched = [];
    const registry = new RequestRegistry({
      send: (request) => supervisor.send(request),
      dispatch: (webContentsId, payload) => dispatched.push({ webContentsId, payload }),
    });
    supervisor.onEvent((event) => {
      if (event.type === 'native-event') registry.handleNativeEvent(event.payload);
      else if (event.type === 'exit') registry.rejectAll('native_process_exited');
    });
    return { registry, dispatched };
  }

  function sentinelLadenRequest(requestId) {
    return {
      protocolVersion: 1,
      requestId,
      method: 'analysis.run',
      payload: {
        snapshotSchemaVersion: 1,
        identity: { snapshotId: `snap-${requestId}`, symbol: 'SPY', timeframe: '1m', snapshotSequence: 1, positionVersion: 1 },
        trigger: { kind: 'manual', priority: 'manual', reason: PROMPT_SENTINEL },
        market: { note: SNAPSHOT_SENTINEL },
        position: { detail: POSITION_SENTINEL },
        account: { id: ACCOUNT_SENTINEL },
        credentials: { apiKey: CREDENTIAL_SENTINEL },
        candles: {},
        indicators: {},
        levels: [],
        quality: { capturedAt: '2026-07-31T00:00:00Z', candlesFreshAsOf: '', isChainStale: false },
        omissions: [],
      },
    };
  }

  it('keeps prompt/snapshot/position/account/credential-shaped content out of telemetry on a completed request', async () => {
    const supervisor = makeSupervisor('valid-handshake');
    const { registry } = wireRegistry(supervisor);
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });

    const requestId = 'req-telemetry-1';
    // Mirrors main.cjs's analyze handler: register (which reads trigger.kind
    // for analysis_trigger_kind telemetry) before forwarding to the sidecar.
    const request = sentinelLadenRequest(requestId);
    registry.register({ requestId, originatingWebContentsId: 1, triggerKind: request.payload.trigger.kind });
    supervisor.send(request);

    await vi.waitFor(() => expect(registry.has(requestId)).toBe(false));
    await supervisor.stop();

    const all = captured.join('\n');
    expect(all).not.toContain(PROMPT_SENTINEL);
    expect(all).not.toContain(SNAPSHOT_SENTINEL);
    expect(all).not.toContain(POSITION_SENTINEL);
    expect(all).not.toContain(ACCOUNT_SENTINEL);
    expect(all).not.toContain(CREDENTIAL_SENTINEL);
  });

  it('keeps sentinel content out of telemetry when the sidecar crashes mid-request (rejectAll path)', async () => {
    const supervisor = makeSupervisor('crash-mid-stream');
    const { registry } = wireRegistry(supervisor);
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });

    const requestId = 'req-telemetry-2';
    const request = sentinelLadenRequest(requestId);
    registry.register({ requestId, originatingWebContentsId: 1, triggerKind: request.payload.trigger.kind });
    supervisor.send(request);

    await vi.waitFor(() => expect(registry.has(requestId)).toBe(false));
    await supervisor.stop();

    const all = captured.join('\n');
    expect(all).not.toContain(PROMPT_SENTINEL);
    expect(all).not.toContain(SNAPSHOT_SENTINEL);
    expect(all).not.toContain(POSITION_SENTINEL);
    expect(all).not.toContain(ACCOUNT_SENTINEL);
    expect(all).not.toContain(CREDENTIAL_SENTINEL);
  });

  it('keeps sentinel content out of telemetry on deadline timeout', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const registry = new RequestRegistry({ send: () => {}, dispatch: () => {}, deadlineMs: 50 });
    const requestId = 'req-telemetry-3';
    const request = sentinelLadenRequest(requestId);
    registry.register({ requestId, originatingWebContentsId: 1, triggerKind: request.payload.trigger.kind });

    await vi.advanceTimersByTimeAsync(60);
    vi.useRealTimers();

    const all = captured.join('\n');
    expect(all).not.toContain(PROMPT_SENTINEL);
    expect(all).not.toContain(SNAPSHOT_SENTINEL);
    expect(all).not.toContain(POSITION_SENTINEL);
    expect(all).not.toContain(ACCOUNT_SENTINEL);
    expect(all).not.toContain(CREDENTIAL_SENTINEL);
  });
});
