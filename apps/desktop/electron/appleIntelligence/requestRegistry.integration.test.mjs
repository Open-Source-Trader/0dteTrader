// Integration coverage for RequestRegistry wired to a real
// NativeProcessSupervisor child process (the fake shim), mirroring how
// main.cjs actually composes them. Per testing-and-observability.md
// ("Main-process integration: fake shim executable; request routing;
// deadlines; owner window destruction; stale response") and "Do not mock
// only AppleIntelligenceClient; test actual child-process framing and
// lifecycle behavior" — this exercises the real supervisor rather than a
// stand-in, the same way supervisor.test.mjs does.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { NativeProcessSupervisor } = require('./supervisor.cjs');
const { RequestRegistry } = require('./requestRegistry.cjs');

const fakeShimPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/fakeShim.cjs',
);
const { spawn: realSpawn } = require('node:child_process');

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

/** Wires a registry to a supervisor exactly as main.cjs does: native events
 * route through the registry, exits reject everything pending. */
function wireRegistry(supervisor, { deadlineMs } = {}) {
  const dispatched = [];
  const registry = new RequestRegistry({
    send: (request) => supervisor.send(request),
    dispatch: (webContentsId, payload) => dispatched.push({ webContentsId, payload }),
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
  });
  supervisor.onEvent((event) => {
    if (event.type === 'native-event') {
      registry.handleNativeEvent(event.payload);
    } else if (event.type === 'exit') {
      registry.rejectAll('native_process_exited');
    }
  });
  return { registry, dispatched };
}

describe('RequestRegistry + NativeProcessSupervisor — sidecar crash during an active request', () => {
  it('rejects the pending request and cleans up the registry when the sidecar exits mid-stream', async () => {
    const supervisor = makeSupervisor('crash-mid-stream');
    const { registry, dispatched } = wireRegistry(supervisor);
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });

    registry.register({ requestId: 'req-1', originatingWebContentsId: 1 });
    supervisor.send({ protocolVersion: 1, requestId: 'req-1', method: 'analysis.run', payload: {} });

    await vi.waitFor(() => {
      expect(dispatched.some((d) => d.payload.event === 'failed')).toBe(true);
    });

    const failure = dispatched.find((d) => d.payload.event === 'failed');
    expect(failure.payload.error.code).toBe('native_process_exited');
    expect(registry.has('req-1')).toBe(false);

    await supervisor.stop();
  });
});

describe('RequestRegistry + NativeProcessSupervisor — normal completion end to end', () => {
  it('delivers exactly one completed event and clears the registry entry', async () => {
    const supervisor = makeSupervisor('valid-handshake');
    const { registry, dispatched } = wireRegistry(supervisor);
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });

    registry.register({ requestId: 'req-1', originatingWebContentsId: 42 });
    supervisor.send({ protocolVersion: 1, requestId: 'req-1', method: 'analysis.run', payload: {} });

    await vi.waitFor(() => {
      expect(dispatched.some((d) => d.payload.event === 'completed')).toBe(true);
    });

    const terminalEvents = dispatched.filter((d) =>
      ['completed', 'cancelled', 'failed'].includes(d.payload.event),
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0].webContentsId).toBe(42);
    expect(registry.has('req-1')).toBe(false);

    await supervisor.stop();
  });
});

describe('RequestRegistry + NativeProcessSupervisor — deadline shorter than a delayed response', () => {
  it('times out before the delayed native completion arrives, and ignores the late completion', async () => {
    const supervisor = makeSupervisor('delayed-response'); // fake shim replies after 300ms
    const { registry, dispatched } = wireRegistry(supervisor, { deadlineMs: 50 });
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });

    registry.register({ requestId: 'req-1', originatingWebContentsId: 1 });
    supervisor.send({ protocolVersion: 1, requestId: 'req-1', method: 'analysis.run', payload: {} });

    await vi.waitFor(() => {
      expect(dispatched.some((d) => d.payload.error?.code === 'request_timeout')).toBe(true);
    });

    // Wait past the fake shim's 300ms delayed completion (which this fake
    // behavior sends regardless of the analysis.cancel main issued) to
    // prove the late arrival never produces a second terminal dispatch.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const forRequest = dispatched.filter((d) => d.payload.requestId === 'req-1');
    const terminalForRequest = forRequest.filter((d) =>
      ['completed', 'cancelled', 'failed'].includes(d.payload.event),
    );
    expect(terminalForRequest).toHaveLength(1);
    expect(terminalForRequest[0].payload.event).toBe('failed');
    expect(registry.has('req-1')).toBe(false);

    await supervisor.stop();
  }, 8000);
});
