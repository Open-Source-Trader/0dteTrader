#!/usr/bin/env node
// Canonical spec: docs/apple-intelligence/packaging-and-signing.md
// ("Release smoke test"): launch the packaged sidecar, complete the
// handshake, query availability, run a bounded request, cancel one, shut
// down gracefully, and confirm no sensitive payload content leaks to
// stderr/logs. Drives the REAL NativeProcessSupervisor (not a reimplementation)
// against the REAL packaged binary so packaged path resolution, framing,
// and lifecycle are what production runs.
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const desktopRoot = path.resolve(new URL('..', import.meta.url).pathname);
const { NativeProcessSupervisor } = require(
  path.join(desktopRoot, 'electron/appleIntelligence/supervisor.cjs'),
);

// A recognizable-but-fake marker standing in for sensitive payload content
// (account ids, exact positions). If it shows up on stderr, log safety is
// broken (testing-and-observability.md "Logging constraints").
const SENSITIVE_MARKER = 'SMOKE-SENSITIVE-ACCT-99887766';

function findShim() {
  const explicit = process.argv[2];
  if (explicit) return explicit;
  const releaseDir = path.join(desktopRoot, 'release');
  for (const entry of existsSync(releaseDir) ? readdirSync(releaseDir) : []) {
    const candidate = path.join(
      releaseDir,
      entry,
      '0dteTrader.app/Contents/Resources/native/apple-intelligence-shim/AppleIntelligenceShim',
    );
    if (entry.startsWith('mac') && existsSync(candidate)) return candidate;
  }
  console.error('✗ packaged shim not found; run dist:mac first or pass a path');
  process.exit(1);
}

const shimPath = findShim();
const supervisor = new NativeProcessSupervisor({ resolvePath: () => shimPath });

let stderrOutput = '';
const events = [];
supervisor.onEvent((event) => {
  if (event.type === 'native-event') events.push(event.payload);
});

function waitForTerminal(requestId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for terminal event on ${requestId}`));
    }, timeoutMs);
    const unsubscribe = supervisor.onEvent((event) => {
      if (event.type !== 'native-event' || event.payload.requestId !== requestId) return;
      if (!['completed', 'failed', 'cancelled'].includes(event.payload.event)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event.payload);
    });
  });
}

function snapshot(id) {
  return {
    snapshotSchemaVersion: 1,
    identity: {
      snapshotId: id,
      capturedAt: new Date().toISOString(),
      symbol: 'SPY',
      timeframe: '1m',
      snapshotSequence: 1,
      positionVersion: 0,
    },
    trigger: { kind: 'manual', priority: 'manual', reason: `packaged smoke ${SENSITIVE_MARKER}` },
    market: { last: 500.1, bid: 500.05, ask: 500.15 },
    candles: {
      count: 2,
      recent: [
        { time: 1784298540, open: 500, high: 500.5, low: 499.8, close: 500.2, volume: 1000 },
        { time: 1784298600, open: 500.2, high: 500.6, low: 500.0, close: 500.1, volume: 900 },
      ],
    },
    indicators: { rsi: 51.2, vwap: 500.05 },
    levels: [],
    quality: {
      capturedAt: new Date().toISOString(),
      candlesFreshAsOf: new Date().toISOString(),
      isChainStale: false,
    },
    omissions: [],
  };
}

function step(label) {
  console.log(`— ${label}`);
}

const startedAt = Date.now();
step('1. spawn + handshake');
await supervisor.start({ isPackaged: true, resourcesPath: 'unused', appRoot: 'unused' });
if (supervisor.state !== 'ready') {
  console.error(`✗ handshake failed: supervisor state is ${supervisor.state}`);
  process.exit(1);
}
supervisor.child.stderr.on('data', (chunk) => {
  stderrOutput += String(chunk);
});
console.log(`✓ ready in ${Date.now() - startedAt}ms`);

step('2. availability query');
supervisor.send({
  protocolVersion: 1,
  requestId: 'smoke-availability',
  method: 'runtime.availability',
  payload: {},
});
const availability = await waitForTerminal('smoke-availability', 10000);
console.log(`✓ availability: ${JSON.stringify(availability.payload)}`);
const modelReady = availability.payload?.state === 'ready';

if (modelReady) {
  step('3. bounded analysis request');
  const analysisStart = Date.now();
  supervisor.send({
    protocolVersion: 1,
    requestId: 'smoke-analysis',
    method: 'analysis.run',
    payload: snapshot('smoke-1'),
  });
  const analysis = await waitForTerminal('smoke-analysis', 120000);
  if (analysis.event !== 'completed') {
    console.error(`✗ analysis ended with ${analysis.event}: ${JSON.stringify(analysis.error)}`);
    process.exit(1);
  }
  console.log(
    `✓ analysis completed in ${Date.now() - analysisStart}ms ` +
      `(recommendation: ${analysis.payload?.recommendation})`,
  );
} else {
  step('3. bounded analysis request — skipped (model unavailable on this host)');
}

step('4. cancellation');
supervisor.send({
  protocolVersion: 1,
  requestId: 'smoke-cancel-target',
  method: 'analysis.run',
  payload: snapshot('smoke-2'),
});
supervisor.send({
  protocolVersion: 1,
  requestId: 'smoke-cancel-target',
  method: 'analysis.cancel',
  payload: {},
});
const cancelOutcome = await waitForTerminal('smoke-cancel-target', 120000);
// A fast completion can legitimately beat the cancel; both are terminal and
// protocol-clean. 'failed' is not.
if (cancelOutcome.event === 'failed') {
  console.error(`✗ cancel target failed: ${JSON.stringify(cancelOutcome.error)}`);
  process.exit(1);
}
console.log(`✓ cancel target terminated with '${cancelOutcome.event}'`);

step('5. graceful shutdown');
const child = supervisor.child;
await supervisor.stop();
if (child.exitCode === null && !child.killed) {
  console.error('✗ child still running after stop()');
  process.exit(1);
}
console.log(`✓ shut down (exit code ${child.exitCode})`);

step('6. log safety');
if (stderrOutput.includes(SENSITIVE_MARKER)) {
  console.error('✗ sensitive payload content leaked to stderr');
  process.exit(1);
}
const violations = events.filter((e) => e.event === 'failed' && e.requestId === 'runtime');
console.log(
  `✓ no sensitive payload content on stderr (${stderrOutput.length} bytes of diagnostics, ${violations.length} runtime failures)`,
);

console.log(`packaged shim smoke test passed in ${Date.now() - startedAt}ms`);
process.exit(0);
