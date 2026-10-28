import { promises as fs } from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type {
  HealthProviderStatus,
  HealthReport,
  LoggerLike,
  ProviderBundle,
  ProviderSnapshot,
  ProviderStateEntry,
  UpdateState,
  UpdateSummary,
  UpstreamProviderEntry,
  UrlEntry,
  UrlsSnapshot,
} from "../types.js";
import { mapLimit, mapLimitSettled, randomInt } from "../util/concurrency.js";
import {
  ensureDir,
  fileExists,
  fsyncDir,
  listDirs,
  removeDir,
} from "../util/fs.js";
import {
  loadProviderBundle,
  PROVIDER_MODULES,
  unloadProviderModules,
  validateModuleHeader,
} from "./loader.js";
import type { ProviderRegistry } from "./registry.js";
import {
  computeBranchSnapshotSha,
  SourceClient,
  SourceHttpError,
} from "./source.js";
import { providerRootDir, StateStore } from "./state.js";

const MAX_MODULE_BYTES = 2 * 1024 * 1024;
const LOCK_STALE_MS = 10 * 60 * 1000;
const BACKOFF_MS = [15 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000];
const TEMP_MARKERS = [".tmp-", ".tmp", ".old-"];

type ModuleName =
  | (typeof PROVIDER_MODULES.required)[number]
  | (typeof PROVIDER_MODULES.optional)[number];

interface TargetSnapshot {
  sha: string;
  fetchSha?: string | null;
  etagUpdate?: string | null;
  prefetched?: { manifestBytes: Buffer; urlsBytes: Buffer };
}

interface SnapshotData {
  manifestBytes: Buffer;
  urlsBytes: Buffer;
  entries: UpstreamProviderEntry[];
  urls: UrlsSnapshot;
}

interface ProviderWorkResult {
  entry: UpstreamProviderEntry;
  ok: boolean;
  bytes: number;
  error?: string;
}

interface PendingRetryResult {
  entry: UpstreamProviderEntry;
  bundle?: ProviderBundle;
  bytes?: number;
  error?: string;
}

export interface UpdaterOptions {
  config: AppConfig;
  logger: LoggerLike;
  registry: ProviderRegistry;
  stateStore: StateStore;
  source: SourceClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isSafeSegment(segment: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(segment) && segment !== "." && segment !== "..";
}

function isSafeTargetSha(sha: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{6,79}$/.test(sha);
}

function providerSourceDir(entry: UpstreamProviderEntry): string {
  const value = entry.path?.trim() || entry.value;
  const segments = value.split("/");
  if (segments.length === 0 || !segments.every(isSafeSegment)) {
    throw new Error(`Invalid provider path for ${entry.value}`);
  }
  return segments.join("/");
}

function parseManifest(bytes: Buffer): UpstreamProviderEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(bytes.toString("utf8")));
  } catch {
    throw new Error("manifest.json is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("manifest.json must contain an array");
  }

  const entries: UpstreamProviderEntry[] = [];
  const seen = new Set<string>();
  for (const raw of parsed) {
    if (!isRecord(raw)) {
      throw new Error("manifest.json contains a non-object entry");
    }
    if (raw.disabled !== false) continue;

    if (typeof raw.value !== "string" || !/^[A-Za-z0-9_.-]+$/.test(raw.value)) {
      throw new Error("manifest.json contains an enabled provider with an invalid value");
    }
    if (typeof raw.version !== "string" || raw.version.length === 0) {
      throw new Error(`manifest.json entry ${raw.value} has an invalid version`);
    }
    if (seen.has(raw.value)) {
      throw new Error(`manifest.json contains duplicate provider ${raw.value}`);
    }
    if (raw.path !== undefined) {
      if (typeof raw.path !== "string" || raw.path.length === 0) {
        throw new Error(`manifest.json entry ${raw.value} has an invalid path`);
      }
    }
    seen.add(raw.value);

    const entry: UpstreamProviderEntry = {
      display_name:
        typeof raw.display_name === "string" ? raw.display_name : raw.value,
      value: raw.value,
      version: raw.version,
      disabled: false,
    };
    if (typeof raw.icon === "string") entry.icon = raw.icon;
    if (typeof raw.type === "string") entry.type = raw.type;
    if (typeof raw.hasSettings === "boolean") entry.hasSettings = raw.hasSettings;
    if (typeof raw.path === "string") {
      providerSourceDir({ ...entry, path: raw.path });
      entry.path = raw.path;
    }
    entries.push(entry);
  }
  return entries;
}

function parseUrls(bytes: Buffer): UrlsSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(bytes.toString("utf8")));
  } catch {
    throw new Error("urls.json is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("urls.json must contain an object");
  }

  const urls: UrlsSnapshot = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isRecord(value) || typeof value.url !== "string" || value.url.length === 0) {
      throw new Error(`urls.json entry ${key} is invalid`);
    }
    const entry: UrlEntry = { url: value.url };
    if (typeof value.name === "string") entry.name = value.name;
    urls[key] = entry;
  }
  return urls;
}

function isNotFound(error: unknown): boolean {
  return error instanceof SourceHttpError && error.status === 404;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoAfter(ms: number): string {
  return new Date(Date.now() + Math.max(0, ms)).toISOString();
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

export class Updater {
  private readonly config: AppConfig;
  private readonly logger: LoggerLike;
  private readonly registry: ProviderRegistry;
  private readonly stateStore: StateStore;
  private readonly source: SourceClient;
  private readonly providerRoot: string;
  private readonly lockPath: string;

  private running = false;
  private inFlight: Promise<UpdateSummary> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private stopped = false;
  private stateLoaded = false;
  private failureCount = 0;
  private lastLockSkipped = false;

  constructor(options: UpdaterOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.registry = options.registry;
    this.stateStore = options.stateStore;
    this.source = options.source;
    this.providerRoot = providerRootDir(
      options.config.dataDir,
      options.config.providerSource,
    );
    this.lockPath = path.join(this.providerRoot, "update.lock");
  }

  async bootstrap(timeoutMs = 60_000): Promise<void> {
    try {
      await ensureDir(this.providerRoot);
      await this.cleanupTransientDirs();
      await this.stateStore.load();
      this.stateLoaded = true;

      const state = this.stateStore.get();
      const pinned = this.config.providerSha;
      if (pinned) {
        const loaded = await this.loadSnapshotFromDisk(pinned);
        if (loaded) {
          await this.activateLoadedSnapshot(loaded.snapshot, loaded.entries);
          return;
        }
        await this.runOnce("bootstrap-pinned");
        return;
      }

      if (state.activeSha) {
        const loaded = await this.loadSnapshotFromDisk(state.activeSha);
        if (loaded) {
          await this.activateLoadedSnapshot(loaded.snapshot, loaded.entries);
          return;
        }
      }

      if (this.config.updateOnStart) {
        await this.runWithBootstrapTimeout(timeoutMs);
      }
    } catch (error) {
      this.logger.error("updater_bootstrap_failed", { error: errorMessage(error) });
    }
  }

  async preloadFromDisk(): Promise<boolean> {
    try {
      await ensureDir(this.providerRoot);
      await this.cleanupTransientDirs();
      await this.stateStore.load();
      this.stateLoaded = true;

      const sha = this.config.providerSha ?? this.stateStore.get().activeSha;
      if (!sha) return false;
      const loaded = await this.loadSnapshotFromDisk(sha);
      if (!loaded) return false;
      await this.activateLoadedSnapshot(loaded.snapshot, loaded.entries);
      return true;
    } catch (error) {
      this.logger.warn("provider_preload_failed", { error: errorMessage(error) });
      return false;
    }
  }

  start(): void {
    this.started = true;
    this.stopped = false;
    this.clearTimer();
    void this.initializeSchedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    const inFlight = this.inFlight;
    if (inFlight) {
      try {
        await inFlight;
      } catch (error) {
        this.logger.error("updater_stop_wait_failed", { error: errorMessage(error) });
      }
    }
  }

  async runOnce(reason = "manual"): Promise<UpdateSummary> {
    if (this.running) {
      this.logger.debug("provider_update_already_running", { reason });
      return this.skippedSummary(Date.now());
    }

    this.running = true;
    const task = this.executeRun(reason);
    this.inFlight = task;
    try {
      return await task;
    } finally {
      this.running = false;
      this.inFlight = null;
      if (this.started && !this.stopped) this.scheduleNext();
    }
  }

  getHealth(): HealthReport {
    const state = this.getState();
    const bundles = this.registry.listProviders();
    const providers: Record<string, HealthProviderStatus> = {};

    for (const [value, entry] of Object.entries(state.providers)) {
      providers[value] = { version: entry.version, status: entry.status };
    }
    for (const bundle of bundles) {
      const existing = providers[bundle.entry.value];
      if (!existing) {
        providers[bundle.entry.value] = {
          version: bundle.entry.version,
          status: "active",
        };
      } else if (existing.status === "active") {
        existing.version = bundle.entry.version;
      }
    }

    const pending = uniqueSorted(
      Object.entries(providers)
        .filter(([, entry]) => entry.status === "pending")
        .map(([value]) => value),
    );
    const providerCount = bundles.length;
    const status: HealthReport["status"] =
      this.registry.getActiveSnapshot() === null && state.lastError
        ? "error"
        : pending.length > 0 || providerCount === 0
          ? "degraded"
          : "ok";

    return {
      status,
      activeSha: state.activeSha,
      providerCount,
      providers,
      lastCheck: state.lastCheck,
      lastSuccess: state.lastSuccess,
      nextCheck: state.nextCheck,
      pending,
      lastError: state.lastError,
    };
  }

  getState(): UpdateState {
    return this.stateStore.get();
  }

  private async executeRun(reason: string): Promise<UpdateSummary> {
    const startedAt = Date.now();
    let release: (() => Promise<void>) | null = null;
    try {
      await ensureDir(this.providerRoot);
      if (!this.stateLoaded) {
        await this.stateStore.load();
        this.stateLoaded = true;
      }

      release = await this.acquireLock();
      if (!release) {
        this.lastLockSkipped = true;
        this.logger.warn("provider_update_locked", { reason });
        return this.skippedSummary(startedAt);
      }
      this.lastLockSkipped = false;

      await this.stateStore.update((draft) => {
        draft.lastCheck = nowIso();
        draft.nextCheck = isoAfter(this.computeNextCheckMs());
      });

      return await this.performUpdate(reason, startedAt);
    } catch (error) {
      const message = errorMessage(error);
      this.logger.error("provider_update_failed", { reason, error: message });
      try {
        await this.recordFailure(message);
      } catch (recordError) {
        this.logger.error("provider_update_record_failed", {
          error: errorMessage(recordError),
        });
      }
      return this.failureSummary(startedAt);
    } finally {
      if (release) {
        try {
          await release();
        } catch (error) {
          this.logger.warn("provider_update_lock_release_failed", {
            error: errorMessage(error),
          });
        }
      }
    }
  }

  private async performUpdate(
    reason: string,
    startedAt: number,
  ): Promise<UpdateSummary> {
    const state = this.stateStore.get();
    const active = this.registry.getActiveSnapshot();
    const target = await this.resolveTarget(state);
    if (!isSafeTargetSha(target.sha)) {
      throw new Error("Resolved provider snapshot sha is not safe");
    }

    if (active && target.sha === state.activeSha && active.sha === target.sha) {
      return this.handleUnchanged(active, target, reason, startedAt);
    }
    return this.handleFullUpdate(target, reason, startedAt);
  }

  private async resolveTarget(state: UpdateState): Promise<TargetSnapshot> {
    if (this.config.providerSha) {
      return { sha: this.config.providerSha };
    }

    try {
      let result = await this.source.resolveHead(state.headEtag);
      if (result.notModified) {
        if (state.activeSha) {
          return { sha: state.activeSha };
        }
        result = await this.source.resolveHead(null);
        if (result.notModified) {
          throw new Error("GitHub API returned 304 without a cached snapshot");
        }
      }
      return { sha: result.sha, etagUpdate: result.etag };
    } catch (apiError) {
      this.logger.warn("provider_update_api_failed", {
        error: errorMessage(apiError),
      });
      try {
        const [manifestBytes, urlsBytes] = await Promise.all([
          this.source.fetchFile(null, "manifest.json"),
          this.source.fetchFile(null, "urls.json"),
        ]);
        return {
          sha: computeBranchSnapshotSha(manifestBytes, urlsBytes),
          fetchSha: null,
          prefetched: { manifestBytes, urlsBytes },
        };
      } catch (fallbackError) {
        throw new Error(
          `head resolution failed (${errorMessage(apiError)}); branch fallback failed (${errorMessage(fallbackError)})`,
        );
      }
    }
  }

  private async handleUnchanged(
    active: ProviderSnapshot,
    target: TargetSnapshot,
    reason: string,
    startedAt: number,
  ): Promise<UpdateSummary> {
    const state = this.stateStore.get();
    const pendingValues = Object.entries(state.providers)
      .filter(
        ([, entry]) => entry.status === "pending" || entry.sha !== target.sha,
      )
      .map(([value]) => value)
      .filter((value) => active.bundles.has(value) || state.providers[value]?.status === "pending");

    if (pendingValues.length === 0) {
      const now = nowIso();
      await this.stateStore.update((draft) => {
        draft.activeSha = target.sha;
        if (target.etagUpdate !== undefined) draft.headEtag = target.etagUpdate;
        draft.lastSuccess = now;
        draft.lastError = null;
        draft.nextCheck = isoAfter(this.computeNextCheckMs());
      });
      this.failureCount = 0;
      await this.cleanupSnapshots();

      const summary: UpdateSummary = {
        sha: target.sha,
        updated: [],
        skipped: uniqueSorted(
          this.registry.listProviders().map((bundle) => bundle.entry.value),
        ),
        pending: [],
        retired: [],
        downloadedBytes: 0,
        durationMs: Date.now() - startedAt,
      };
      this.logSummary(reason, summary);
      return summary;
    }

    let entries: UpstreamProviderEntry[];
    try {
      entries = parseManifest(
        await fs.readFile(path.join(active.rootDir, "manifest.json")),
      );
    } catch (error) {
      throw new Error(`installed manifest.json is unusable: ${errorMessage(error)}`);
    }
    const entriesByValue = new Map(entries.map((entry) => [entry.value, entry]));
    const retryEntries: UpstreamProviderEntry[] = [];
    const dropped: string[] = [];
    for (const value of pendingValues) {
      const entry = entriesByValue.get(value);
      if (entry) retryEntries.push(entry);
      else dropped.push(value);
    }

    return this.retryPending(
      active,
      retryEntries,
      dropped,
      target,
      reason,
      startedAt,
    );
  }

  private async retryPending(
    active: ProviderSnapshot,
    entries: UpstreamProviderEntry[],
    dropped: string[],
    target: TargetSnapshot,
    reason: string,
    startedAt: number,
  ): Promise<UpdateSummary> {
    const results = await mapLimitSettled(
      entries,
      this.config.updateConcurrency,
      async (entry) => {
        try {
          const result = await this.retryProvider(
            active,
            entry,
            target.sha,
            target.fetchSha,
          );
          return {
            entry,
            bundle: result.bundle,
            bytes: result.bytes,
          } as PendingRetryResult;
        } catch (error) {
          return { entry, error: errorMessage(error) } satisfies PendingRetryResult;
        }
      },
    );

    const successes: PendingRetryResult[] = [];
    const failures: PendingRetryResult[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value.bundle) successes.push(result.value);
        else failures.push(result.value);
      }
    }

    const now = nowIso();
    const newBundles = new Map(active.bundles);
    for (const success of successes) {
      if (success.bundle) newBundles.set(success.entry.value, success.bundle);
    }

    await this.stateStore.update((draft) => {
      for (const value of dropped) delete draft.providers[value];
      for (const success of successes) {
        draft.providers[success.entry.value] = {
          sha: target.sha,
          version: success.entry.version,
          installedAt: now,
          status: "active",
          error: null,
        };
      }
      for (const failure of failures) {
        const previous = draft.providers[failure.entry.value];
        draft.providers[failure.entry.value] = {
          sha: previous?.sha ?? active.sha,
          version: previous?.version ?? failure.entry.version,
          installedAt: previous?.installedAt ?? now,
          status: "pending",
          error: failure.error ?? "provider update failed",
        };
      }
      if (target.etagUpdate !== undefined) draft.headEtag = target.etagUpdate;
      draft.nextCheck = isoAfter(this.computeNextCheckMs());
      if (successes.length > 0 || failures.length === 0) {
        draft.lastSuccess = now;
      }
      draft.lastError = null;
    });
    this.failureCount = 0;

    if (entries.length > 0) {
      const snapshot: ProviderSnapshot = {
        sha: active.sha,
        rootDir: active.rootDir,
        urls: active.urls,
        bundles: newBundles,
        createdAt: Date.now(),
      };
      this.registry.activate(snapshot);
      await this.cleanupSnapshots();
    }

    const downloadedBytes = successes.reduce(
      (total, success) => total + (success.bytes ?? 0),
      0,
    );
    const summary: UpdateSummary = {
      sha: active.sha,
      updated: successes.map((success) => success.entry.value),
      skipped: uniqueSorted(
        Array.from(active.bundles.keys()).filter(
          (value) =>
            !successes.some((success) => success.entry.value === value) &&
            !failures.some((failure) => failure.entry.value === value) &&
            !dropped.includes(value),
        ),
      ),
      pending: failures.map((failure) => failure.entry.value),
      retired: dropped,
      downloadedBytes,
      durationMs: Date.now() - startedAt,
    };
    this.logSummary(reason, summary);
    return summary;
  }

  private async retryProvider(
    active: ProviderSnapshot,
    entry: UpstreamProviderEntry,
    targetSha: string,
    fetchSha?: string | null,
  ): Promise<{ bundle: ProviderBundle; bytes: number }> {
    const staging = path.join(
      this.providerRoot,
      `${targetSha}.tmp-${randomInt(0, 0x7fffffff).toString(36)}`,
    );
    await ensureDir(staging);
    let moved = false;
    try {
      const { files, bytes } = await this.downloadProviderModules(
        entry,
        fetchSha === undefined ? targetSha : fetchSha,
      );
      await this.writeModules(staging, files);
      await this.syncTree(staging);

      const destination = path.join(active.rootDir, entry.value);
      const backup = await this.installDirectory(staging, destination);
      moved = true;
      try {
        unloadProviderModules(destination);
        const bundle = await loadProviderBundle(entry, destination);
        if (backup) {
          await removeDir(backup).catch((error: unknown) => {
            this.logger.warn("provider_backup_cleanup_failed", {
              error: errorMessage(error),
            });
          });
        }
        return { bundle, bytes };
      } catch (error) {
        await removeDir(destination).catch(() => undefined);
        if (backup) {
          await fs.rename(backup, destination).catch((restoreError: unknown) => {
            this.logger.error("provider_rollback_failed", {
              provider: entry.value,
              error: errorMessage(restoreError),
            });
          });
        }
        unloadProviderModules(destination);
        throw error;
      }
    } finally {
      if (!moved && (await fileExists(staging))) {
        await removeDir(staging).catch(() => undefined);
      }
    }
  }

  private async handleFullUpdate(
    target: TargetSnapshot,
    reason: string,
    startedAt: number,
  ): Promise<UpdateSummary> {
    const state = this.stateStore.get();
    const previousActive = this.registry.getActiveSnapshot();
    const data = await this.fetchSnapshotData(target);
    if (data.entries.length === 0) {
      throw new Error("manifest.json has no enabled providers");
    }

    const staging = path.join(
      this.providerRoot,
      `${target.sha}.tmp-${randomInt(0, 0x7fffffff).toString(36)}`,
    );
    await ensureDir(staging);
    let stagingExists = true;
    try {
      await fs.writeFile(path.join(staging, "manifest.json"), data.manifestBytes);
      await fs.writeFile(path.join(staging, "urls.json"), data.urlsBytes);

      const results = await mapLimit(
        data.entries,
        this.config.updateConcurrency,
        (entry) =>
          this.stageProvider(
            entry,
            target.fetchSha === undefined ? target.sha : target.fetchSha,
            staging,
          ),
      );
      const successes = results.filter((result) => result.ok);
      const failed = results.filter((result) => !result.ok);
      const downloadedBytes = successes.reduce(
        (total, result) => total + result.bytes,
        0,
      );

      await this.syncTree(staging);
      const finalDir = this.snapshotDir(target.sha);
      await this.installSnapshotDirectory(staging, finalDir);
      stagingExists = false;

      unloadProviderModules(finalDir);
      const loaded = new Map<string, ProviderBundle>();
      const loadFailures = new Map<string, string>();
      for (const result of successes) {
        try {
          const bundle = await loadProviderBundle(
            result.entry,
            path.join(finalDir, result.entry.value),
          );
          loaded.set(result.entry.value, bundle);
        } catch (error) {
          loadFailures.set(result.entry.value, errorMessage(error));
        }
      }

      const enabledValues = new Set(data.entries.map((entry) => entry.value));
      const previousBundles = previousActive?.bundles ?? new Map<string, ProviderBundle>();
      const bundles = new Map<string, ProviderBundle>();
      for (const entry of data.entries) {
        const fresh = loaded.get(entry.value);
        if (fresh) {
          bundles.set(entry.value, fresh);
          continue;
        }
        const old = previousBundles.get(entry.value);
        if (old) bundles.set(entry.value, old);
      }
      const retired = uniqueSorted(
        Array.from(previousBundles.keys()).filter((value) => !enabledValues.has(value)),
      );
      const mergedUrls: UrlsSnapshot = {
        ...(previousActive?.urls ?? {}),
        ...data.urls,
      };

      const errors = new Map<string, string>();
      for (const result of failed) {
        if (result.error) errors.set(result.entry.value, result.error);
      }
      for (const [value, error] of loadFailures) errors.set(value, error);

      if (bundles.size === 0) {
        if (target.sha !== state.previousSha) {
          await removeDir(finalDir).catch(() => undefined);
        }
        const now = nowIso();
        const message = "no provider bundles could be loaded from the new snapshot";
        await this.stateStore.update((draft) => {
          for (const entry of data.entries) {
            const old = previousBundles.get(entry.value);
            const previous = draft.providers[entry.value];
            draft.providers[entry.value] = {
              sha: old ? (previousActive?.sha ?? target.sha) : target.sha,
              version: old?.entry.version ?? entry.version,
              installedAt: previous?.installedAt ?? now,
              status: "pending",
              error: errors.get(entry.value) ?? message,
            };
          }
          draft.lastError = message;
          draft.nextCheck = this.nextFailureCheck();
        });
        const summary = this.buildSummary(
          target.sha,
          [],
          [],
          data.entries.map((entry) => entry.value),
          retired,
          downloadedBytes,
          startedAt,
        );
        this.logSummary(reason, summary);
        return summary;
      }

      const snapshot: ProviderSnapshot = {
        sha: target.sha,
        rootDir: finalDir,
        urls: mergedUrls,
        bundles,
        createdAt: Date.now(),
      };

      let previousSha: string | null;
      if (previousActive && previousActive.sha !== target.sha) {
        previousSha = previousActive.sha;
      } else if (state.activeSha && state.activeSha !== target.sha) {
        previousSha = state.activeSha;
      } else {
        previousSha = state.previousSha;
      }

      const now = nowIso();
      const providerState: Record<string, ProviderStateEntry> = {};
      for (const entry of data.entries) {
        if (loaded.has(entry.value)) {
          providerState[entry.value] = {
            sha: target.sha,
            version: entry.version,
            installedAt: now,
            status: "active",
            error: null,
          };
          continue;
        }
        const old = previousBundles.get(entry.value);
        const previous = state.providers[entry.value];
        providerState[entry.value] = {
          sha: old
            ? (previousActive?.sha ?? previous?.sha ?? target.sha)
            : target.sha,
          version: old?.entry.version ?? entry.version,
          installedAt: previous?.installedAt ?? now,
          status: "pending",
          error: errors.get(entry.value) ?? "provider update failed",
        };
      }

      await this.stateStore.update((draft) => {
        draft.activeSha = target.sha;
        draft.previousSha = previousSha;
        if (target.etagUpdate !== undefined) draft.headEtag = target.etagUpdate;
        draft.providers = providerState;
        draft.lastSuccess = now;
        draft.lastError = null;
        draft.nextCheck = isoAfter(this.computeNextCheckMs());
      });
      this.failureCount = 0;

      this.registry.activate(snapshot);
      await this.cleanupSnapshots();

      const summary = this.buildSummary(
        target.sha,
        Array.from(loaded.keys()),
        [],
        failed.map((result) => result.entry.value).concat(
          Array.from(loadFailures.keys()),
        ),
        retired,
        downloadedBytes,
        startedAt,
      );
      this.logSummary(reason, summary);
      return summary;
    } finally {
      if (stagingExists && (await fileExists(staging))) {
        await removeDir(staging).catch(() => undefined);
      }
    }
  }

  private async stageProvider(
    entry: UpstreamProviderEntry,
    fetchSha: string | null,
    staging: string,
  ): Promise<ProviderWorkResult> {
    try {
      const { files, bytes } = await this.downloadProviderModules(entry, fetchSha);
      const dir = path.join(staging, entry.value);
      await this.writeModules(dir, files);
      return { entry, ok: true, bytes };
    } catch (error) {
      return { entry, ok: false, bytes: 0, error: errorMessage(error) };
    }
  }

  private async downloadProviderModules(
    entry: UpstreamProviderEntry,
    fetchSha: string | null,
  ): Promise<{ files: Map<ModuleName, Buffer>; bytes: number }> {
    const sourceDir = providerSourceDir(entry);
    const files = new Map<ModuleName, Buffer>();
    let bytes = 0;

    for (const moduleName of PROVIDER_MODULES.required) {
      const content = await this.fetchModule(entry, fetchSha, sourceDir, moduleName, true);
      if (content) {
        files.set(moduleName, content);
        bytes += content.length;
      }
    }
    for (const moduleName of PROVIDER_MODULES.optional) {
      const content = await this.fetchModule(entry, fetchSha, sourceDir, moduleName, false);
      if (content) {
        files.set(moduleName, content);
        bytes += content.length;
      }
    }
    return { files, bytes };
  }

  private async fetchModule(
    entry: UpstreamProviderEntry,
    fetchSha: string | null,
    sourceDir: string,
    moduleName: ModuleName,
    required: boolean,
  ): Promise<Buffer | null> {
    const relative = `dist/${sourceDir}/${moduleName}.js`;
    let content: Buffer;
    try {
      content = await this.source.fetchFile(fetchSha, relative);
    } catch (error) {
      if (!required && isNotFound(error)) return null;
      if (required && isNotFound(error)) {
        throw new Error(`${entry.value} is missing required module ${moduleName}.js`);
      }
      throw new Error(
        `${entry.value} ${moduleName}.js download failed: ${errorMessage(error)}`,
      );
    }

    if (content.length < 1 || content.length > MAX_MODULE_BYTES) {
      throw new Error(
        `${moduleName}.js for ${entry.value} has invalid size (${content.length} bytes)`,
      );
    }
    validateModuleHeader(content, entry, moduleName);
    return content;
  }

  private async writeModules(
    dir: string,
    files: Map<ModuleName, Buffer>,
  ): Promise<void> {
    await ensureDir(dir);
    for (const [moduleName, content] of files) {
      await fs.writeFile(path.join(dir, `${moduleName}.js`), content);
    }
  }

  private async fetchSnapshotData(target: TargetSnapshot): Promise<SnapshotData> {
    let manifestBytes: Buffer;
    let urlsBytes: Buffer;
    if (target.prefetched) {
      manifestBytes = target.prefetched.manifestBytes;
      urlsBytes = target.prefetched.urlsBytes;
    } else {
      [manifestBytes, urlsBytes] = await Promise.all([
        this.source.fetchFile(target.sha, "manifest.json"),
        this.source.fetchFile(target.sha, "urls.json"),
      ]);
    }
    return {
      manifestBytes,
      urlsBytes,
      entries: parseManifest(manifestBytes),
      urls: parseUrls(urlsBytes),
    };
  }

  private async loadSnapshotFromDisk(
    sha: string,
  ): Promise<{ snapshot: ProviderSnapshot; entries: UpstreamProviderEntry[] } | null> {
    if (!isSafeTargetSha(sha)) return null;
    const dir = this.snapshotDir(sha);
    try {
      const [manifestBytes, urlsBytes] = await Promise.all([
        fs.readFile(path.join(dir, "manifest.json")),
        fs.readFile(path.join(dir, "urls.json")),
      ]);
      const entries = parseManifest(manifestBytes);
      const urls = parseUrls(urlsBytes);
      if (entries.length === 0) return null;

      const bundles = new Map<string, ProviderBundle>();
      for (const entry of entries) {
        const bundle = await loadProviderBundle(
          entry,
          path.join(dir, entry.value),
        );
        bundles.set(entry.value, bundle);
      }
      return {
        snapshot: {
          sha,
          rootDir: dir,
          urls,
          bundles,
          createdAt: Date.now(),
        },
        entries,
      };
    } catch (error) {
      this.logger.warn("provider_snapshot_load_failed", {
        sha,
        error: errorMessage(error),
      });
      return null;
    }
  }

  private async activateLoadedSnapshot(
    snapshot: ProviderSnapshot,
    entries: UpstreamProviderEntry[],
  ): Promise<void> {
    const state = this.stateStore.get();
    const now = nowIso();
    const previousSha =
      state.activeSha && state.activeSha !== snapshot.sha
        ? state.activeSha
        : state.previousSha;
    const providers: Record<string, ProviderStateEntry> = {};
    for (const entry of entries) {
      const previous = state.providers[entry.value];
      providers[entry.value] = {
        sha: snapshot.sha,
        version: entry.version,
        installedAt:
          previous?.sha === snapshot.sha && previous.version === entry.version
            ? previous.installedAt
            : now,
        status: "active",
        error: null,
      };
    }

    await this.stateStore.update((draft) => {
      draft.activeSha = snapshot.sha;
      draft.previousSha = previousSha;
      draft.providers = providers;
    });
    this.registry.activate(snapshot);
    await this.cleanupSnapshots();
    this.logger.info("provider_snapshot_loaded", {
      sha: snapshot.sha,
      providerCount: snapshot.bundles.size,
    });
  }

  private async runWithBootstrapTimeout(timeoutMs: number): Promise<void> {
    const run = this.runOnce("bootstrap").catch((error: unknown) => {
      this.logger.error("updater_bootstrap_run_failed", {
        error: errorMessage(error),
      });
      return this.skippedSummary(Date.now());
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        run.then(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.logger.error("updater_bootstrap_timeout", { timeoutMs });
            resolve();
          }, Math.max(1, timeoutMs));
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async initializeSchedule(): Promise<void> {
    try {
      if (!this.stateLoaded) {
        await this.stateStore.load();
        this.stateLoaded = true;
      }
    } catch (error) {
      this.logger.error("updater_schedule_load_failed", {
        error: errorMessage(error),
      });
    }
    if (this.stopped) return;

    if (!this.registry.getActiveSnapshot() && this.config.updateOnStart) {
      this.setTimer(0);
      return;
    }
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (!this.started || this.stopped) return;
    this.clearTimer();

    const state = this.stateStore.get();
    let delay: number;
    if (this.lastLockSkipped) {
      delay = 60_000;
    } else if (state.nextCheck) {
      const next = Date.parse(state.nextCheck);
      delay = Number.isFinite(next)
        ? Math.max(0, next - Date.now())
        : this.computeNextCheckMs();
    } else {
      delay = this.computeNextCheckMs();
    }
    this.setTimer(delay);
  }

  private setTimer(delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce("schedule");
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private computeNextCheckMs(): number {
    const min = this.config.updateIntervalMinHours;
    const max = this.config.updateIntervalMaxHours;
    const hours = min + Math.random() * Math.max(0, max - min);
    return Math.round(hours * 3_600_000) + randomInt(0, 120_000);
  }

  private nextFailureCheck(): string {
    this.failureCount += 1;
    const backoff = BACKOFF_MS[this.failureCount - 1];
    return isoAfter(backoff ?? this.computeNextCheckMs());
  }

  private async recordFailure(message: string): Promise<void> {
    const nextCheck = this.nextFailureCheck();
    await this.stateStore.update((draft) => {
      draft.lastError = message;
      draft.nextCheck = nextCheck;
    });
  }

  private async acquireLock(): Promise<(() => Promise<void>) | null> {
    await ensureDir(this.providerRoot);
    const payload = `${JSON.stringify({
      pid: process.pid,
      startedAt: nowIso(),
    })}\n`;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = await fs.open(this.lockPath, "wx");
        try {
          await handle.writeFile(payload);
          await handle.sync();
        } finally {
          await handle.close();
        }
        return async () => {
          await fs.unlink(this.lockPath).catch(() => undefined);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stale = false;
        try {
          const stat = await fs.stat(this.lockPath);
          stale = Date.now() - stat.mtimeMs > LOCK_STALE_MS;
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw statError;
        }
        if (!stale) return null;
        await fs.unlink(this.lockPath).catch(() => undefined);
      }
    }
    return null;
  }

  private snapshotDir(sha: string): string {
    return path.join(this.providerRoot, sha);
  }

  private async cleanupTransientDirs(): Promise<void> {
    for (const name of await listDirs(this.providerRoot)) {
      if (TEMP_MARKERS.some((marker) => name.includes(marker))) {
        await removeDir(path.join(this.providerRoot, name)).catch(() => undefined);
      }
    }
  }

  private async cleanupSnapshots(): Promise<void> {
    const state = this.stateStore.get();
    const keep = new Set(
      [state.activeSha, state.previousSha].filter(
        (value): value is string => Boolean(value),
      ),
    );
    for (const name of await listDirs(this.providerRoot)) {
      if (name.includes(".tmp-") || name.endsWith(".tmp")) continue;
      if (keep.has(name)) continue;
      const dir = path.join(this.providerRoot, name);
      unloadProviderModules(dir);
      await removeDir(dir).catch((error: unknown) => {
        this.logger.warn("provider_snapshot_cleanup_failed", {
          error: errorMessage(error),
        });
      });
    }
  }

  private async installSnapshotDirectory(
    staging: string,
    destination: string,
  ): Promise<void> {
    await ensureDir(path.dirname(destination));
    let backup: string | null = null;
    if (await fileExists(destination)) {
      backup = `${destination}.old-${randomInt(0, 0x7fffffff).toString(36)}`;
      await fs.rename(destination, backup);
    }
    try {
      await fs.rename(staging, destination);
    } catch (error) {
      if (backup) {
        await fs.rename(backup, destination).catch(() => undefined);
      }
      throw error;
    }
    if (backup) {
      await removeDir(backup).catch((error: unknown) => {
        this.logger.warn("provider_snapshot_backup_cleanup_failed", {
          error: errorMessage(error),
        });
      });
    }
    await fsyncDir(path.dirname(destination));
  }

  private async installDirectory(
    staging: string,
    destination: string,
  ): Promise<string | null> {
    let backup: string | null = null;
    if (await fileExists(destination)) {
      backup = `${destination}.old-${randomInt(0, 0x7fffffff).toString(36)}`;
      await fs.rename(destination, backup);
    }
    try {
      await fs.rename(staging, destination);
      return backup;
    } catch (error) {
      if (backup) {
        await fs.rename(backup, destination).catch(() => undefined);
      }
      throw error;
    }
  }

  private async syncTree(root: string): Promise<void> {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        await this.syncTree(fullPath);
      } else if (entry.isFile()) {
        const handle = await fs.open(fullPath, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    }
    await fsyncDir(root);
  }

  private skippedSummary(startedAt: number): UpdateSummary {
    const state = this.stateStore.get();
    return {
      sha: state.activeSha,
      updated: [],
      skipped: uniqueSorted(
        this.registry.listProviders().map((bundle) => bundle.entry.value),
      ),
      pending: uniqueSorted(
        Object.entries(state.providers)
          .filter(([, entry]) => entry.status === "pending")
          .map(([value]) => value),
      ),
      retired: [],
      downloadedBytes: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  private failureSummary(startedAt: number): UpdateSummary {
    return this.skippedSummary(startedAt);
  }

  private buildSummary(
    sha: string,
    updated: string[],
    skipped: string[],
    pending: string[],
    retired: string[],
    downloadedBytes: number,
    startedAt: number,
  ): UpdateSummary {
    return {
      sha,
      updated: uniqueSorted(updated),
      skipped: uniqueSorted(skipped),
      pending: uniqueSorted(pending),
      retired: uniqueSorted(retired),
      downloadedBytes,
      durationMs: Date.now() - startedAt,
    };
  }

  private logSummary(reason: string, summary: UpdateSummary): void {
    this.logger.info("provider_update_complete", {
      reason,
      sha: summary.sha,
      updated: summary.updated.length,
      skipped: summary.skipped.length,
      pending: summary.pending.length,
      retired: summary.retired.length,
      downloadedBytes: summary.downloadedBytes,
      durationMs: summary.durationMs,
    });
  }
}
