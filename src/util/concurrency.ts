export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error("Semaphore limit must be >= 1");
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function mapLimitSettled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  return mapLimit(items, limit, async (item, index) => {
    try {
      const value = await fn(item, index);
      return { status: "fulfilled", value } as PromiseFulfilledResult<R>;
    } catch (reason) {
      return { status: "rejected", reason } as PromiseRejectedResult;
    }
  });
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label = "operation"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(`${label} timed out after ${ms}ms`));
    }, Math.max(1, ms));
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

export function randomInt(min: number, max: number): number {
  const low = Math.ceil(min);
  const high = Math.floor(max);
  return Math.floor(Math.random() * (high - low + 1)) + low;
}
