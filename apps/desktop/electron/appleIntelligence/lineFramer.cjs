// Incremental newline-delimited-JSON line framer for child-process stdout.
// Pure buffering logic only — no child_process, no Electron. Canonical spec:
// docs/apple-intelligence/protocol.md ("must support fragmented chunks,
// multiple lines in one chunk, and a final partial buffer").
const DEFAULT_MAX_LINE_BYTES = 256 * 1024;

/**
 * Accumulates raw stdout chunks and yields complete lines as they close.
 * A line exceeding maxLineBytes before its terminator is dropped (and
 * reported via onOversized) rather than buffered without bound.
 */
class LineFramer {
  constructor({ maxLineBytes = DEFAULT_MAX_LINE_BYTES, onLine, onOversized } = {}) {
    this.maxLineBytes = maxLineBytes;
    this.onLine = onLine ?? (() => {});
    this.onOversized = onOversized ?? (() => {});
    this.buffer = '';
    this.discardingOversized = false;
  }

  push(chunk) {
    this.buffer += chunk.toString('utf8');
    let newlineIndex;
    // eslint-disable-next-line no-cond-assign
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (this.discardingOversized) {
        this.discardingOversized = false;
        this.onOversized();
        continue;
      }
      if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
        this.onOversized();
        continue;
      }
      if (line.length > 0) this.onLine(line);
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxLineBytes) {
      this.buffer = '';
      this.discardingOversized = true;
    }
  }

  /** Call on stream end: a non-empty trailing partial buffer is never a complete line. */
  flush() {
    this.buffer = '';
    this.discardingOversized = false;
  }
}

module.exports = { LineFramer, DEFAULT_MAX_LINE_BYTES };
