// Canonical spec: docs/apple-intelligence/testing-and-observability.md
// ("Required metrics" — shim_start_duration_ms, handshake_result,
// availability_state/reason, shim_exit_code/signal, restart_attempt).
// Exercises real child-process framing (same fake-shim pattern as
// supervisor.test.mjs) and spies on console.info to assert the emitted
// telemetry lines carry the expected metadata.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { NativeProcessSupervisor } = require('./supervisor.cjs');
const { spawn: realSpawn } = require('node:child_process');

const fakeShimPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fakeShim.cjs');

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

/** Parses every `[apple-intelligence] {...}` line captured by the spy into
 * its JSON payload, in emission order. */
function capturedTelemetry(infoSpy) {
  return infoSpy.mock.calls
    .map((call) => call[0])
    .filter((line) => typeof line === 'string' && line.startsWith('[apple-intelligence] '))
    .map((line) => JSON.parse(line.slice('[apple-intelligence] '.length)));
}

describe('supervisor telemetry', () => {
  let infoSpy;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits handshake_result=ok with a non-negative shim_start_duration_ms on success', async () => {
    const supervisor = makeSupervisor('valid-handshake');
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });

    const events = capturedTelemetry(infoSpy);
    const handshake = events.find((e) => e.event === 'handshake');
    expect(handshake).toMatchObject({ handshakeResult: 'ok' });
    expect(handshake.shimStartDurationMs).toBeGreaterThanOrEqual(0);

    await supervisor.stop();
  });

  it('emits availability_state=incompatible on a protocol version mismatch', async () => {
    const supervisor = makeSupervisor('incompatible-version');
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });

    const events = capturedTelemetry(infoSpy);
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'availability', availabilityState: 'incompatible' }),
    );
    expect(events).toContainEqual(expect.objectContaining({ event: 'handshake', handshakeResult: 'incompatible' }));
  });

  it('emits shim_exit with exit code/signal, and a restart_attempt on crash recovery', async () => {
    const supervisor = makeSupervisor('crash-mid-stream');
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });
    expect(supervisor.state).toBe('ready');

    const exits = [];
    supervisor.onEvent((event) => {
      if (event.type === 'exit') exits.push(event);
    });

    supervisor.send({ protocolVersion: 1, requestId: 'req-1', method: 'analysis.run', payload: {} });

    await vi.waitFor(() => {
      expect(exits.length).toBeGreaterThan(0);
    });
    // First unexpected exit restarts immediately per the documented
    // crash-loop policy; the fresh child completes its handshake.
    await vi.waitFor(() => {
      expect(supervisor.state).toBe('ready');
    });

    const events = capturedTelemetry(infoSpy);
    const exitEvent = events.find((e) => e.event === 'shim_exit');
    expect(exitEvent).toBeDefined();
    expect('exitCode' in exitEvent).toBe(true);
    expect('exitSignal' in exitEvent).toBe(true);

    const restartEvent = events.find((e) => e.event === 'restart');
    expect(restartEvent).toMatchObject({ restartAttempt: 1 });

    await supervisor.stop();
  });

  it('emits protocol_violation with protocol_malformed_json on bad JSON from the child', async () => {
    const supervisor = makeSupervisor('malformed-json');
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });

    await vi.waitFor(() => {
      const events = capturedTelemetry(infoSpy);
      expect(events).toContainEqual(
        expect.objectContaining({ event: 'protocol_violation', protocolViolationCode: 'protocol_malformed_json' }),
      );
    });

    await supervisor.stop();
  });

  it('emits protocol_violation with payload_too_large on an oversized line', async () => {
    const supervisor = makeSupervisor('oversized-line');
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });

    await vi.waitFor(() => {
      const events = capturedTelemetry(infoSpy);
      expect(events).toContainEqual(
        expect.objectContaining({ event: 'protocol_violation', protocolViolationCode: 'payload_too_large' }),
      );
    });

    await supervisor.stop();
  });
});
