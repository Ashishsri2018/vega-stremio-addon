import type { AxiosInstance } from "axios";
import type { AppConfig } from "./config.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerLike {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): LoggerLike;
}

// ---------------------------------------------------------------------------
// Upstream manifest
// ---------------------------------------------------------------------------

export interface UpstreamProviderEntry {
  display_name: string;
  value: string;
  version: string;
  icon?: string;
  type?: string;
  disabled: boolean;
  hasSettings?: boolean;
  path?: string;
}

export type UpstreamManifest = UpstreamProviderEntry[];

export interface UrlEntry {
  name?: string;
  url: string;
}

export type UrlsSnapshot = Record<string, UrlEntry>;

// ---------------------------------------------------------------------------
// Upstream provider data contracts
// ---------------------------------------------------------------------------

export interface Post {
  title: string;
  link: string;
  image?: string;
  provider?: string;
  aspectRatio?: number | string;
  borderRadius?: number;
  tag?: string;
  cornerTag?: string;
  [key: string]: unknown;
}

export interface SubtitleTrack {
  title?: string;
  language?: string;
  type?: string;
  uri: string;
}

export interface SkipInterval {
  title?: string;
  from: number;
  to: number;
}

export interface ProviderStream {
  server: string;
  link: string;
  type?: string;
  quality?: string;
  tag?: string;
  tags?: string[];
  subtitles?: SubtitleTrack[];
  headers?: Record<string, string>;
  skip?: SkipInterval[];
  [key: string]: unknown;
}

export interface DirectLink {
  title?: string;
  link: string;
  type?: string;
  description?: string;
  image?: string;
  quickDownload?: boolean;
  skip?: SkipInterval[];
}

export interface LinkListEntry {
  title?: string;
  quality?: string;
  episodesLink?: string;
  quickDownload?: boolean;
  directLinks?: DirectLink[];
}

export interface ProviderMeta {
  title?: string;
  image?: string;
  poster?: string;
  logo?: string;
  synopsis?: string;
  imdbId?: string;
  tmdbId?: string;
  type?: string;
  tags?: string[];
  cast?: string[];
  rating?: string;
  linkList?: LinkListEntry[];
  webUrl?: string;
  [key: string]: unknown;
}

export interface EpisodeLink {
  title: string;
  link: string;
  description?: string;
  image?: string;
  quickDownload?: boolean;
  skip?: SkipInterval[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Provider modules
// ---------------------------------------------------------------------------

export interface SearchPostsArgs {
  searchQuery: string;
  page: number;
  providerValue: string;
  signal?: AbortSignal;
  providerContext: ProviderContextLike;
}

export interface SearchPostsModule {
  getSearchPosts(args: SearchPostsArgs): Promise<Post[]> | Post[];
}

export interface MetaArgs {
  link: string;
  providerContext: ProviderContextLike;
  [key: string]: unknown;
}

export interface MetaModule {
  getMeta(args: MetaArgs): Promise<ProviderMeta> | ProviderMeta;
}

export interface StreamArgs {
  link: string;
  type: string;
  signal?: AbortSignal;
  providerContext: ProviderContextLike;
  isDownload?: boolean;
}

export interface StreamModule {
  getStream(args: StreamArgs): Promise<ProviderStream[]> | ProviderStream[];
}

export interface EpisodesArgs {
  url: string;
  providerContext: ProviderContextLike;
}

export interface EpisodesModule {
  getEpisodes(args: EpisodesArgs): Promise<EpisodeLink[]> | EpisodeLink[];
}

export interface SettingsSchemaField {
  key: string;
  label?: string;
  description?: string;
  type?: string;
  defaultValue?: unknown;
  [key: string]: unknown;
}

export interface SettingsModule {
  getSettingsSchema(args: {
    providerContext: ProviderContextLike;
  }): Promise<SettingsSchemaField[]> | SettingsSchemaField[];
}

export interface ProviderModules {
  posts: SearchPostsModule;
  meta: MetaModule;
  stream: StreamModule;
  episodes?: EpisodesModule;
  settings?: SettingsModule;
}

export interface ProviderBundle {
  entry: UpstreamProviderEntry;
  dir: string;
  modules: ProviderModules;
}

export interface ProviderSnapshot {
  sha: string;
  rootDir: string;
  urls: UrlsSnapshot;
  bundles: Map<string, ProviderBundle>;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Provider runtime SDK
// ---------------------------------------------------------------------------

export interface KVStoreApi {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

export interface CookieJarApi {
  getCookieHeader(url: string): Promise<string | undefined>;
  getCookieMap(url: string): Promise<Record<string, string>>;
  captureFromResponse(url: string, setCookie: string[]): void;
  mergeRequestHeaders(
    url: string,
    headers: Record<string, string>,
  ): Promise<Record<string, string>>;
  flush(): Promise<void>;
}

export interface ProviderContextLike {
  axios: AxiosInstance;
  commonHeaders: Record<string, string>;
  cheerio: typeof import("cheerio");
  openWebView: (url: string, options?: Record<string, unknown>) => Promise<never>;
  kvStore: KVStoreApi;
  getCookies: (url: string) => Promise<Record<string, string>>;
}

export interface HttpRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  redirect?: "follow" | "manual";
}

export interface HttpResponseData {
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface HttpTransportApi {
  request(options: HttpRequestOptions): Promise<HttpResponseData>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface SnapshotLease {
  snapshot: ProviderSnapshot | null;
  release(): void;
}

export interface ProviderRegistryApi {
  readonly context: ProviderContextLike;
  listProviders(): ProviderBundle[];
  getActiveSnapshot(): ProviderSnapshot | null;
  acquire(): SnapshotLease;
  onActivate(listener: (snapshot: ProviderSnapshot) => void): () => void;
}

// ---------------------------------------------------------------------------
// Persistent state
// ---------------------------------------------------------------------------

export type ProviderInstallStatus = "active" | "pending";

export interface ProviderStateEntry {
  sha: string;
  version: string;
  installedAt: string;
  status: ProviderInstallStatus;
  error: string | null;
}

export interface UpdateState {
  activeSha: string | null;
  previousSha: string | null;
  headEtag: string | null;
  lastCheck: string | null;
  lastSuccess: string | null;
  nextCheck: string | null;
  lastError: string | null;
  providers: Record<string, ProviderStateEntry>;
}

export interface UpdateSummary {
  sha: string | null;
  updated: string[];
  skipped: string[];
  pending: string[];
  retired: string[];
  downloadedBytes: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface ProviderSettingsFile {
  skipTimings?: boolean;
  kv?: Record<string, unknown>;
}

export interface NormalizedProviderSettings {
  skipTimings: boolean;
  kv: Record<string, unknown>;
}

export interface SettingsManagerApi {
  get(): NormalizedProviderSettings;
  load(): Promise<void>;
  reload(): Promise<void>;
  applySchemaDefaults(
    bundles: ProviderBundle[],
    context: ProviderContextLike,
  ): Promise<void>;
  startWatching(): void;
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Cinemeta
// ---------------------------------------------------------------------------

export interface CinemetaEpisode {
  id?: string;
  name?: string;
  title?: string;
  season: number;
  episode: number;
  released?: string;
}

export interface CinemetaMeta {
  id: string;
  type: string;
  name: string;
  year?: string | number;
  releaseInfo?: string;
  videos?: CinemetaEpisode[];
}

export type MediaType = "movie" | "series";

export interface StreamRequest {
  type: MediaType;
  imdbId: string;
  season?: number;
  episode?: number;
}

export interface CinemetaApi {
  getMeta(type: MediaType, imdbId: string): Promise<CinemetaMeta | null>;
}

// ---------------------------------------------------------------------------
// Stremio output
// ---------------------------------------------------------------------------

export interface StremioSubtitle {
  id: string;
  url: string;
  lang: string;
}

export interface StremioStream {
  name: string;
  title?: string;
  url: string;
  behaviorHints?: {
    proxyHeaders?: { request?: Record<string, string> };
    bingeGroup?: string;
  };
  subtitles?: StremioSubtitle[];
}

export interface StreamHandlerApi {
  handle(request: StreamRequest, signal?: AbortSignal): Promise<StremioStream[]>;
}

export interface StremioManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  types: MediaType[];
  resources: string[];
  idPrefixes: string[];
  catalogs: unknown[];
  behaviorHints?: { configurable?: boolean };
}

// ---------------------------------------------------------------------------
// Health and server wiring
// ---------------------------------------------------------------------------

export interface HealthProviderStatus {
  version: string;
  status: ProviderInstallStatus;
}

export interface HealthReport {
  status: "ok" | "degraded" | "error";
  activeSha: string | null;
  providerCount: number;
  providers: Record<string, HealthProviderStatus>;
  lastCheck: string | null;
  lastSuccess: string | null;
  nextCheck: string | null;
  pending: string[];
  lastError: string | null;
}

export interface AddonRoutesDeps {
  config: AppConfig;
  logger: LoggerLike;
  pipeline: StreamHandlerApi;
  health: () => HealthReport;
}

// ---------------------------------------------------------------------------
// Pipeline wiring
// ---------------------------------------------------------------------------

export interface PipelineDeps {
  config: AppConfig;
  logger: LoggerLike;
  registry: ProviderRegistryApi;
  cinemeta: CinemetaApi;
}
