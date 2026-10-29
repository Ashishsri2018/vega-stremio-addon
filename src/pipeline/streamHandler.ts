import type { AppConfig } from "../config.js";
import type {
  CinemetaMeta,
  EpisodeLink,
  LinkListEntry,
  LoggerLike,
  MediaType,
  PipelineDeps,
  Post,
  ProviderBundle,
  ProviderMeta,
  ProviderSnapshot,
  ProviderStream,
  StreamHandlerApi,
  StreamRequest,
  StremioStream,
} from "../types.js";
import { TtlCache } from "../util/cache.js";
import {
  mapLimit,
  mapLimitSettled,
  TimeoutError,
  withTimeout,
} from "../util/concurrency.js";
import { extractYear, normalizeTitle, rankCandidates } from "./match.js";
import { isSeasonPack, matchesEpisode } from "./episodes.js";
import { mapProviderStreams, sortStreams } from "./mapStreams.js";

const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const MAPPING_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const BREAKER_WINDOW_MS = 10 * 60 * 1000;
const BREAKER_OPEN_MS = 10 * 60 * 1000;
const BREAKER_THRESHOLD = 3;
const MAX_CANDIDATES = 3;
const MAX_LINKS_PER_PROVIDER = 10;
const MAX_STREAMS_PER_PROVIDER = 20;
const MAX_STREAM_CALLS_PER_REQUEST = 40;
const MAX_TOTAL_STREAMS = 200;
const STREAM_CONCURRENCY_PER_PROVIDER = 3;
const SETTLE_TICK_MS = 250;

interface Candidate {
  post: Post;
  meta: ProviderMeta;
}

interface RequestInfo {
  request: StreamRequest;
  meta: CinemetaMeta | null;
  title: string;
  year: string | number | null;
  season: number;
  episode?: number;
  episodeName: string | null;
  variants: string[];
}

interface ResolvedLink {
  link: string;
  quality?: string;
  title?: string;
}

interface LinkResolution {
  links: ResolvedLink[];
  failed: boolean;
}

interface InternalContext {
  info: RequestInfo;
  deadlineAt: number;
  signal: AbortSignal;
  collected: StremioStream[];
  streamCallsLeft: number;
  stopped: boolean;
  deadlineHit: boolean;
  lastProgressAt: number;
  generation: number;
}

interface BreakerState {
  failures: number[];
  openUntil: number;
}

interface EpisodeJob {
  url: string;
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function readMetaField(meta: ProviderMeta, key: string): unknown {
  const value = (meta as Record<string, unknown>)[key];
  return value;
}

function parseRequest(value: unknown): StreamRequest | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Record<string, unknown>;
  if (request.type !== "movie" && request.type !== "series") return null;
  if (typeof request.imdbId !== "string" || !/^tt\d{7,10}$/.test(request.imdbId)) {
    return null;
  }

  if (request.type === "movie") {
    if (request.season !== undefined || request.episode !== undefined) return null;
    return { type: "movie", imdbId: request.imdbId };
  }

  if (
    typeof request.season !== "number" ||
    !Number.isInteger(request.season) ||
    request.season < 0 ||
    request.season > 1000
  ) {
    return null;
  }
  if (request.episode !== undefined) {
    if (
      typeof request.episode !== "number" ||
      !Number.isInteger(request.episode) ||
      request.episode < 0 ||
      request.episode > 10000
    ) {
      return null;
    }
  }

  return {
    type: "series",
    imdbId: request.imdbId,
    season: request.season,
    ...(request.episode !== undefined ? { episode: request.episode } : {}),
  };
}

function providerTypeMatches(value: unknown, type: MediaType): boolean {
  const normalized = trimString(value).toLowerCase();
  if (!normalized) return true;
  if (type === "movie") return normalized === "movie" || normalized === "film";
  return ["series", "show", "tv", "tvseries"].includes(normalized);
}

function strongTitleMatch(candidate: string, requested: string): boolean {
  if (candidate === requested) return true;
  if (candidate.startsWith(`${requested} `) || requested.startsWith(`${candidate} `)) {
    return true;
  }
  const a = new Set(candidate.split(" ").filter(Boolean));
  const b = new Set(requested.split(" ").filter(Boolean));
  if (a.size === 0 || b.size === 0) return false;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union > 0 && intersection / union >= 0.9;
}

function findEpisodeName(
  meta: CinemetaMeta | null,
  season: number,
  episode: number | undefined,
): string | null {
  if (!meta || episode === undefined || !Array.isArray(meta.videos)) return null;
  const video = meta.videos.find(
    (item) => Number(item.season) === season && Number(item.episode) === episode,
  );
  return trimString(video?.name) || trimString(video?.title) || null;
}

function extractMetaYear(meta: CinemetaMeta): string | number | null {
  const year = (meta as unknown as Record<string, unknown>).year;
  if (typeof year === "number" || typeof year === "string") return year;
  const releaseInfo = meta.releaseInfo;
  return typeof releaseInfo === "string" && releaseInfo ? releaseInfo : null;
}

function formatYearForQuery(year: string | number | null): string | null {
  if (year === null) return null;
  const text = String(year);
  const parsed = extractYear(text);
  return parsed !== null ? String(parsed) : text.trim() || null;
}

export class StreamPipeline implements StreamHandlerApi {
  private readonly config: AppConfig;
  private readonly logger: LoggerLike;
  private readonly registry: PipelineDeps["registry"];
  private readonly cinemeta: PipelineDeps["cinemeta"];

  private readonly searchCache = new TtlCache<string, Post[]>(SEARCH_CACHE_TTL_MS);
  private readonly mappingCache = new TtlCache<string, Candidate>(MAPPING_CACHE_TTL_MS);
  private readonly streamCache: TtlCache<string, StremioStream[]>;
  private readonly breakers = new Map<string, BreakerState>();
  private readonly unsubscribe: () => void;
  private disposed = false;
  private generation = 0;

  constructor(deps: PipelineDeps) {
    this.config = deps.config;
    this.logger = deps.logger;
    this.registry = deps.registry;
    this.cinemeta = deps.cinemeta;
    this.streamCache = new TtlCache<string, StremioStream[]>(
      deps.config.streamCacheTtlMs,
      500,
    );
    this.unsubscribe = deps.registry.onActivate(() => this.clearCaches());
  }

  async handle(request: StreamRequest, signal?: AbortSignal): Promise<StremioStream[]> {
    const parsed = parseRequest(request);
    if (!parsed || signal?.aborted) return [];

    const lease = this.registry.acquire();
    let deadlineTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    const controller = new AbortController();

    try {
      const snapshot = lease.snapshot;
      if (!snapshot || snapshot.bundles.size === 0) return [];

      const cacheKey = this.streamCacheKey(parsed);
      const cached = this.streamCache.get(cacheKey);
      if (cached) return cached.slice();

      const startedAt = Date.now();
      const deadlineAt = startedAt + Math.max(1, this.config.globalDeadlineMs);
      const info = await this.resolveInfo(parsed, controller, deadlineAt, signal);
      if (!info) return [];

      const combinedSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      const ctx: InternalContext = {
        info,
        deadlineAt,
        signal: combinedSignal,
        collected: [],
        streamCallsLeft: MAX_STREAM_CALLS_PER_REQUEST,
        stopped: false,
        deadlineHit: false,
        lastProgressAt: startedAt,
        generation: this.generation,
      };

      let resolveEarly: ((streams: StremioStream[]) => void) | undefined;
      const earlyPromise = new Promise<StremioStream[]>((resolve) => {
        resolveEarly = resolve;
      });
      const finishEarly = (): void => {
        resolveEarly?.(this.finalize(ctx.collected));
      };
      deadlineTimer = setTimeout(() => {
        if (ctx.stopped) return;
        ctx.stopped = true;
        ctx.deadlineHit = true;
        controller.abort(new TimeoutError("global deadline reached"));
        finishEarly();
      }, Math.max(1, deadlineAt - Date.now()));
      deadlineTimer.unref?.();
      settleTimer = this.startSettleTimer(ctx, startedAt, controller, finishEarly);

      const abortPromise = new Promise<StremioStream[]>((resolve) => {
        if (!signal) return;
        abortHandler = () => {
          if (ctx.stopped) return;
          ctx.stopped = true;
          controller.abort(new Error("request aborted"));
          resolve(this.finalize(ctx.collected));
        };
        signal.addEventListener("abort", abortHandler, { once: true });
      });

      const work = this.runRequest(ctx, snapshot)
        .then(() => this.finalize(ctx.collected))
        .catch(() => this.finalize(ctx.collected))
        .finally(() => {
          if (ctx.stopped) {
            this.logger.debug("pipeline.late_finish", {
              imdbId: parsed.imdbId,
              type: parsed.type,
              durationMs: Date.now() - startedAt,
            });
          }
        });

      const result = await Promise.race([work, earlyPromise, abortPromise]);

      if (
        !ctx.stopped &&
        !signal?.aborted &&
        this.generation === ctx.generation &&
        result.length > 0
      ) {
        this.streamCache.set(cacheKey, result.slice());
      }

      return result;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (settleTimer) clearInterval(settleTimer);
      if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
      lease.release();
    }
  }

  clearCaches(): void {
    this.generation += 1;
    this.searchCache.clear();
    this.mappingCache.clear();
    this.streamCache.clear();
    this.breakers.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.clearCaches();
  }

  private streamCacheKey(request: StreamRequest): string {
    return `${request.type}|${request.imdbId}|${request.season ?? ""}|${request.episode ?? ""}`;
  }

  private startSettleTimer(
    ctx: InternalContext,
    startedAt: number,
    controller: AbortController,
    finishEarly: () => void,
  ): NodeJS.Timeout | undefined {
    const settleMs = Math.max(0, this.config.settleMs);
    const emptyFenceMs = Math.max(0, this.config.emptyFenceMs);
    if (settleMs === 0 && emptyFenceMs === 0) return undefined;

    const timer = setInterval(() => {
      if (ctx.stopped) return;
      const now = Date.now();
      const empty = ctx.collected.length === 0;
      const fenceHit = empty && emptyFenceMs > 0 && now - startedAt >= emptyFenceMs;
      const settled = !empty && settleMs > 0 && now - ctx.lastProgressAt >= settleMs;
      if (!fenceHit && !settled) return;
      ctx.stopped = true;
      controller.abort(
        new TimeoutError(settled ? "streams settled" : "empty result fence"),
      );
      finishEarly();
    }, SETTLE_TICK_MS);
    timer.unref?.();
    return timer;
  }

  private async resolveInfo(
    request: StreamRequest,
    controller: AbortController,
    deadlineAt: number,
    callerSignal?: AbortSignal,
  ): Promise<RequestInfo | null> {
    let meta: CinemetaMeta | null = null;
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    const timeoutMs = Math.max(1, deadlineAt - Date.now());

    try {
      const metaPromise = withTimeout(
        Promise.resolve().then(() => this.cinemeta.getMeta(request.type, request.imdbId)),
        timeoutMs,
        "cinemeta",
      );
      if (callerSignal) {
        const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
          if (callerSignal.aborted) {
            resolve({ kind: "aborted" });
            return;
          }
          callerSignal.addEventListener("abort", () => resolve({ kind: "aborted" }), {
            once: true,
          });
        });
        const outcome = await Promise.race([
          metaPromise.then((value) => ({ kind: "meta" as const, value })),
          aborted,
        ]);
        if (outcome.kind === "aborted") return null;
        meta = outcome.value;
      } else {
        meta = await metaPromise;
      }
    } catch (error) {
      if (!callerSignal?.aborted) {
        this.logger.debug("pipeline.cinemeta_failed", {
          imdbId: request.imdbId,
          type: request.type,
          error: errorName(error),
        });
      }
    }

    if (signal.aborted) return null;

    const title = trimString(meta?.name);
    const year = meta ? extractMetaYear(meta) : null;
    const variants: string[] = [];
    const seen = new Set<string>();
    const addVariant = (value: string): void => {
      const query = value.trim();
      if (!query || seen.has(query)) return;
      seen.add(query);
      variants.push(query);
    };

    if (meta && title) {
      addVariant(title);
      const yearText = formatYearForQuery(year);
      if (yearText) addVariant(`${title} ${yearText}`);
      addVariant(`${title} ${request.type}`);
    } else {
      addVariant(request.imdbId);
    }

    if (request.type === "series") {
      return {
        request,
        meta,
        title,
        year,
        season: request.season ?? 0,
        ...(request.episode !== undefined ? { episode: request.episode } : {}),
        episodeName: findEpisodeName(meta, request.season ?? 0, request.episode),
        variants,
      };
    }

    return { request, meta, title, year, season: 0, episodeName: null, variants };
  }

  private async runRequest(ctx: InternalContext, snapshot: ProviderSnapshot): Promise<void> {
    const bundles = Array.from(snapshot.bundles.values());
    await mapLimitSettled(bundles, this.config.searchConcurrency, async (bundle) => {
      if (ctx.stopped) return;
      await this.runProvider(bundle, ctx);
    });
  }

  private async runProvider(bundle: ProviderBundle, ctx: InternalContext): Promise<void> {
    const providerValue = trimString(bundle.entry.value);
    if (!providerValue || ctx.stopped) return;
    if (this.isCircuitOpen(providerValue)) {
      this.logger.debug("pipeline.provider_circuit_open", { provider: providerValue });
      return;
    }

    const posts = await this.searchProvider(bundle, ctx);
    if (ctx.stopped || posts.length === 0) return;

    const ranked = rankCandidates(
      posts,
      { title: ctx.info.title, year: ctx.info.year, type: ctx.info.request.type },
      MAX_CANDIDATES,
    );
    if (ranked.length === 0) return;

    const mapping = await this.resolveCandidate(bundle, ranked, ctx);
    if (ctx.stopped) return;
    if (!mapping.candidate) {
      if (mapping.failed) this.recordFailure(providerValue, ctx.generation);
      return;
    }

    const links = await this.resolveLinks(bundle, mapping.candidate, ctx);
    if (ctx.stopped) return;
    if (links.failed && links.links.length === 0) {
      this.recordFailure(providerValue, ctx.generation);
      return;
    }
    if (links.links.length === 0) return;

    const streams = await this.fetchStreams(bundle, links.links, ctx);
    if (ctx.stopped) return;
    if (streams.attempted > 0 && streams.streams.length === 0) {
      this.recordFailure(providerValue, ctx.generation);
      this.logger.warn("pipeline.provider_no_streams", {
        provider: providerValue,
        stage: "stream",
        imdbId: ctx.info.request.imdbId,
      });
      return;
    }
    if (streams.streams.length === 0) return;

    const mapped = mapProviderStreams(streams.streams, {
      providerValue,
      providerName: trimString(bundle.entry.display_name) || providerValue,
      includeMagnets: this.config.includeMagnets,
      perProviderLimit: MAX_STREAMS_PER_PROVIDER,
    });
    if (ctx.stopped || mapped.length === 0) return;
    ctx.collected.push(...mapped);
    ctx.lastProgressAt = Date.now();
  }

  private async searchProvider(bundle: ProviderBundle, ctx: InternalContext): Promise<Post[]> {
    const providerValue = trimString(bundle.entry.value);
    const deadlineAt = Math.min(
      Date.now() + Math.max(1, this.config.searchTimeoutMs),
      ctx.deadlineAt,
    );

    for (const query of ctx.info.variants) {
      if (ctx.stopped) return [];
      const cacheKey = `${providerValue}|${query}|${ctx.info.request.type}`;
      const cached = this.searchCache.get(cacheKey);
      if (cached !== undefined) {
        if (cached.length > 0) return cached;
        continue;
      }

      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        if (!ctx.stopped) this.recordFailure(providerValue, ctx.generation);
        return [];
      }

      try {
        const raw = await this.invoke("search", Math.min(remaining, this.config.searchTimeoutMs), ctx, (signal) =>
          bundle.modules.posts.getSearchPosts({
            searchQuery: query,
            page: 1,
            providerValue,
            signal,
            providerContext: this.registry.context,
          }),
        );
        const posts = Array.isArray(raw)
          ? raw.filter(
              (post) =>
                post &&
                typeof post === "object" &&
                typeof post.title === "string" &&
                typeof post.link === "string" &&
                post.link.trim().length > 0,
            )
          : [];
        if (!ctx.stopped && this.generation === ctx.generation) {
          this.searchCache.set(cacheKey, posts);
        }
        if (posts.length > 0) return posts;
      } catch (error) {
        if (!ctx.stopped) {
          this.recordFailure(providerValue, ctx.generation);
          this.logger.warn("pipeline.provider_failed", {
            provider: providerValue,
            stage: "search",
            error: errorName(error),
          });
        }
        return [];
      }
    }

    return [];
  }

  private async resolveCandidate(
    bundle: ProviderBundle,
    ranked: Array<{ post: Post; score: number }>,
    ctx: InternalContext,
  ): Promise<{ candidate: Candidate | null; failed: boolean }> {
    const providerValue = trimString(bundle.entry.value);
    const cacheKey = `${providerValue}|${ctx.info.request.imdbId}|${ctx.info.request.type}`;
    const cached = this.mappingCache.get(cacheKey);
    if (cached) return { candidate: cached, failed: false };

    let failed = false;
    for (const entry of ranked.slice(0, MAX_CANDIDATES)) {
      if (ctx.stopped) break;
      try {
        const meta = await this.invoke("meta", this.config.metaTimeoutMs, ctx, () =>
          bundle.modules.meta.getMeta({
            link: entry.post.link,
            providerContext: this.registry.context,
          }),
        );
        if (this.metaMatches(meta, ctx.info)) {
          const candidate: Candidate = { post: entry.post, meta };
          if (!ctx.stopped && this.generation === ctx.generation) {
            this.mappingCache.set(cacheKey, candidate);
          }
          return { candidate, failed: false };
        }
      } catch (error) {
        failed = true;
        if (!ctx.stopped) {
          this.logger.debug("pipeline.provider_meta_failed", {
            provider: providerValue,
            stage: "meta",
            error: errorName(error),
          });
        }
      }
    }

    return { candidate: null, failed };
  }

  private metaMatches(meta: ProviderMeta, info: RequestInfo): boolean {
    if (!meta || typeof meta !== "object") return false;

    const metaImdbId = trimString(meta.imdbId);
    if (metaImdbId) {
      return metaImdbId.toLowerCase() === info.request.imdbId.toLowerCase();
    }

    if (!providerTypeMatches(meta.type, info.request.type)) return false;

    const metaTitle = normalizeTitle(trimString(meta.title));
    const requestedTitle = normalizeTitle(info.title);
    if (!metaTitle || !requestedTitle || !strongTitleMatch(metaTitle, requestedTitle)) {
      return false;
    }

    const metaYearText = readMetaField(meta, "year") ?? meta.releaseInfo;
    const metaYear = extractYear(String(metaYearText ?? ""));
    const requestedYear = extractYear(String(info.year ?? ""));
    if (metaYear !== null && requestedYear !== null && metaYear !== requestedYear) {
      return false;
    }

    return true;
  }

  private async resolveLinks(
    bundle: ProviderBundle,
    candidate: Candidate,
    ctx: InternalContext,
  ): Promise<LinkResolution> {
    if (ctx.info.request.type === "movie") {
      return this.resolveMovieLinks(candidate.meta);
    }
    return this.resolveSeriesLinks(bundle, candidate.meta, ctx);
  }

  private resolveMovieLinks(meta: ProviderMeta): LinkResolution {
    const links: ResolvedLink[] = [];
    const seen = new Set<string>();
    const entries = Array.isArray(meta.linkList) ? meta.linkList : [];

    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      for (const direct of Array.isArray(entry.directLinks) ? entry.directLinks : []) {
        const link = trimString(direct.link);
        if (!link) continue;
        const type = trimString(direct.type).toLowerCase();
        if (type && type !== "movie") continue;
        if (seen.has(link)) continue;
        seen.add(link);
        links.push({
          link,
          quality: trimString(entry.quality) || undefined,
          title: trimString(direct.title) || undefined,
        });
      }
    }

    return {
      links: links.slice(0, MAX_LINKS_PER_PROVIDER),
      failed: false,
    };
  }

  private async resolveSeriesLinks(
    bundle: ProviderBundle,
    meta: ProviderMeta,
    ctx: InternalContext,
  ): Promise<LinkResolution> {
    const { season, episode, episodeName } = ctx.info;
    const entries = Array.isArray(meta.linkList) ? meta.linkList : [];
    const specific: ResolvedLink[] = [];
    const pack: ResolvedLink[] = [];
    const jobs: EpisodeJob[] = [];
    const jobUrls = new Set<string>();
    const seenSpecific = new Set<string>();
    const seenPack = new Set<string>();
    let hadError = false;

    const pushDirect = (
      target: ResolvedLink[],
      seen: Set<string>,
      entry: LinkListEntry,
    ): void => {
      for (const direct of Array.isArray(entry.directLinks) ? entry.directLinks : []) {
        const link = trimString(direct.link);
        if (!link || seen.has(link)) continue;
        const type = trimString(direct.type).toLowerCase();
        if (type && !["series", "episode", "tv", "show"].includes(type)) continue;
        seen.add(link);
        target.push({
          link,
          quality: trimString(entry.quality) || undefined,
          title: trimString(direct.title) || undefined,
        });
      }
    };

    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const title = trimString(entry.title);
      const unknownTitle = title.length === 0;
      const specificMatch = unknownTitle
        ? episode === undefined
        : matchesEpisode(title, season, episode, episodeName);
      const packMatch = unknownTitle || isSeasonPack(title, season);

      if (specificMatch) pushDirect(specific, seenSpecific, entry);
      else if (packMatch) pushDirect(pack, seenPack, entry);

      const episodesLink = trimString(entry.episodesLink);
      if (
        episodesLink &&
        bundle.modules.episodes &&
        !ctx.stopped &&
        !jobUrls.has(episodesLink) &&
        (specificMatch || packMatch || episode === undefined)
      ) {
        jobUrls.add(episodesLink);
        jobs.push({ url: episodesLink });
      }
    }

    const episodes: EpisodeLink[] = [];
    for (const job of jobs) {
      if (ctx.stopped) break;
      try {
        const raw = await this.invoke("episodes", this.config.metaTimeoutMs, ctx, () =>
          bundle.modules.episodes!.getEpisodes({
            url: job.url,
            providerContext: this.registry.context,
          }),
        );
        if (Array.isArray(raw)) {
          for (const item of raw) {
            if (
              item &&
              typeof item === "object" &&
              typeof item.title === "string" &&
              typeof item.link === "string" &&
              item.link.trim()
            ) {
              episodes.push(item);
            }
          }
        }
      } catch (error) {
        hadError = true;
        if (!ctx.stopped) {
          this.logger.debug("pipeline.provider_episodes_failed", {
            provider: trimString(bundle.entry.value),
            stage: "episodes",
            error: errorName(error),
          });
        }
      }
    }

    for (const item of episodes) {
      if (matchesEpisode(item.title, season, episode, episodeName)) {
        const link = trimString(item.link);
        if (link && !seenSpecific.has(link)) {
          seenSpecific.add(link);
          specific.push({ link, title: trimString(item.title) || undefined });
        }
      }
    }

    let links = specific;
    if (episode === undefined) {
      const combined = [...specific];
      const seen = new Set(combined.map((entry) => entry.link));
      for (const entry of pack) {
        if (seen.has(entry.link)) continue;
        seen.add(entry.link);
        combined.push(entry);
      }
      links = combined;
    } else if (specific.length === 0) {
      links = pack;
    }

    return {
      links: links.slice(0, MAX_LINKS_PER_PROVIDER),
      failed: hadError,
    };
  }

  private async fetchStreams(
    bundle: ProviderBundle,
    links: ResolvedLink[],
    ctx: InternalContext,
  ): Promise<{ streams: ProviderStream[]; attempted: number }> {
    let attempted = 0;
    const providerValue = trimString(bundle.entry.value);

    const results = await mapLimit(
      links,
      STREAM_CONCURRENCY_PER_PROVIDER,
      async (item): Promise<ProviderStream[]> => {
        if (ctx.stopped || ctx.streamCallsLeft <= 0) return [];
        ctx.streamCallsLeft -= 1;
        attempted += 1;
        try {
          const raw = await this.invoke("stream", this.config.streamTimeoutMs, ctx, (signal) =>
            bundle.modules.stream.getStream({
              link: item.link,
              type: ctx.info.request.type,
              signal,
              providerContext: this.registry.context,
              isDownload: false,
            }),
          );
          if (!Array.isArray(raw)) return [];
          return raw
            .filter(
              (stream) =>
                stream &&
                typeof stream === "object" &&
                typeof stream.link === "string" &&
                stream.link.trim().length > 0,
            )
            .map((stream) => ({
              ...stream,
              quality: trimString(stream.quality) || item.quality,
            }));
        } catch (error) {
          if (!ctx.stopped) {
            this.logger.debug("pipeline.provider_stream_failed", {
              provider: providerValue,
              stage: "stream",
              error: errorName(error),
            });
          }
          return [];
        }
      },
    );

    return {
      streams: results.flat(),
      attempted,
    };
  }

  private async invoke<T>(
    label: string,
    budgetMs: number,
    ctx: InternalContext,
    fn: (signal: AbortSignal) => Promise<T> | T,
  ): Promise<T> {
    if (ctx.stopped || ctx.signal.aborted) {
      throw new TimeoutError(`${label} aborted`);
    }
    const remaining = ctx.deadlineAt - Date.now();
    const timeoutMs = Math.max(1, Math.min(budgetMs, remaining));
    const controller = new AbortController();
    const signal = AbortSignal.any([ctx.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(new TimeoutError(`${label} timed out`)), timeoutMs);
    timer.unref?.();

    try {
      return await withTimeout(
        Promise.resolve().then(() => fn(signal)),
        timeoutMs,
        label,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private isCircuitOpen(providerValue: string): boolean {
    const state = this.breakers.get(providerValue);
    if (!state) return false;
    const now = Date.now();
    if (state.openUntil > now) return true;
    if (state.openUntil !== 0) {
      state.openUntil = 0;
      state.failures = [];
    }
    return false;
  }

  private recordFailure(providerValue: string, generation?: number): void {
    if (generation !== undefined && generation !== this.generation) return;
    const now = Date.now();
    const state = this.breakers.get(providerValue) ?? { failures: [], openUntil: 0 };
    state.failures = state.failures.filter((timestamp) => now - timestamp < BREAKER_WINDOW_MS);

    if (state.openUntil > now) {
      this.breakers.set(providerValue, state);
      return;
    }

    state.failures.push(now);
    if (state.failures.length >= BREAKER_THRESHOLD) {
      state.openUntil = now + BREAKER_OPEN_MS;
      state.failures = [];
      this.logger.warn("pipeline.provider_circuit_opened", {
        provider: providerValue,
        failures: BREAKER_THRESHOLD,
      });
    }
    this.breakers.set(providerValue, state);
  }

  private finalize(streams: StremioStream[]): StremioStream[] {
    return sortStreams(streams).slice(0, MAX_TOTAL_STREAMS);
  }
}
