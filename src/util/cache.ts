interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<K, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly counters = { hits: 0, misses: 0, sets: 0, evictions: 0, expired: 0 };

  constructor(ttlMs: number, maxEntries = 1000) {
    this.ttlMs = Math.max(0, ttlMs);
    this.maxEntries = Math.max(1, maxEntries);
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.counters.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      this.counters.expired += 1;
      this.counters.misses += 1;
      return undefined;
    }
    // Refresh insertion order so a burst of one-off keys cannot evict hot entries.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.counters.hits += 1;
    return entry.value;
  }

  set(key: K, value: V, ttlMs = this.ttlMs): void {
    if (ttlMs <= 0) return;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
        this.counters.evictions += 1;
      }
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    this.counters.sets += 1;
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

  stats(): {
    hits: number;
    misses: number;
    sets: number;
    evictions: number;
    expired: number;
    size: number;
    maxEntries: number;
    ttlMs: number;
  } {
    return {
      ...this.counters,
      size: this.entries.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
    };
  }
}
