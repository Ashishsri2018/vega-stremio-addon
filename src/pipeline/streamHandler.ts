import type { AppConfig } from "../config.js";
import type {
  CinemetaMeta,
  EpisodeLink,
  LinkListEntry,
  LoggerLike,
  MediaType,
  PipelineDeps,
  PipelineMetrics,
  Post,
  ProviderBundle,
  ProviderMeta,
  ProviderSnapshot,
  ProviderStream,
  StreamHandlerApi,
  StreamRequest,
  StremioStream,
  StremioSubtitle,
} from "../types.js";
import { contentIdOf, requestLogFields } from "../addon/parseId.js";
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

const MAX_SEARCH_VARIANTS = 6;
const BREAKER_WINDOW_MS = 10 * 60 * 1000;
const BREAKER_OPEN_MS = 10 * 60 * 1000;
const BREAKER_THRESHOLD = 3;
const MAX_CANDIDATES = 3;
const MAX_LINKS_PER_PROVIDER = 100;
const MAX_STREAMS_PER_PROVIDER = 100;
const MAX_STREAM_CALLS_PER_REQUEST = 120;
const MAX_TOTAL_STREAMS = 1000;
const STREAM_CONCURRENCY_PER_PROVIDER = 3;
const SETTLE_TICK_MS = 250;
const DEFAULT_PROVIDER_SCORE = 15_000;
const FAILURE_PENALTY_MS = 30_000;

interface Candidate {
  post: Post;
  meta: ProviderMeta;
}

interface RequestInfo {
  request: StreamRequest;
  contentId: string;
  imdbId: string | null;
  meta: CinemetaMeta | null;
  title: string;
  year: string | number | null;
  season: number;
  episode?: number;
  absoluteEpisode: number | null;
  episodeName: string | null;
  variants: string[];
  providers: Set<string> | null;
  disabledProviders: Set<string>;
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
  truncated: boolean;
  deadlineHit: boolean;
  lastProgressAt: number;
  generation: number;
}

interface BreakerState {
  failures: number[];
  openUntil: number;
}

interface ProviderStat {
  avgLatencyMs: number;
  failures: number;
}

interface InFlightRequest {
  promise: Promise<StremioStream[]>;
  controller: AbortController;
  waiters: number;
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

function parseProviderList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const provider = item.trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(provider)) continue;
    if (!result.some((existing) => existing.toLowerCase() === provider.toLowerCase())) {
      result.push(provider);
    }
    if (result.length >= 50) break;
  }
  return result.length > 0 ? result : undefined;
}

function parseRequest(value: unknown): StreamRequest | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Record<string, unknown>;
  if (request.type !== "movie" && request.type !== "series") return null;

  const imdbId = typeof request.imdbId === "string" ? request.imdbId : null;
  const tmdbId =
    typeof request.tmdbId === "number" &&
    Number.isSafeInteger(request.tmdbId) &&
    request.tmdbId > 0
      ? request.tmdbId
      : null;
  if ((imdbId === null) === (tmdbId === null)) return null;
  if (imdbId !== null && !/^tt\d{7,10}$/.test(imdbId)) return null;

  const providers = parseProviderList(request.providers);
  const disabledProviders = parseProviderList(request.disabledProviders);

  if (request.type === "movie") {
    if (request.season !== undefined || request.episode !== undefined) return null;
    return {
      type: "movie",
      ...(imdbId !== null ? { imdbId } : { tmdbId: tmdbId! }),
      ...(providers ? { providers } : {}),
      ...(disabledProviders ? { disabledProviders } : {}),
    };
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
    ...(imdbId !== null ? { imdbId } : { tmdbId: tmdbId! }),
    season: request.season,
    ...(request.episode !== undefined ? { episode: request.episode } : {}),
    ...(providers ? { providers } : {}),
    ...(disabledProviders ? { disabledProviders } : {}),
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

function computeAbsoluteEpisode(
  meta: CinemetaMeta | null,
  season: number,
  episode: number | undefined,
): number | null {
  if (!meta || episode === undefined || season <= 0 || !Array.isArray(meta.videos)) {
    return null;
  }
  const maxBySeason = new Map<number, number>();
  for (const video of meta.videos) {
    const videoSeason = Number(video.season);
    const videoEpisode = Number(video.episode);
    if (!Number.isInteger(videoSeason) || !Number.isInteger(videoEpisode)) continue;
    if (videoSeason < 1 || videoEpisode < 1) continue;
    maxBySeason.set(videoSeason, Math.max(maxBySeason.get(videoSeason) ?? 0, videoEpisode));
  }
  if (!maxBySeason.has(season) || maxBySeason.size < 2) return null;

  let previous = 0;
  for (let index = 1; index < season; index += 1) {
    previous += maxBySeason.get(index) ?? 0;
  }
  return previous + episode;
}

function stripLeadingArticle(title: string): string {
  return title.replace(/^(?:the|a|an)\s+/i, "").trim();
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
  private readonly tmdb: PipelineDeps["tmdb"];
  private readonly disabledProviders: Set<string>;

  private readonly searchCache: TtlCache<string, Post[]>;
  private readonly mappingCache: TtlCache<string, Candidate>;
  private readonly streamCache: TtlCache<string, StremioStream[]>;
  private readonly breakers = new Map<string, BreakerState>();
  private readonly providerStats = new Map<string, ProviderStat>();
  private readonly inFlight = new Map<string, InFlightRequest>();
  private readonly metrics = {
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    emptyResults: 0,
    deadlineHits: 0,
    settleHits: 0,
    providerFailures: 0,
  };
  private readonly unsubscribe: () => void;
  private disposed = false;
  private generation = 0;

  constructor(deps: PipelineDeps) {
    this.config = deps.config;
    this.logger = deps.logger;
    this.registry = deps.registry;
    this.cinemeta = deps.cinemeta;
    this.tmdb = deps.tmdb ?? null;
    this.disabledProviders = new Set(
      deps.config.disabledProviders.map((value) => value.toLowerCase()),
    );
    this.searchCache = new TtlCache<string, Post[]>(
      deps.config.providerCacheTtlMs,
    );
    this.mappingCache = new TtlCache<string, Candidate>(
      deps.config.providerCacheTtlMs,
    );
    this.streamCache = new TtlCache<string, StremioStream[]>(
      deps.config.streamCacheTtlMs,
      500,
    );
    this.unsubscribe = deps.registry.onActivate(() => this.clearCaches());
  }

  getMetrics(): PipelineMetrics {
    const now = Date.now();
    const breakers: Record<string, "open" | "closed"> = {};
    for (const [provider, state] of this.breakers) {
      breakers[provider] = state.openUntil > now ? "open" : "closed";
    }
    return {
      ...this.metrics,
      cacheEntries: {
        search: this.searchCache.size,
        mapping: this.mappingCache.size,
        stream: this.streamCache.size,
      },
      breakers,
    };
  }

  async handle(request: StreamRequest, signal?: AbortSignal): Promise<StremioStream[]> {
    const parsed = parseRequest(request);
    if (!parsed || signal?.aborted) return [];

    this.metrics.requests += 1;
    const cacheKey = this.streamCacheKey(parsed);
    const cached = this.streamCache.get(cacheKey);
    if (cached !== undefined) {
      this.metrics.cacheHits += 1;
      return cached.slice();
    }
    this.metrics.cacheMisses += 1;

    let entry = this.inFlight.get(cacheKey);
    if (!entry) {
      const controller = new AbortController();
      const lease = this.registry.acquire();
      const created: InFlightRequest = {
        controller,
        waiters: 0,
        promise: Promise.resolve([]),
      };
      created.promise = this.execute(parsed, cacheKey, controller.signal, lease).finally(
        () => {
          if (this.inFlight.get(cacheKey) === created) this.inFlight.delete(cacheKey);
          lease.release();
        },
      );
      this.inFlight.set(cacheKey, created);
      entry = created;
    }

    entry.waiters += 1;
    try {
      return await this.awaitShared(entry.promise, signal);
    } finally {
      entry.waiters -= 1;
      if (entry.waiters <= 0) {
        entry.controller.abort(new Error("all callers aborted"));
      }
    }
  }

  async collectSubtitles(
    request: StreamRequest,
    signal?: AbortSignal,
  ): Promise<StremioSubtitle[]> {
    const streams = await this.handle(request, signal);
    const seenUrls = new Set<string>();
    const subtitles: StremioSubtitle[] = [];
    for (const stream of streams) {
      for (const track of stream.subtitles ?? []) {
        if (seenUrls.has(track.url)) continue;
        seenUrls.add(track.url);
        subtitles.push(track);
      }
    }
    return subtitles;
  }

  private awaitShared(
    promise: Promise<StremioStream[]>,
    signal?: AbortSignal,
  ): Promise<StremioStream[]> {
    if (!signal) return promise.then((streams) => streams.slice());
    if (signal.aborted) return Promise.resolve([]);

    return new Promise<StremioStream[]>((resolve, reject) => {
      const onAbort = (): void => resolve([]);
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (streams) => {
          signal.removeEventListener("abort", onAbort);
          resolve(streams.slice());
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  private async execute(
    parsed: StreamRequest,
    cacheKey: string,
    workSignal: AbortSignal,
    lease: ReturnType<PipelineDeps["registry"]["acquire"]>,
  ): Promise<StremioStream[]> {
    let deadlineTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    const controller = new AbortController();

    try {
      const snapshot = lease.snapshot;
      if (!snapshot || snapshot.bundles.size === 0) return [];

      const startedAt = Date.now();
      const deadlineAt = startedAt + Math.max(1, this.config.globalDeadlineMs);
      const info = await this.resolveInfo(parsed, controller, deadlineAt, workSignal);
      if (!info) return [];

      const combinedSignal = AbortSignal.any([workSignal, controller.signal]);
      const ctx: InternalContext = {
        info,
        deadlineAt,
        signal: combinedSignal,
        collected: [],
        streamCallsLeft: MAX_STREAM_CALLS_PER_REQUEST,
        stopped: false,
        truncated: false,
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
        ctx.truncated = true;
        ctx.deadlineHit = true;
        this.metrics.deadlineHits += 1;
        controller.abort(new TimeoutError("global deadline reached"));
        finishEarly();
      }, Math.max(1, deadlineAt - Date.now()));
      deadlineTimer.unref?.();
      settleTimer = this.startSettleTimer(ctx, startedAt, controller, finishEarly);

      const abortPromise = new Promise<StremioStream[]>((resolve) => {
        if (workSignal.aborted) {
          resolve(this.finalize(ctx.collected));
          return;
        }
        abortHandler = () => {
          if (ctx.stopped) return;
          ctx.stopped = true;
          controller.abort(new Error("request aborted"));
          resolve(this.finalize(ctx.collected));
        };
        workSignal.addEventListener("abort", abortHandler, { once: true });
      });

      const work = this.runRequest(ctx, snapshot)
        .then(() => this.finalize(ctx.collected))
        .catch(() => this.finalize(ctx.collected))
        .finally(() => {
          if (ctx.stopped) {
            this.logger.debug("pipeline.late_finish", {
              ...requestLogFields(parsed),
              type: parsed.type,
              durationMs: Date.now() - startedAt,
            });
          }
        });

      const result = await Promise.race([work, earlyPromise, abortPromise]);

      if (!workSignal.aborted && this.generation === ctx.generation) {
        const partial = ctx.truncated || result.length === 0;
        const ttl = partial
          ? Math.min(this.config.streamPartialCacheTtlMs, this.config.streamCacheTtlMs)
          : this.config.streamCacheTtlMs;
        this.streamCache.set(cacheKey, result.slice(), ttl);
      }
      if (result.length === 0) this.metrics.emptyResults += 1;

      return result;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (settleTimer) clearInterval(settleTimer);
      if (abortHandler) workSignal.removeEventListener("abort", abortHandler);
    }
  }

  clearCaches(): void {
    this.generation += 1;
    this.searchCache.clear();
    this.mappingCache.clear();
    this.streamCache.clear();
    this.breakers.clear();
    this.providerStats.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.clearCaches();
    for (const entry of this.inFlight.values()) {
      entry.controller.abort(new Error("pipeline disposed"));
    }
    this.inFlight.clear();
  }

  private streamCacheKey(request: StreamRequest): string {
    const providers = request.providers
      ? request.providers.map((value) => value.toLowerCase()).sort().join(",")
      : "";
    const disabled = request.disabledProviders
      ? request.disabledProviders.map((value) => value.toLowerCase()).sort().join(",")
      : "";
    return `${request.type}|${contentIdOf(request)}|${request.season ?? ""}|${request.episode ?? ""}|${providers}|${disabled}`;
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
      ctx.truncated = true;
      if (settled) this.metrics.settleHits += 1;
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
    const contentId = contentIdOf(request);
    let meta: CinemetaMeta | null = null;
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    const timeoutMs = Math.max(1, deadlineAt - Date.now());

    try {
      const loadMeta = (): Promise<CinemetaMeta | null> => {
        if ("imdbId" in request) {
          return this.cinemeta.getMeta(request.type, request.imdbId);
        }
        if (!this.tmdb) return Promise.resolve(null);
        return this.tmdb.getMeta(
          request.type,
          request.tmdbId,
          request.type === "series" ? request.season : undefined,
        );
      };
      const metaPromise = withTimeout(
        Promise.resolve().then(loadMeta),
        timeoutMs,
        "metadata",
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
        this.logger.debug("pipeline.metadata_failed", {
          contentId,
          type: request.type,
          error: errorName(error),
        });
      }
    }

    if (signal.aborted) return null;

    if (!("imdbId" in request) && !meta) {
      this.logger.debug("pipeline.tmdb_meta_missing", {
        contentId,
        type: request.type,
        configured: Boolean(this.tmdb),
      });
      return null;
    }

    const metaImdbId = trimString(meta?.id);
    const resolvedImdbId =
      "imdbId" in request
        ? request.imdbId
        : /^tt\d{7,10}$/.test(metaImdbId)
          ? metaImdbId
          : null;

    const title = trimString(meta?.name);
    const year = meta ? extractMetaYear(meta) : null;
    const variants: string[] = [];
    const seen = new Set<string>();
    const addVariant = (value: string): void => {
      if (variants.length >= MAX_SEARCH_VARIANTS) return;
      const query = value.trim();
      if (!query || seen.has(query)) return;
      seen.add(query);
      variants.push(query);
    };

    const baseTitles: string[] = [];
    if (meta && title) baseTitles.push(title);
    const originalName = trimString(meta?.originalName);
    if (
      originalName &&
      !baseTitles.some((value) => value.toLowerCase() === originalName.toLowerCase())
    ) {
      baseTitles.push(originalName);
    }
    if (baseTitles.length === 0) addVariant(resolvedImdbId ?? contentId);

    const season = request.type === "series" ? request.season ?? 0 : 0;
    const yearText = formatYearForQuery(year);

    for (const base of baseTitles) addVariant(base);
    if (yearText) {
      for (const base of baseTitles) addVariant(`${base} ${yearText}`);
    }
    for (const base of baseTitles) addVariant(`${base} ${request.type}`);
    if (request.type === "series" && season > 0) {
      addVariant(`${title} S${String(season).padStart(2, "0")}`);
      addVariant(`${title} season ${season}`);
    }
    for (const base of baseTitles) {
      const stripped = stripLeadingArticle(base);
      if (stripped && stripped !== base) addVariant(stripped);
    }

    const providers = request.providers
      ? new Set(request.providers.map((value) => value.toLowerCase()))
      : null;
    const disabledProviders = new Set(
      (request.disabledProviders ?? []).map((value) => value.toLowerCase()),
    );
    const absoluteEpisode = computeAbsoluteEpisode(meta, season, request.episode);

    if (request.type === "series") {
      return {
        request,
        contentId,
        imdbId: resolvedImdbId,
        meta,
        title,
        year,
        season,
        ...(request.episode !== undefined ? { episode: request.episode } : {}),
        absoluteEpisode,
        episodeName: findEpisodeName(meta, season, request.episode),
        variants,
        providers,
        disabledProviders,
      };
    }

    return {
      request,
      contentId,
      imdbId: resolvedImdbId,
      meta,
      title,
      year,
      season: 0,
      absoluteEpisode: null,
      episodeName: null,
      variants,
      providers,
      disabledProviders,
    };
  }

  private async runRequest(ctx: InternalContext, snapshot: ProviderSnapshot): Promise<void> {
    const bundles = Array.from(snapshot.bundles.values()).filter((bundle) => {
      const value = bundle.entry.value.toLowerCase();
      if (this.disabledProviders.has(value) || ctx.info.disabledProviders.has(value)) {
        return false;
      }
      if (ctx.info.providers && ctx.info.providers.size > 0) {
        return ctx.info.providers.has(value);
      }
      return true;
    });
    if (bundles.length === 0) return;
    const ordered = this.orderBundles(bundles);
    await mapLimitSettled(ordered, this.config.searchConcurrency, async (bundle) => {
      if (ctx.stopped) return;
      await this.runProvider(bundle, ctx);
    });
  }

  private orderBundles(bundles: ProviderBundle[]): ProviderBundle[] {
    const score = (bundle: ProviderBundle): number => {
      const stat = this.providerStats.get(bundle.entry.value.toLowerCase());
      if (!stat) return DEFAULT_PROVIDER_SCORE;
      return stat.avgLatencyMs + stat.failures * FAILURE_PENALTY_MS;
    };
    return bundles
      .map((bundle, index) => ({ bundle, index, score: score(bundle) }))
      .sort((a, b) => a.score - b.score || a.index - b.index)
      .map((entry) => entry.bundle);
  }

  private recordProviderResult(
    providerValue: string,
    durationMs: number,
    collected: boolean,
  ): void {
    const key = providerValue.toLowerCase();
    const stat = this.providerStats.get(key) ?? { avgLatencyMs: durationMs, failures: 0 };
    stat.avgLatencyMs =
      stat.avgLatencyMs > 0 ? Math.round(stat.avgLatencyMs * 0.7 + durationMs * 0.3) : durationMs;
    if (collected) stat.failures = 0;
    this.providerStats.set(key, stat);
  }

  private async runProvider(bundle: ProviderBundle, ctx: InternalContext): Promise<void> {
    const providerValue = trimString(bundle.entry.value);
    const startedAt = Date.now();
    let collected = false;
    let tracked = true;
    try {
      if (!providerValue || ctx.stopped) {
        tracked = false;
        return;
      }
      if (this.isCircuitOpen(providerValue)) {
        tracked = false;
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
          ...requestLogFields(ctx.info.request),
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
      collected = true;
    } finally {
      if (tracked && providerValue) {
        this.recordProviderResult(providerValue, Date.now() - startedAt, collected);
      }
    }
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
    const cacheKey = `${providerValue}|${ctx.info.contentId}|${ctx.info.request.type}`;
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
    if (metaImdbId && info.imdbId) {
      return metaImdbId.toLowerCase() === info.imdbId.toLowerCase();
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
    const { season, episode, episodeName, absoluteEpisode } = ctx.info;
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
        : matchesEpisode(title, season, episode, episodeName, absoluteEpisode);
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
      if (matchesEpisode(item.title, season, episode, episodeName, absoluteEpisode)) {
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
    const timeoutMs = Math.max(1, Math.min(budgetMs, remaining + 50));
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
    this.metrics.providerFailures += 1;
    const providerKey = providerValue.toLowerCase();
    const stat = this.providerStats.get(providerKey) ?? {
      avgLatencyMs: DEFAULT_PROVIDER_SCORE,
      failures: 0,
    };
    stat.failures += 1;
    this.providerStats.set(providerKey, stat);
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
