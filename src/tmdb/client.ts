import type {
  CinemetaEpisode,
  CinemetaMeta,
  LoggerLike,
  MediaType,
  TmdbApi,
} from "../types.js";
import { TtlCache } from "../util/cache.js";
import { withTimeout } from "../util/concurrency.js";
import { nativeFetch } from "../util/nativeFetch.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_LANGUAGE = "en-US";
const MAX_VIDEOS = 10_000;
const MAX_EPISODES_PER_SEASON = 1000;
const IMDB_ID = /^tt\d{7,10}$/;

export interface TmdbClientOptions {
  apiKey: string;
  baseUrl: string;
  logger: LoggerLike;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  ttlMs?: number;
  language?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function yearOf(value: unknown): string | null {
  const text = trimString(value);
  const match = /^(\d{4})/.exec(text);
  return match ? match[1]! : null;
}

function seasonVideos(value: unknown): CinemetaEpisode[] {
  if (!Array.isArray(value)) return [];
  const videos: CinemetaEpisode[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const season = Number(entry.season_number);
    const count = Number(entry.episode_count);
    if (!Number.isInteger(season) || season < 0) continue;
    if (!Number.isInteger(count) || count < 1) continue;
    const limit = Math.min(count, MAX_EPISODES_PER_SEASON);
    for (let episode = 1; episode <= limit && videos.length < MAX_VIDEOS; episode += 1) {
      videos.push({ season, episode });
    }
    if (videos.length >= MAX_VIDEOS) break;
  }
  return videos;
}

export class TmdbClient implements TmdbApi {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly language: string;
  private readonly logger: LoggerLike;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly metaCache: TtlCache<string, CinemetaMeta>;
  private readonly seasonCache: TtlCache<string, Map<number, string>>;

  constructor(options: TmdbClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.language = options.language ?? DEFAULT_LANGUAGE;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? nativeFetch;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.metaCache = new TtlCache<string, CinemetaMeta>(options.ttlMs ?? DEFAULT_TTL_MS, 2000);
    this.seasonCache = new TtlCache<string, Map<number, string>>(
      options.ttlMs ?? DEFAULT_TTL_MS,
      2000,
    );
  }

  async getMeta(
    type: MediaType,
    tmdbId: number,
    season?: number,
  ): Promise<CinemetaMeta | null> {
    const key = `${type}:${tmdbId}`;
    let meta: CinemetaMeta | null = this.metaCache.get(key) ?? null;
    if (!meta) {
      meta = await this.fetchMeta(type, tmdbId);
      if (meta) this.metaCache.set(key, meta);
    }
    if (!meta) return null;
    if (type !== "series" || season === undefined || !Number.isInteger(season) || season < 0) {
      return meta;
    }

    const names = await this.fetchSeasonNames(tmdbId, season);
    if (names.size === 0 || !meta.videos) return meta;
    return {
      ...meta,
      videos: meta.videos.map((video) =>
        video.season === season && names.has(video.episode)
          ? { ...video, name: names.get(video.episode)! }
          : video,
      ),
    };
  }

  clearCache(): void {
    this.metaCache.clear();
    this.seasonCache.clear();
  }

  private async fetchMeta(type: MediaType, tmdbId: number): Promise<CinemetaMeta | null> {
    const path = type === "movie" ? "movie" : "tv";
    const query = new URLSearchParams({
      api_key: this.apiKey,
      language: this.language,
    });
    if (type === "series") query.set("append_to_response", "external_ids");
    const payload = await this.fetchJson(`${this.baseUrl}/${path}/${tmdbId}?${query}`);
    if (!isRecord(payload)) return null;

    const name = trimString(type === "movie" ? payload.title : payload.name);
    if (!name) return null;
    const originalName = trimString(
      type === "movie" ? payload.original_title : payload.original_name,
    );
    const year = yearOf(type === "movie" ? payload.release_date : payload.first_air_date);
    const external = isRecord(payload.external_ids) ? payload.external_ids : null;
    const rawImdbId = trimString(
      type === "movie" ? payload.imdb_id : external?.imdb_id,
    );
    const imdbId = IMDB_ID.test(rawImdbId) ? rawImdbId : null;

    const meta: CinemetaMeta = {
      id: imdbId ?? `tmdb:${tmdbId}`,
      type,
      name,
      ...(originalName && originalName !== name ? { originalName } : {}),
      ...(year ? { year, releaseInfo: year } : {}),
    };
    if (type === "series") {
      const videos = seasonVideos(payload.seasons);
      if (videos.length > 0) meta.videos = videos;
    }
    return meta;
  }

  private async fetchSeasonNames(tmdbId: number, season: number): Promise<Map<number, string>> {
    const key = `${tmdbId}:${season}`;
    const cached = this.seasonCache.get(key);
    if (cached) return cached;

    const query = new URLSearchParams({
      api_key: this.apiKey,
      language: this.language,
    });
    const payload = await this.fetchJson(
      `${this.baseUrl}/tv/${tmdbId}/season/${season}?${query}`,
    );
    const names = new Map<number, string>();
    if (!isRecord(payload)) return names;
    if (Array.isArray(payload.episodes)) {
      for (const entry of payload.episodes) {
        if (!isRecord(entry)) continue;
        const episode = Number(entry.episode_number);
        const name = trimString(entry.name);
        if (Number.isInteger(episode) && episode >= 0 && name) {
          names.set(episode, name);
        }
      }
    }
    this.seasonCache.set(key, names);
    return names;
  }

  private async fetchJson(url: string): Promise<unknown> {
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
          "tmdb request",
        );
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload: unknown = await withTimeout(
          response.json(),
          this.timeoutMs,
          "tmdb parse",
        );
        return payload;
      } catch (error) {
        if (attempt === 1) {
          this.logger.warn("tmdb.fetch_failed", {
            error: error instanceof Error ? error.name : "UnknownError",
          });
        }
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }
}
