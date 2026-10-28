interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<K, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs: number, maxEntries = 1000) {
    this.ttlMs = Math.max(0, ttlMs);
    this.maxEntries = Math.max(1, maxEntries);
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V, ttlMs = this.ttlMs): void {
    if (ttlMs <= 0) return;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
