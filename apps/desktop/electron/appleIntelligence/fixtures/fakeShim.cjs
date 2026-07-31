#!/usr/bin/env node
// Deterministic fake sidecar for Electron-side integration tests. Canonical
// spec: docs/apple-intelligence/testing-and-observability.md ("Do not mock
// only AppleIntelligenceClient; test actual child-process framing and
// lifecycle behavior"). Scripted behavior is selected via the
// FAKE_SHIM_BEHAVIOR env var so tests exercise real child-process framing
// against each documented failure mode.
const behavior = process.env.FAKE_SHIM_BEHAVIOR || 'valid-handshake';

function writeLine(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function readyEvent() {
  return {
    protocolVersion: 1,
    requestId: 'runtime',
    event: 'ready',
    payload: {
      shimVersion: 'fake-0.0.1',
      supportedProtocolVersions: [1],
      snapshotSchemaVersions: [1],
      resultSchemaVersions: [1],
      capabilities: ['availability', 'prewarm', 'structured-generation', 'cancellation'],
    },
  };
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  // eslint-disable-next-line no-cond-assign
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    handleRequest(request);
  }
});

function handleRequest(request) {
  switch (behavior) {
    case 'valid-handshake':
      if (request.method === 'runtime.hello') writeLine(readyEvent());
      else if (request.method === 'analysis.run') {
        writeLine({ protocolVersion: 1, requestId: request.requestId, event: 'accepted' });
        writeLine({
          protocolVersion: 1,
          requestId: request.requestId,
          event: 'completed',
          sequence: 1,
          payload: { text: 'fake result' },
        });
      } else if (request.method === 'runtime.shutdown') {
        writeLine({ protocolVersion: 1, requestId: request.requestId, event: 'completed' });
      }
      return;

    case 'streaming':
      if (request.method === 'runtime.hello') writeLine(readyEvent());
      else if (request.method === 'analysis.run') {
        writeLine({ protocolVersion: 1, requestId: request.requestId, event: 'accepted' });
        writeLine({ protocolVersion: 1, requestId: request.requestId, event: 'progress', sequence: 0 });
        writeLine({ protocolVersion: 1, requestId: request.requestId, event: 'progress', sequence: 1 });
        writeLine({ protocolVersion: 1, requestId: request.requestId, event: 'completed', sequence: 2 });
      }
      return;

    case 'delayed-response':
      if (request.method === 'runtime.hello') writeLine(readyEvent());
      else if (request.method === 'analysis.run') {
        writeLine({ protocolVersion: 1, requestId: request.requestId, event: 'accepted' });
        setTimeout(() => {
          writeLine({ protocolVersion: 1, requestId: request.requestId, event: 'completed', sequence: 1 });
        }, 300);
      }
      return;

    case 'cancellation':
      if (request.method === 'runtime.hello') writeLine(readyEvent());
      else if (request.method === 'analysis.run') {
        writeLine({ protocolVersion: 1, requestId: request.requestId, event: 'accepted' });
      } else if (request.method === 'analysis.cancel') {
        writeLine({ protocolVersion: 1, requestId: request.requestId, event: 'cancelled' });
      }
      return;

    case 'malformed-json':
      if (request.method === 'runtime.hello') {
        writeLine(readyEvent());
        process.stdout.write('{not valid json\n');
      }
      return;

    case 'oversized-line':
      if (request.method === 'runtime.hello') {
        writeLine(readyEvent());
        process.stdout.write(`${JSON.stringify({ protocolVersion: 1, requestId: 'r', event: 'progress', payload: 'x'.repeat(1024 * 1024) })}\n`);
      }
      return;

    case 'duplicate-terminal':
      if (request.method === 'runtime.hello') writeLine(readyEvent());
      else if (request.method === 'analysis.run') {
        writeLine({ protocolVersion: 1, requestId: request.requestId, event: 'completed', sequence: 1 });
        writeLine({ protocolVersion: 1, requestId: request.requestId, event: 'failed', sequence: 2 });
      }
      return;

    case 'out-of-order-sequence':
      if (request.method === 'runtime.hello') writeLine(readyEvent());
      else if (request.method === 'analysis.run') {
        writeLine({ protocolVersion: 1, requestId: request.requestId, event: 'progress', sequence: 2 });
        writeLine({ protocolVersion: 1, requestId: request.requestId, event: 'progress', sequence: 1 });
      }
      return;

    case 'stderr-noise':
      if (request.method === 'runtime.hello') {
        process.stderr.write('diagnostic noise that must never appear on stdout\n');
        writeLine(readyEvent());
      }
      return;

    case 'immediate-exit':
      process.exit(1);
      return;

    case 'crash-mid-stream':
      if (request.method === 'runtime.hello') writeLine(readyEvent());
      else if (request.method === 'analysis.run') {
        writeLine({ protocolVersion: 1, requestId: request.requestId, event: 'accepted' });
        process.exit(1);
      }
      return;

    case 'ignored-shutdown':
      if (request.method === 'runtime.hello') writeLine(readyEvent());
      // runtime.shutdown intentionally produces no response — the
      // supervisor's graceful-shutdown timeout must still terminate it.
      return;

    case 'incompatible-version':
      if (request.method === 'runtime.hello') {
        writeLine({ ...readyEvent(), payload: { ...readyEvent().payload, supportedProtocolVersions: [999] } });
      }
      return;

    default:
      return;
  }
}

process.stdin.resume();
