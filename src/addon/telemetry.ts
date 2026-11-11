export type AddonStatus = "ok" | "degraded" | "error";
export type ProviderState = "open" | "half-open" | "closed";

export interface TelemetryMetrics {
  requests: number;
  cacheHits: number;
  cacheMisses: number;
  emptyResults: number;
  deadlineHits: number;
  settleHits: number;
  providerFailures: number;
}

export interface StreamCacheStats {
  enabled: boolean;
  hits: number;
  misses: number;
  coalesced: number;
  sets: number;
  evictions: number;
  expired: number;
  size: number;
  maxEntries: number;
  ttlMs: number;
  partialTtlMs: number;
}

export interface MetadataCacheStats {
  hits: number;
  misses: number;
  sets: number;
  evictions: number;
  expired: number;
  size: number;
  maxEntries: number;
}

export interface ProviderStatusInput {
  id?: string;
  state?: string;
  calls?: number | null;
  ok?: number | null;
  empty?: number | null;
  errors?: number | null;
  timeouts?: number | null;
  skipped?: number | null;
  successRate?: number | null;
  avgMs?: number | null;
  lastMs?: number | null;
  maxMs?: number | null;
  lastError?: unknown;
  lastSuccessAt?: string | number | null;
}

export interface SnapshotStatusInput {
  sha?: string | null;
  fetchedAt?: string | null;
  ageMs?: number | null;
  refreshing?: boolean;
  lastError?: unknown;
}

export interface StatusInput {
  addon?: string;
  status?: string;
  startedAt?: string | null;
  uptimeSec?: number;
  snapshot?: SnapshotStatusInput | null;
  providers?: {
    total?: number;
    circuits?: { open?: number; halfOpen?: number };
    stats?: ProviderStatusInput[];
  };
  cache?: {
    stream?: Partial<StreamCacheStats>;
    metadata?: Partial<MetadataCacheStats> | null;
  };
  metrics?: Partial<TelemetryMetrics>;
}

export interface AddonStatusReport {
  ok: boolean;
  addon: string;
  status: AddonStatus;
  startedAt: string;
  uptimeSec: number;
  checkedAt: string;
  snapshot: {
    sha: string | null;
    fetchedAt: string | null;
    ageMs: number | null;
    refreshing: boolean;
    lastError: string | null;
  };
  providers: {
    total: number;
    circuits: { open: number; halfOpen: number };
    stats: Array<{
      id: string;
      state: ProviderState;
      calls: number | null;
      ok: number | null;
      empty: number | null;
      errors: number | null;
      timeouts: number | null;
      skipped: number | null;
      successRate: number | null;
      avgMs: number | null;
      lastMs: number | null;
      maxMs: number | null;
      lastError: string | null;
      lastSuccessAt: string | null;
    }>;
  };
  cache: {
    stream: StreamCacheStats;
    metadata: MetadataCacheStats | null;
  };
  metrics: TelemetryMetrics;
}

const STATUSES: ReadonlySet<string> = new Set(["ok", "degraded", "error"]);

function numberOr(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
  }
  if (typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function errorOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.slice(0, 300);
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { message?: unknown }).message === "string"
  ) {
    return (value as { message: string }).message.slice(0, 300);
  }
  return String(value).slice(0, 300);
}

function normalizeState(value: unknown): ProviderState {
  return value === "open" || value === "half-open" ? value : "closed";
}

function normalizeProvider(input: ProviderStatusInput) {
  const calls = nullableNumber(input.calls);
  const ok = nullableNumber(input.ok);
  const successRate =
    nullableNumber(input.successRate) ??
    (calls !== null && calls > 0 && ok !== null
      ? Math.round((ok / calls) * 1000) / 1000
      : null);

  return {
    id: String(input.id ?? ""),
    state: normalizeState(input.state),
    calls,
    ok,
    empty: nullableNumber(input.empty),
    errors: nullableNumber(input.errors),
    timeouts: nullableNumber(input.timeouts),
    skipped: nullableNumber(input.skipped),
    successRate,
    avgMs: nullableNumber(input.avgMs),
    lastMs: nullableNumber(input.lastMs),
    maxMs: nullableNumber(input.maxMs),
    lastError: errorOrNull(input.lastError),
    lastSuccessAt: isoOrNull(input.lastSuccessAt),
  };
}

function normalizeStreamCache(input: Partial<StreamCacheStats> = {}): StreamCacheStats {
  return {
    enabled: Boolean(input.enabled),
    hits: numberOr(input.hits),
    misses: numberOr(input.misses),
    coalesced: numberOr(input.coalesced),
    sets: numberOr(input.sets),
    evictions: numberOr(input.evictions),
    expired: numberOr(input.expired),
    size: numberOr(input.size),
    maxEntries: numberOr(input.maxEntries),
    ttlMs: numberOr(input.ttlMs),
    partialTtlMs: numberOr(input.partialTtlMs),
  };
}

function normalizeMetadataCache(
  input: Partial<MetadataCacheStats> | null | undefined,
): MetadataCacheStats | null {
  if (!input) return null;
  return {
    hits: numberOr(input.hits),
    misses: numberOr(input.misses),
    sets: numberOr(input.sets),
    evictions: numberOr(input.evictions),
    expired: numberOr(input.expired),
    size: numberOr(input.size),
    maxEntries: numberOr(input.maxEntries),
  };
}

function normalizeMetrics(input: Partial<TelemetryMetrics> = {}): TelemetryMetrics {
  return {
    requests: numberOr(input.requests),
    cacheHits: numberOr(input.cacheHits),
    cacheMisses: numberOr(input.cacheMisses),
    emptyResults: numberOr(input.emptyResults),
    deadlineHits: numberOr(input.deadlineHits),
    settleHits: numberOr(input.settleHits),
    providerFailures: numberOr(input.providerFailures),
  };
}

export function buildStatus(
  input: StatusInput = {},
  now = Date.now(),
): AddonStatusReport {
  const status: AddonStatus = STATUSES.has(input.status ?? "")
    ? (input.status as AddonStatus)
    : "ok";
  const uptimeSec = Math.max(
    0,
    Math.floor(numberOr(input.uptimeSec, process.uptime())),
  );
  const checkedAt = new Date(now).toISOString();
  const startedAt =
    isoOrNull(input.startedAt) ??
    new Date(now - uptimeSec * 1000).toISOString();

  const snapshot = input.snapshot ?? {};
  const fetchedAt = isoOrNull(snapshot.fetchedAt);
  const ageMs =
    nullableNumber(snapshot.ageMs) ??
    (fetchedAt ? Math.max(0, now - Date.parse(fetchedAt)) : null);

  const providers = input.providers ?? {};
  const stats = Array.isArray(providers.stats)
    ? providers.stats
        .map(normalizeProvider)
        .sort((a, b) => a.id.localeCompare(b.id))
    : [];

  return {
    ok: status !== "error",
    addon: String(input.addon ?? ""),
    status,
    startedAt,
    uptimeSec,
    checkedAt,
    snapshot: {
      sha: snapshot.sha == null ? null : String(snapshot.sha),
      fetchedAt,
      ageMs,
      refreshing: Boolean(snapshot.refreshing),
      lastError: errorOrNull(snapshot.lastError),
    },
    providers: {
      total: numberOr(providers.total, stats.length),
      circuits: {
        open: numberOr(providers.circuits?.open),
        halfOpen: numberOr(providers.circuits?.halfOpen),
      },
      stats,
    },
    cache: {
      stream: normalizeStreamCache(input.cache?.stream),
      metadata: normalizeMetadataCache(input.cache?.metadata),
    },
    metrics: normalizeMetrics(input.metrics),
  };
}
