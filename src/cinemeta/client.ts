import type {
  CinemetaApi,
  CinemetaMeta,
  LoggerLike,
  MediaType,
} from "../types.js";
import { TtlCache } from "../util/cache.js";
import { withTimeout } from "../util/concurrency.js";
import { nativeFetch } from "../util/nativeFetch.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export interface CinemetaClientOptions {
  baseUrl: string;
  logger: LoggerLike;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  ttlMs?: number;
}

function isCinemetaMeta(value: unknown): value is CinemetaMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Record<string, unknown>;
  return (
    typeof meta.id === "string" &&
    meta.id.length > 0 &&
    typeof meta.type === "string" &&
    meta.type.length > 0 &&
    typeof meta.name === "string" &&
    meta.name.length > 0
  );
}

export class CinemetaClient implements CinemetaApi {
  private readonly baseUrl: string;
  private readonly logger: LoggerLike;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cache: TtlCache<string, CinemetaMeta>;

  constructor(options: CinemetaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? nativeFetch;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.cache = new TtlCache<string, CinemetaMeta>(
      options.ttlMs ?? DEFAULT_TTL_MS,
      2000,
    );
  }

  async getMeta(type: MediaType, imdbId: string): Promise<CinemetaMeta | null> {
    const key = `${type}:${imdbId}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const meta = await this.fetchMeta(type, imdbId);
    if (meta) this.cache.set(key, meta);
    return meta;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private async fetchMeta(type: MediaType, imdbId: string): Promise<CinemetaMeta | null> {
    const url = `${this.baseUrl}/meta/${type}/${encodeURIComponent(imdbId)}.json`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      timer.unref?.();
      try {
        const response = await withTimeout(
          Promise.resolve().then(() =>
            this.fetchImpl(url, {
              signal: controller.signal,
              headers: { accept: "application/json" },
            }),
          ),
          this.timeoutMs,
          "cinemeta request",
        );
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload: unknown = await withTimeout(
          response.json(),
          this.timeoutMs,
          "cinemeta parse",
        );
        const meta =
          payload && typeof payload === "object"
            ? (payload as Record<string, unknown>).meta
            : undefined;
        if (!isCinemetaMeta(meta)) {
          throw new Error("invalid meta payload");
        }
        return meta;
      } catch {
        if (attempt === 1) {
          this.logger.warn("cinemeta.fetch_failed", { imdbId, type });
        }
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }
}
