import { readJsonFile, writeJsonAtomic } from "../../util/fs.js";
import type { KVStoreApi, LoggerLike } from "../../types.js";

export interface KvStoreOptions {
  filePath: string;
  flushMs?: number;
  logger: LoggerLike;
}

const DEFAULT_FLUSH_MS = 500;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

export class KvStore implements KVStoreApi {
  private readonly filePath: string;
  private readonly flushMs: number;
  private readonly logger: LoggerLike;
  private readonly values = new Map<string, unknown>();

  private timer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private disposed = false;

  private constructor(options: KvStoreOptions) {
    this.filePath = options.filePath;
    this.flushMs = Math.max(0, options.flushMs ?? DEFAULT_FLUSH_MS);
    this.logger = options.logger;
  }

  static async open(options: KvStoreOptions): Promise<KvStore> {
    const store = new KvStore(options);
    await store.load();
    return store;
  }

  private async load(): Promise<void> {
    let data: unknown;
    try {
      data = await readJsonFile<unknown>(this.filePath);
    } catch {
      this.logger.error("kv.load_failed", {
        message: "KV file could not be read or parsed",
      });
      return;
    }
    if (data === null) return;
    if (!isPlainObject(data)) {
      this.logger.error("kv.load_failed", { message: "KV file does not contain an object" });
      return;
    }
    for (const [key, value] of Object.entries(data)) {
      this.values.set(key, value);
    }
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    if (!this.values.has(key)) return undefined;
    return structuredClone(this.values.get(key)) as T;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.assertActive();
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`KV value for "${key}" is not JSON-serializable: ${message}`);
    }
    if (serialized === undefined) {
      throw new Error(`KV value for "${key}" is not JSON-serializable`);
    }
    this.values.set(key, JSON.parse(serialized) as unknown);
    this.scheduleFlush();
  }

  async delete(key: string): Promise<boolean> {
    this.assertActive();
    const deleted = this.values.delete(key);
    if (deleted) this.scheduleFlush();
    return deleted;
  }

  async keys(): Promise<string[]> {
    return [...this.values.keys()];
  }

  async clear(): Promise<void> {
    this.assertActive();
    this.values.clear();
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.enqueueWrite();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.enqueueWrite();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("KV store is disposed");
  }

  private scheduleFlush(): void {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueueWrite().catch((error) => {
        this.logger.error("kv.flush_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.flushMs);
    this.timer.unref?.();
  }

  private enqueueWrite(): Promise<void> {
    const task = this.writeChain.then(() => this.writeNow());
    this.writeChain = task.catch(() => undefined);
    return task;
  }

  private async writeNow(): Promise<void> {
    await writeJsonAtomic(this.filePath, Object.fromEntries(this.values));
  }
}
