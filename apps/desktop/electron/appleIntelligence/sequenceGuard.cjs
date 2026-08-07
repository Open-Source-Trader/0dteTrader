// Enforces protocol.md invariants that a single decoded event cannot check
// alone: monotonically increasing sequence numbers and exactly one terminal
// event per request. Pure state machine — no I/O.
const TERMINAL_EVENTS = new Set(['completed', 'cancelled', 'failed']);

class SequenceGuard {
  constructor() {
    this.lastSequenceByRequest = new Map();
    this.terminalSeenByRequest = new Set();
  }

  /**
   * Returns { ok: true } or { ok: false, violation: 'duplicate_terminal' | 'sequence_violation' }.
   * Caller decides how to record/report the violation; this module never throws.
   */
  admit(event) {
    const { requestId, sequence, event: kind } = event;

    if (this.terminalSeenByRequest.has(requestId)) {
      return { ok: false, violation: 'duplicate_terminal' };
    }

    if (typeof sequence === 'number') {
      const last = this.lastSequenceByRequest.get(requestId);
      if (last !== undefined && sequence <= last) {
        return { ok: false, violation: 'sequence_violation' };
      }
      this.lastSequenceByRequest.set(requestId, sequence);
    }

    if (TERMINAL_EVENTS.has(kind)) {
      this.terminalSeenByRequest.add(requestId);
    }

    return { ok: true };
  }

  forget(requestId) {
    this.lastSequenceByRequest.delete(requestId);
    this.terminalSeenByRequest.delete(requestId);
  }
}

module.exports = { SequenceGuard, TERMINAL_EVENTS };
