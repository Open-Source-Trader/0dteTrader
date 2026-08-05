export type DurableCursorDecision = 'accepted' | 'duplicate' | 'gap';

const SEEN_LIMIT = 512;

function jwtSubject(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const parsed: unknown = JSON.parse(globalThis.atob(padded));
    if (typeof parsed !== 'object' || parsed === null || !('sub' in parsed)) return null;
    const subject = (parsed as { sub?: unknown }).sub;
    return typeof subject === 'string' && subject.length > 0 ? subject : null;
  } catch {
    return null;
  }
}

/**
 * Per-user durable stream cursor. Sequence persistence survives app restarts;
 * the bounded event-id set only suppresses duplicates inside the current app
 * session. A gap is refused so the socket can reconnect and replay from the
 * last contiguous sequence instead of advancing past missing events.
 */
export class DurableEventCursor {
  private userId: string | null = null;
  private lastSequence = 0;
  private initialized = false;
  private readonly seenIds = new Set<string>();
  private readonly seenOrder: string[] = [];

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly serverKey: string,
  ) {}

  get sequence(): number {
    return this.lastSequence;
  }

  get resumable(): boolean {
    return this.userId !== null && this.initialized;
  }

  /** Used by regression tests to prove the de-duplication window is bounded. */
  get retainedEventCount(): number {
    return this.seenIds.size;
  }

  activate(token: string): void {
    const nextUserId = jwtSubject(token);
    if (nextUserId === this.userId) return;
    this.userId = nextUserId;
    this.seenIds.clear();
    this.seenOrder.length = 0;
    if (!nextUserId) {
      this.lastSequence = 0;
      this.initialized = false;
      return;
    }
    const raw = this.storage.getItem(this.key(nextUserId));
    const stored = Number.parseInt(raw ?? '0', 10);
    this.lastSequence = Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
    this.initialized = raw !== null;
  }

  accept(eventId: string, sequence: number): DurableCursorDecision {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return 'duplicate';
    if (this.seenIds.has(eventId) || sequence <= this.lastSequence) return 'duplicate';
    if (this.initialized && sequence !== this.lastSequence + 1) return 'gap';

    this.seenIds.add(eventId);
    this.seenOrder.push(eventId);
    if (this.seenOrder.length > SEEN_LIMIT) {
      const removed = this.seenOrder.shift();
      if (removed) this.seenIds.delete(removed);
    }
    this.lastSequence = sequence;
    this.persist();
    return 'accepted';
  }

  /** Records the server's post-replay tail, including zero. */
  establish(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < this.lastSequence) return;
    this.lastSequence = sequence;
    this.persist();
  }

  resetSession(): void {
    this.userId = null;
    this.lastSequence = 0;
    this.initialized = false;
    this.seenIds.clear();
    this.seenOrder.length = 0;
  }

  private key(userId: string): string {
    return `events.cursor.v1:${this.serverKey}:${userId}`;
  }

  private persist(): void {
    if (!this.userId) return;
    this.initialized = true;
    this.storage.setItem(this.key(this.userId), String(this.lastSequence));
  }
}
