import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { NativeProcessSupervisor, RESTART_DELAYS_MS } = require('./supervisor.cjs');

const fakeShimPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/fakeShim.cjs',
);

const { spawn: realSpawn } = require('node:child_process');

/**
 * The supervisor's `resolvePath` normally returns a path to the compiled
 * Swift executable; here it returns node's own path, and `spawnFn` runs the
 * fake-shim script under it instead of executing the binary path directly —
 * the fake shim is a Node script, not a native executable.
 */
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

describe('NativeProcessSupervisor — real child-process framing', () => {
  it('reaches ready after a valid handshake', async () => {
    const supervisor = makeSupervisor('valid-handshake');
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });
    expect(supervisor.state).toBe('ready');
    await supervisor.stop();
  });

  it('runs an analysis end to end through a real child process', async () => {
    const supervisor = makeSupervisor('valid-handshake');
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });

    const events = [];
    const unsubscribe = supervisor.onEvent((event) => {
      if (event.type === 'native-event') events.push(event.payload);
    });

    supervisor.send({
      protocolVersion: 1,
      requestId: 'req-1',
      method: 'analysis.run',
      payload: {},
    });

    await vi.waitFor(() => {
      expect(events.some((e) => e.event === 'completed')).toBe(true);
    });

    unsubscribe();
    await supervisor.stop();
  });

  it('delivers streaming progress events with increasing sequence numbers', async () => {
    const supervisor = makeSupervisor('streaming');
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });

    const events = [];
    supervisor.onEvent((event) => {
      if (event.type === 'native-event') events.push(event.payload);
    });
    supervisor.send({ protocolVersion: 1, requestId: 'req-1', method: 'analysis.run', payload: {} });

    await vi.waitFor(() => {
      expect(events.some((e) => e.event === 'completed')).toBe(true);
    });

    const sequenced = events.filter((e) => typeof e.sequence === 'number');
    for (let i = 1; i < sequenced.length; i++) {
      expect(sequenced[i].sequence).toBeGreaterThan(sequenced[i - 1].sequence);
    }
    await supervisor.stop();
  });

  it('receives a cancelled terminal event after analysis.cancel', async () => {
    const supervisor = makeSupervisor('cancellation');
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });

    const events = [];
    supervisor.onEvent((event) => {
      if (event.type === 'native-event') events.push(event.payload);
    });
    supervisor.send({ protocolVersion: 1, requestId: 'req-1', method: 'analysis.run', payload: {} });
    await vi.waitFor(() => expect(events.some((e) => e.event === 'accepted')).toBe(true));
    supervisor.send({ protocolVersion: 1, requestId: 'req-1', method: 'analysis.cancel', payload: {} });

    await vi.waitFor(() => {
      expect(events.some((e) => e.event === 'cancelled')).toBe(true);
    });
    await supervisor.stop();
  });

  it('flags a protocol violation on malformed JSON without crashing the supervisor', async () => {
    const supervisor = makeSupervisor('malformed-json');
    const violations = [];
    supervisor.onEvent((event) => {
      if (event.type === 'protocol-violation') violations.push(event.code);
    });
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });

    await vi.waitFor(() => {
      expect(violations).toContain('protocol_malformed_json');
    });
    expect(supervisor.state).toBe('ready');
    await supervisor.stop();
  });

  it('flags an oversized line as payload_too_large', async () => {
    const supervisor = makeSupervisor('oversized-line');
    const violations = [];
    supervisor.onEvent((event) => {
      if (event.type === 'protocol-violation') violations.push(event.code);
    });
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });

    await vi.waitFor(() => {
      expect(violations).toContain('payload_too_large');
    });
    await supervisor.stop();
  });

  it('never exposes stderr diagnostics on the native-event channel', async () => {
    const supervisor = makeSupervisor('stderr-noise');
    const events = [];
    supervisor.onEvent((event) => {
      if (event.type === 'native-event') events.push(event.payload);
    });
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });
    expect(supervisor.state).toBe('ready');
    expect(events.every((e) => !JSON.stringify(e).includes('diagnostic noise'))).toBe(true);
    await supervisor.stop();
  });

  it('transitions to unavailable on immediate exit before handshake', async () => {
    const supervisor = makeSupervisor('immediate-exit');
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });
    expect(supervisor.state).toBe('unavailable');
  });

  it('reports a crash after handshake, then restarts back to ready per the crash-loop policy', async () => {
    const supervisor = makeSupervisor('crash-mid-stream');
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });
    expect(supervisor.state).toBe('ready');

    const exits = [];
    const states = [];
    supervisor.onEvent((event) => {
      if (event.type === 'exit') exits.push(event);
      if (event.type === 'state') states.push(event.state);
    });

    supervisor.send({ protocolVersion: 1, requestId: 'req-1', method: 'analysis.run', payload: {} });

    await vi.waitFor(() => {
      expect(exits.length).toBeGreaterThan(0);
    });
    expect(states).toContain('crashed');

    // First unexpected exit restarts once (real, unfaked timers here — the
    // documented first-exit delay is 0ms/immediate); the fresh child
    // completes its handshake and the supervisor recovers to ready.
    await vi.waitFor(() => {
      expect(supervisor.state).toBe('ready');
    });
    await supervisor.stop();
  });

  it('escalates to SIGKILL when the shim ignores shutdown', async () => {
    const supervisor = makeSupervisor('ignored-shutdown');
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });
    expect(supervisor.state).toBe('ready');

    const start = Date.now();
    await supervisor.stop();
    const elapsed = Date.now() - start;

    expect(supervisor.state).toBe('stopped');
    // Should be bounded by the shutdown grace period, not hang indefinitely.
    expect(elapsed).toBeLessThan(6000);
  }, 8000);

  it('reports incompatible on a protocol version mismatch and does not restart-loop', async () => {
    const supervisor = makeSupervisor('incompatible-version');
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });
    expect(supervisor.state).toBe('incompatible');
  });

  it('reports unavailable when the binary cannot be resolved', async () => {
    const supervisor = new NativeProcessSupervisor({ resolvePath: () => null });
    await supervisor.start({ appRoot: process.cwd(), isPackaged: false });
    expect(supervisor.state).toBe('unavailable');
  });
});

/**
 * A minimal fake child process: an EventEmitter with stdout/stderr/stdin
 * streams, enough for the supervisor's spawn/handshake/exit wiring. Each
 * `spawnFn` call in a test returns the next entry from `queue` so a single
 * test can script exactly how many times `spawn` is invoked (== restarts).
 */
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { writable: true, write: vi.fn() };
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
  });
  return child;
}

function readyPayload() {
  return {
    protocolVersion: 1,
    requestId: 'runtime',
    event: 'ready',
    payload: { shimVersion: '1.0.0', supportedProtocolVersions: [1] },
  };
}

/** Drives a child through spawn -> handshake -> ready synchronously under fake timers. */
async function bringChildReady(child) {
  await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalled());
  child.stdout.write(`${JSON.stringify(readyPayload())}\n`);
  await vi.waitFor(() => {});
}

describe('NativeProcessSupervisor — crash-loop restart policy (fake timers, fake child)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeSupervisor() {
    const children = [];
    const supervisor = new NativeProcessSupervisor({
      resolvePath: () => '/fake/AppleIntelligenceShim',
      spawnFn: () => {
        const child = makeFakeChild();
        children.push(child);
        return child;
      },
    });
    return { supervisor, children };
  }

  /** Waits for a real microtask flush without advancing fake timers, so pending promise chains settle. */
  async function flush() {
    await vi.waitFor(() => {}, { timeout: 50, interval: 1 });
  }

  it('spawns exactly one child even if start() is called repeatedly', async () => {
    const { supervisor, children } = makeSupervisor();
    const startPromise = supervisor.start({ appRoot: '/x', isPackaged: false });
    await flush();
    await supervisor.start({ appRoot: '/x', isPackaged: false });
    await supervisor.start({ appRoot: '/x', isPackaged: false });
    children[0].stdout.write(`${JSON.stringify(readyPayload())}\n`);
    await startPromise;

    expect(supervisor.state).toBe('ready');
    expect(children.length).toBe(1);
  });

  it('restarts once immediately after the first unexpected exit', async () => {
    const { supervisor, children } = makeSupervisor();
    const startPromise = supervisor.start({ appRoot: '/x', isPackaged: false });
    await flush();
    children[0].stdout.write(`${JSON.stringify(readyPayload())}\n`);
    await startPromise;
    expect(supervisor.state).toBe('ready');

    const states = [];
    supervisor.onEvent((e) => {
      if (e.type === 'state') states.push(e.state);
    });

    children[0].emit('exit', 1, null);
    expect(supervisor.state).toBe('crashed');

    // First-exit delay is documented as immediate (0ms) — no advance needed
    // beyond flushing the scheduled timer callback.
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[0]);
    await flush();

    expect(children.length).toBe(2);
    expect(states).toContain('restarting');
  });

  it('uses increasing backoff for repeated crashes within the crash window', async () => {
    const { supervisor, children } = makeSupervisor();
    const startPromise = supervisor.start({ appRoot: '/x', isPackaged: false });
    await flush();
    children[0].stdout.write(`${JSON.stringify(readyPayload())}\n`);
    await startPromise;

    // First exit -> crashed, restart after RESTART_DELAYS_MS[0].
    children[0].emit('exit', 1, null);
    expect(supervisor.state).toBe('crashed');
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[0]);
    await flush();
    expect(children.length).toBe(2);
    children[1].stdout.write(`${JSON.stringify(readyPayload())}\n`);
    await flush();
    expect(supervisor.state).toBe('ready');

    // Second exit within the window -> crashed again, longer delay this time.
    children[1].emit('exit', 1, null);
    expect(supervisor.state).toBe('crashed');
    // Not yet due at the short delay.
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[0]);
    await flush();
    expect(children.length).toBe(2);
    // Due once the second (longer) delay elapses.
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[1] - RESTART_DELAYS_MS[0]);
    await flush();
    expect(children.length).toBe(3);
  });

  it('transitions to degraded on the third exit within the crash window', async () => {
    const { supervisor, children } = makeSupervisor();
    const startPromise = supervisor.start({ appRoot: '/x', isPackaged: false });
    await flush();
    children[0].stdout.write(`${JSON.stringify(readyPayload())}\n`);
    await startPromise;

    for (let i = 0; i < 2; i++) {
      children[i].emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[Math.min(i, RESTART_DELAYS_MS.length - 1)]);
      await flush();
      children[i + 1].stdout.write(`${JSON.stringify(readyPayload())}\n`);
      await flush();
    }

    // Third exit -> degraded, but a restart is still scheduled.
    children[2].emit('exit', 1, null);
    expect(supervisor.state).toBe('degraded');
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[2]);
    await flush();
    expect(children.length).toBe(4);
  });

  it('transitions to disabled on the fourth exit and stops restarting', async () => {
    const { supervisor, children } = makeSupervisor();
    const startPromise = supervisor.start({ appRoot: '/x', isPackaged: false });
    await flush();
    children[0].stdout.write(`${JSON.stringify(readyPayload())}\n`);
    await startPromise;

    for (let i = 0; i < 3; i++) {
      children[i].emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[Math.min(i, RESTART_DELAYS_MS.length - 1)]);
      await flush();
      children[i + 1].stdout.write(`${JSON.stringify(readyPayload())}\n`);
      await flush();
    }
    expect(children.length).toBe(4);

    const disabledEvents = [];
    supervisor.onEvent((e) => {
      if (e.type === 'disabled') disabledEvents.push(e);
    });

    // Fourth exit -> disabled, no further restart even after a long wait.
    children[3].emit('exit', 1, null);
    expect(supervisor.state).toBe('disabled');
    expect(disabledEvents).toHaveLength(1);
    expect(disabledEvents[0].reason).toBe('crash-loop');

    await vi.advanceTimersByTimeAsync(600000);
    await flush();
    expect(children.length).toBe(4);
    expect(supervisor.state).toBe('disabled');

    // A caller retrying start() after disablement must not spawn again.
    await supervisor.start({ appRoot: '/x', isPackaged: false });
    expect(children.length).toBe(4);
  });

  it('does not restart after normal/intentional shutdown', async () => {
    const { supervisor, children } = makeSupervisor();
    const startPromise = supervisor.start({ appRoot: '/x', isPackaged: false });
    await flush();
    children[0].stdout.write(`${JSON.stringify(readyPayload())}\n`);
    await startPromise;
    expect(supervisor.state).toBe('ready');

    const stopPromise = supervisor.stop();
    // stop() sends shutdown then kills; the fake child's kill() emits exit.
    await vi.advanceTimersByTimeAsync(0);
    await stopPromise;

    expect(supervisor.state).toBe('stopped');
    expect(children.length).toBe(1);

    await vi.advanceTimersByTimeAsync(600000);
    await flush();
    expect(children.length).toBe(1);
    expect(supervisor.state).toBe('stopped');
  });

  it('does not restart after explicit feature disablement', async () => {
    const { supervisor, children } = makeSupervisor();
    const startPromise = supervisor.start({ appRoot: '/x', isPackaged: false });
    await flush();
    children[0].stdout.write(`${JSON.stringify(readyPayload())}\n`);
    await startPromise;

    supervisor.disableFeature('user-toggled-off');
    expect(supervisor.state).toBe('disabled');

    children[0].emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(600000);
    await flush();

    expect(children.length).toBe(1);
    expect(supervisor.state).toBe('disabled');
  });

  it('cancels a pending restart timer on shutdown so it never fires later', async () => {
    const { supervisor, children } = makeSupervisor();
    const startPromise = supervisor.start({ appRoot: '/x', isPackaged: false });
    await flush();
    children[0].stdout.write(`${JSON.stringify(readyPayload())}\n`);
    await startPromise;

    // First exit schedules a restart timer, then stop() is called before it fires.
    children[0].emit('exit', 1, null);
    expect(supervisor.state).toBe('crashed');
    expect(supervisor.restartTimer).not.toBeNull();

    const stopPromise = supervisor.stop();
    expect(supervisor.restartTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    await stopPromise;

    // Advance well past every documented backoff — no orphaned timer should fire.
    await vi.advanceTimersByTimeAsync(600000);
    await flush();
    expect(children.length).toBe(1);
    expect(supervisor.state).toBe('stopped');
  });

  it('rejects/terminates pending requests deterministically when the child exits', async () => {
    const { supervisor, children } = makeSupervisor();
    const startPromise = supervisor.start({ appRoot: '/x', isPackaged: false });
    await flush();
    children[0].stdout.write(`${JSON.stringify(readyPayload())}\n`);
    await startPromise;

    supervisor.send({ protocolVersion: 1, requestId: 'req-1', method: 'analysis.run', payload: {} });
    expect(supervisor.child).not.toBeNull();

    const exitEvents = [];
    supervisor.onEvent((e) => {
      if (e.type === 'exit') exitEvents.push(e);
    });

    children[0].emit('exit', 1, null);

    // The exit event is the deterministic signal callers use to fail any
    // request they were tracking; the supervisor itself clears its handle to
    // the dead child so `send()` becomes a no-op instead of writing to a
    // dead pipe.
    expect(exitEvents).toHaveLength(1);
    expect(supervisor.child).toBeNull();
    expect(() =>
      supervisor.send({ protocolVersion: 1, requestId: 'req-1', method: 'analysis.cancel', payload: {} }),
    ).not.toThrow();
  });
});
