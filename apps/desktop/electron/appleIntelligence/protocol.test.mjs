import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { parseNativeEventLine } = require('./protocol.cjs');
const { LineFramer } = require('./lineFramer.cjs');
const { SequenceGuard } = require('./sequenceGuard.cjs');

const fixturesPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/protocol-events.json',
);
const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));

const MAX_LINE_BYTES = 256 * 1024;

describe('parseNativeEventLine — golden fixtures', () => {
  for (const { name, line } of fixtures.valid) {
    it(`accepts: ${name}`, () => {
      expect(parseNativeEventLine(line, MAX_LINE_BYTES)).not.toBeNull();
    });
  }

  for (const { name, line } of fixtures.invalid) {
    it(`rejects: ${name}`, () => {
      expect(parseNativeEventLine(line, MAX_LINE_BYTES)).toBeNull();
    });
  }

  it('rejects an oversized line before allocating a JSON parse', () => {
    const huge = `{"protocolVersion":1,"requestId":"req-1","event":"accepted","payload":"${'x'.repeat(300)}"}`;
    expect(parseNativeEventLine(huge, 32)).toBeNull();
  });
});

describe('SequenceGuard — protocol invariants', () => {
  it('rejects a duplicate terminal event', () => {
    const guard = new SequenceGuard();
    const [first, second] = fixtures.sequenceViolations.duplicateTerminal.map((line) =>
      parseNativeEventLine(line, MAX_LINE_BYTES),
    );
    expect(guard.admit(first).ok).toBe(true);
    expect(guard.admit(second)).toEqual({ ok: false, violation: 'duplicate_terminal' });
  });

  it('rejects an out-of-order (decreasing) sequence number', () => {
    const guard = new SequenceGuard();
    const [first, second] = fixtures.sequenceViolations.outOfOrderSequence.map((line) =>
      parseNativeEventLine(line, MAX_LINE_BYTES),
    );
    expect(guard.admit(first).ok).toBe(true);
    expect(guard.admit(second)).toEqual({ ok: false, violation: 'sequence_violation' });
  });

  it('accepts strictly increasing sequence numbers for the same request', () => {
    const guard = new SequenceGuard();
    expect(guard.admit({ requestId: 'r', event: 'progress', sequence: 0 }).ok).toBe(true);
    expect(guard.admit({ requestId: 'r', event: 'progress', sequence: 1 }).ok).toBe(true);
    expect(guard.admit({ requestId: 'r', event: 'completed', sequence: 2 }).ok).toBe(true);
  });

  it('tracks each request independently', () => {
    const guard = new SequenceGuard();
    expect(guard.admit({ requestId: 'a', event: 'completed' }).ok).toBe(true);
    expect(guard.admit({ requestId: 'b', event: 'accepted' }).ok).toBe(true);
  });
});

describe('LineFramer — fragmented stdout chunks', () => {
  it('yields one line delivered in a single chunk', () => {
    const lines = [];
    const framer = new LineFramer({ onLine: (l) => lines.push(l) });
    framer.push('{"a":1}\n');
    expect(lines).toEqual(['{"a":1}']);
  });

  it('reassembles a line split across multiple chunks', () => {
    const lines = [];
    const framer = new LineFramer({ onLine: (l) => lines.push(l) });
    framer.push('{"a":');
    framer.push('1}');
    framer.push('\n');
    expect(lines).toEqual(['{"a":1}']);
  });

  it('yields multiple lines delivered in one chunk', () => {
    const lines = [];
    const framer = new LineFramer({ onLine: (l) => lines.push(l) });
    framer.push('{"a":1}\n{"a":2}\n{"a":3}\n');
    expect(lines).toEqual(['{"a":1}', '{"a":2}', '{"a":3}']);
  });

  it('retains a final partial line across pushes without emitting it', () => {
    const lines = [];
    const framer = new LineFramer({ onLine: (l) => lines.push(l) });
    framer.push('{"a":1}\n{"partial":');
    expect(lines).toEqual(['{"a":1}']);
    framer.push('true}\n');
    expect(lines).toEqual(['{"a":1}', '{"partial":true}']);
  });

  it('discards an oversized line and reports it without buffering unbounded memory', () => {
    const lines = [];
    let oversizedCount = 0;
    const framer = new LineFramer({
      maxLineBytes: 16,
      onLine: (l) => lines.push(l),
      onOversized: () => oversizedCount += 1,
    });
    framer.push(`{"a":"${'x'.repeat(100)}"}\n{"a":2}\n`);
    expect(oversizedCount).toBe(1);
    expect(lines).toEqual(['{"a":2}']);
  });

  it('discards the remainder of an oversized line spanning multiple chunks', () => {
    const lines = [];
    let oversizedCount = 0;
    const framer = new LineFramer({
      maxLineBytes: 8,
      onLine: (l) => lines.push(l),
      onOversized: () => oversizedCount += 1,
    });
    framer.push('{"a":"'); // 6 bytes, under limit yet
    framer.push('x'.repeat(50)); // pushes buffer over maxLineBytes without a newline
    framer.push('"}\n{"a":2}\n');
    expect(oversizedCount).toBe(1);
    expect(lines).toEqual(['{"a":2}']);
  });
});
