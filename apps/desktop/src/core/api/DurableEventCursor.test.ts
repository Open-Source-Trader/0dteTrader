import { beforeEach, describe, expect, it } from 'vitest';
import { DurableEventCursor } from './DurableEventCursor';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const storage = new MemoryStorage();

function tokenFor(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject }))
    .replaceAll('+', '-')
    .replaceAll('/', '_');
  return `header.${payload}.signature`;
}

describe('DurableEventCursor', () => {
  beforeEach(() => storage.clear());

  it('persists a contiguous cursor per server and user across app restarts', () => {
    const first = new DurableEventCursor(storage, 'wss://one.example/v1/stream');
    first.activate(tokenFor('user-a'));
    expect(first.begin('event-1', 7)).toBe('accepted');
    expect(first.commit('event-1', 7)).toBe(true);

    const restarted = new DurableEventCursor(storage, 'wss://one.example/v1/stream');
    restarted.activate(tokenFor('user-a'));
    expect(restarted.sequence).toBe(7);
    expect(restarted.begin('event-1-redelivery', 7)).toBe('duplicate');

    restarted.activate(tokenFor('user-b'));
    expect(restarted.sequence).toBe(0);
  });

  it('refuses gaps without advancing and bounds in-session event IDs', () => {
    const cursor = new DurableEventCursor(storage, 'wss://example.test/v1/stream');
    cursor.activate(tokenFor('user-a'));
    expect(cursor.begin('start', 1)).toBe('accepted');
    expect(cursor.commit('start', 1)).toBe(true);
    expect(cursor.begin('gap', 3)).toBe('gap');
    expect(cursor.sequence).toBe(1);

    for (let sequence = 2; sequence <= 700; sequence += 1) {
      expect(cursor.begin(`event-${sequence}`, sequence)).toBe('accepted');
      expect(cursor.commit(`event-${sequence}`, sequence)).toBe(true);
    }
    expect(cursor.retainedEventCount).toBe(512);
  });

  it('persists a zero baseline so the next connection resumes instead of rebasing', () => {
    const first = new DurableEventCursor(storage, 'wss://example.test/v1/stream');
    first.activate(tokenFor('user-a'));
    expect(first.resumable).toBe(false);
    first.establish(0);

    const restarted = new DurableEventCursor(storage, 'wss://example.test/v1/stream');
    restarted.activate(tokenFor('user-a'));
    expect(restarted.resumable).toBe(true);
    expect(restarted.sequence).toBe(0);
    expect(restarted.begin('event-2', 2)).toBe('gap');
    expect(restarted.begin('event-1', 1)).toBe('accepted');
  });

  it('does not persist an event until its consumer commits delivery', () => {
    const first = new DurableEventCursor(storage, 'wss://example.test/v1/stream');
    first.activate(tokenFor('user-a'));
    expect(first.begin('event-1', 1)).toBe('accepted');
    expect(first.sequence).toBe(0);

    const beforeDelivery = new DurableEventCursor(storage, 'wss://example.test/v1/stream');
    beforeDelivery.activate(tokenFor('user-a'));
    expect(beforeDelivery.resumable).toBe(false);
    expect(beforeDelivery.sequence).toBe(0);

    expect(first.commit('event-1', 1)).toBe(true);
    const afterDelivery = new DurableEventCursor(storage, 'wss://example.test/v1/stream');
    afterDelivery.activate(tokenFor('user-a'));
    expect(afterDelivery.sequence).toBe(1);
  });
});
