/** Minimal TTL cache used for Webull rate-limit protection. */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    if (this.entries.size > 5_000) this.entries.clear();
    this.entries.set(key, { value, expires: Date.now() + ttlMs });
  }
}
