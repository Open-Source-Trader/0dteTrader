import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { NativeProcessSupervisor } = require('./supervisor.cjs');

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

  it('reports a crash after handshake and does not restart-loop past the cap', async () => {
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
    expect(supervisor.state).toBe('crashed');
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
