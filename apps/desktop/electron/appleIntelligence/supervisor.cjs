// Sidecar process supervisor. Mirrors the existing ensureBackend()/
// stopBackend() shape in electron/main.cjs (module-scoped instance here
// instead, since more than one BrowserWindow session may want a reference).
// Canonical spec: docs/apple-intelligence/lifecycle-and-concurrency.md
// (runtime state machine, crash-loop policy) and architecture.md
// (NativeProcessSupervisor responsibilities).
const { spawn } = require('node:child_process');
const path = require('node:path');
const { LineFramer } = require('./lineFramer.cjs');
const { parseNativeEventLine } = require('./protocol.cjs');
const { resolveShimPath } = require('./binaryResolver.cjs');

const HANDSHAKE_TIMEOUT_MS = 5000;
const SHUTDOWN_GRACE_MS = 3000;
const MAX_LINE_BYTES = 256 * 1024;
const CRASH_WINDOW_MS = 60000;

// Crash-loop policy (docs/apple-intelligence/lifecycle-and-concurrency.md):
// 1st exit -> restart immediately, 2nd within the window -> short backoff,
// 3rd within the window -> longer backoff + degraded, 4th+ -> disabled.
// Not documented with exact millisecond values beyond "short"/"longer", so
// these are deliberately small, testable constants.
const RESTART_DELAYS_MS = [0, 1000, 5000];

const STATES = [
  'stopped',
  'starting',
  'handshaking',
  'ready',
  'unavailable',
  'incompatible',
  'degraded',
  'crashed',
  'restarting',
  'disabled',
];

/**
 * Owns the sidecar child process, NDJSON framing, and the state machine from
 * lifecycle-and-concurrency.md. Does not know about renderer windows, the
 * scheduler, or the request registry — those are Phase 3 concerns layered
 * on top via `onEvent`.
 */
class NativeProcessSupervisor {
  constructor({ resolvePath = resolveShimPath, spawnFn = spawn } = {}) {
    this.resolvePath = resolvePath;
    this.spawnFn = spawnFn;
    this.state = 'stopped';
    this.child = null;
    this.framer = null;
    this.listeners = new Set();
    this.recentExits = [];
    this.shuttingDown = false;
    this.disabled = false;
    this.lastContext = null;
    this.restartTimer = null;
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  setState(state) {
    this.state = state;
    this.emit({ type: 'state', state });
  }

  /**
   * Spawns the child, performs the runtime.hello handshake, and resolves
   * once `ready` (or a terminal unavailable/incompatible state) is reached.
   * Never throws for legitimate unavailability — callers read `this.state`.
   */
  async start(context) {
    if (this.state === 'ready' || this.state === 'starting' || this.state === 'handshaking') return;
    if (this.disabled) return;
    this.cancelRestartTimer();
    this.shuttingDown = false;
    this.lastContext = context;
    this.setState('starting');

    const binaryPath = this.resolvePath(context);
    if (!binaryPath) {
      this.setState('unavailable');
      this.emit({ type: 'unavailable', reason: 'binary-not-found' });
      return;
    }

    // The binary's own directory, not appRoot: in a packaged build appRoot
    // resolves inside app.asar, which is a file, not a directory — spawn's
    // cwd must be a real filesystem directory. The binary itself is never
    // inside the asar (electron-builder's extraResources sits alongside
    // it), so this is always real. It also happens to satisfy
    // security-boundary.md's "fixed working directory with no sensitive
    // data" requirement better than the app root would.
    const child = this.spawnFn(binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: minimalEnv(),
      cwd: path.dirname(binaryPath),
    });
    this.child = child;
    this.framer = new LineFramer({
      maxLineBytes: MAX_LINE_BYTES,
      onLine: (line) => this.handleLine(line),
      onOversized: () => this.emit({ type: 'protocol-violation', code: 'payload_too_large' }),
    });
    child.stdout.on('data', (chunk) => this.framer.push(chunk));
    child.stderr.on('data', () => {
      // Diagnostics-only; not forwarded to renderer or production logs by
      // default (security-boundary.md — stderr may carry safe metadata,
      // never raw payloads, and this supervisor does not parse it).
    });
    child.on('exit', (code, signal) => this.handleExit(code, signal));

    this.setState('handshaking');
    const handshakeResult = await this.performHandshake(child);
    if (handshakeResult.ok) {
      this.setState('ready');
    } else if (handshakeResult.reason === 'timeout') {
      this.setState('unavailable');
      this.emit({ type: 'unavailable', reason: 'handshake-timeout' });
      this.killChild(child);
    } else if (handshakeResult.reason === 'incompatible') {
      this.setState('incompatible');
      this.emit({ type: 'incompatible', reason: 'protocol-version-mismatch' });
    } else if (handshakeResult.reason === 'exited') {
      this.setState('unavailable');
      this.emit({ type: 'unavailable', reason: 'exited-before-handshake' });
    }
  }

  performHandshake(child) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribeEvent();
        child.off('exit', onExit);
        resolve(result);
      };

      const timer = setTimeout(() => settle({ ok: false, reason: 'timeout' }), HANDSHAKE_TIMEOUT_MS);

      const onExit = () => settle({ ok: false, reason: 'exited' });
      child.once('exit', onExit);

      const unsubscribeEvent = this.onEvent((event) => {
        if (event.type !== 'native-event' || event.payload.event !== 'ready') return;
        const readyPayload = event.payload.payload;
        const compatible =
          Array.isArray(readyPayload?.supportedProtocolVersions) &&
          readyPayload.supportedProtocolVersions.includes(1);
        settle(compatible ? { ok: true } : { ok: false, reason: 'incompatible' });
      });

      this.writeRequest(child, {
        protocolVersion: 1,
        requestId: 'runtime',
        method: 'runtime.hello',
        payload: {},
      });
    });
  }

  handleLine(line) {
    const event = parseNativeEventLine(line, MAX_LINE_BYTES);
    if (!event) {
      this.emit({ type: 'protocol-violation', code: 'protocol_malformed_json' });
      return;
    }
    this.emit({ type: 'native-event', payload: event });
  }

  writeRequest(child, request) {
    if (!child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  send(request) {
    if (this.state !== 'ready' || !this.child) return;
    this.writeRequest(this.child, request);
  }

  handleExit(code, signal) {
    const wasReady = this.state === 'ready';
    this.child = null;
    this.framer = null;

    if (this.shuttingDown) {
      this.setState('stopped');
      return;
    }

    this.emit({ type: 'exit', code, signal });

    if (!wasReady) return;

    const now = Date.now();
    this.recentExits = this.recentExits.filter((t) => now - t < CRASH_WINDOW_MS);
    this.recentExits.push(now);
    const exitCount = this.recentExits.length;

    if (exitCount >= 4) {
      this.disabled = true;
      this.setState('disabled');
      this.emit({ type: 'disabled', reason: 'crash-loop' });
      return;
    }

    this.setState(exitCount >= 3 ? 'degraded' : 'crashed');
    this.scheduleRestart(RESTART_DELAYS_MS[exitCount - 1] ?? RESTART_DELAYS_MS[RESTART_DELAYS_MS.length - 1]);
  }

  /** Only one restart timer may exist at any time; a fresh exit replaces any pending one. */
  scheduleRestart(delayMs) {
    this.cancelRestartTimer();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.shuttingDown || this.disabled) return;
      this.setState('restarting');
      void this.start(this.lastContext);
    }, delayMs);
  }

  cancelRestartTimer() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  killChild(child) {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }

  /** Bounded graceful shutdown: request shutdown, escalate to SIGKILL after a timeout. */
  async stop() {
    this.shuttingDown = true;
    this.cancelRestartTimer();
    if (!this.child) {
      this.setState('stopped');
      return;
    }
    const child = this.child;
    this.send({ protocolVersion: 1, requestId: 'shutdown', method: 'runtime.shutdown', payload: {} });

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        resolve();
      }, SHUTDOWN_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.killChild(child); // SIGTERM as the graceful-shutdown request
    });
    this.setState('stopped');
  }

  /** Explicit feature disablement (AI toggled off): never restart, mirrors crash-loop disable. */
  disableFeature(reason = 'feature-disabled') {
    this.disabled = true;
    this.cancelRestartTimer();
    this.setState('disabled');
    this.emit({ type: 'disabled', reason });
  }
}

/** Never inherit process.env wholesale (security-boundary.md). */
function minimalEnv() {
  return {
    PATH: process.env.PATH,
  };
}

module.exports = {
  NativeProcessSupervisor,
  STATES,
  HANDSHAKE_TIMEOUT_MS,
  SHUTDOWN_GRACE_MS,
  CRASH_WINDOW_MS,
  RESTART_DELAYS_MS,
};
