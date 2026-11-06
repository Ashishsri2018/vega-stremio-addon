const BUCKET_TTL_MS = 10 * 60 * 1000;
const PRUNE_EVERY = 1024;
const MINUTE_MS = 60_000;

export interface RateLimitPolicy {
  perMinute: number;
  globalPerMinute: number;
  maxConcurrent: number;
}

export interface RateLimitLease {
  release(): void;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

function capacityFor(perMinute: number): number {
  return Math.max(1, Math.ceil(perMinute / 2));
}

function refill(bucket: Bucket, perMinute: number, capacity: number, now: number): number {
  const elapsed = Math.max(0, now - bucket.updatedAt);
  bucket.tokens = Math.min(capacity, bucket.tokens + (elapsed / MINUTE_MS) * perMinute);
  bucket.updatedAt = now;
  return bucket.tokens;
}

export class RateLimiter {
  private readonly perMinute: number;
  private readonly globalPerMinute: number;
  private readonly maxConcurrent: number;
  private readonly capacity: number;
  private readonly globalCapacity: number;
  private readonly buckets = new Map<string, Bucket>();
  private readonly globalBucket: Bucket;
  private active = 0;
  private acquires = 0;

  constructor(policy: RateLimitPolicy) {
    this.perMinute = Math.max(0, policy.perMinute);
    this.globalPerMinute = Math.max(0, policy.globalPerMinute);
    this.maxConcurrent = Math.max(0, policy.maxConcurrent);
    this.capacity = capacityFor(this.perMinute);
    this.globalCapacity = capacityFor(this.globalPerMinute);
    this.globalBucket = { tokens: this.globalCapacity, updatedAt: Date.now() };
  }

  tryAcquire(key: string): RateLimitLease | null {
    const now = Date.now();
    this.maybePrune(now);

    if (this.maxConcurrent > 0 && this.active >= this.maxConcurrent) return null;

    if (this.globalPerMinute > 0) {
      const tokens = refill(this.globalBucket, this.globalPerMinute, this.globalCapacity, now);
      if (tokens < 1) return null;
    }

    let bucket: Bucket | undefined;
    if (this.perMinute > 0) {
      bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
      const tokens = refill(bucket, this.perMinute, this.capacity, now);
      if (tokens < 1) {
        this.buckets.set(key, bucket);
        return null;
      }
      bucket.tokens -= 1;
      this.buckets.set(key, bucket);
    }

    if (this.globalPerMinute > 0) this.globalBucket.tokens -= 1;
    this.active += 1;

    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
      },
    };
  }

  private maybePrune(now: number): void {
    this.acquires += 1;
    if (this.acquires % PRUNE_EVERY !== 0) return;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > BUCKET_TTL_MS) this.buckets.delete(key);
    }
  }
}
