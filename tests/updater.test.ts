import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { SourceClient } from "../src/providers/source.js";
import { StateStore, providerRootDir } from "../src/providers/state.js";
import { Updater } from "../src/providers/updater.js";
import { nativeFetch } from "../src/util/nativeFetch.js";
import { fileExists } from "../src/util/fs.js";
import {
  MemoryLogger,
  SHA_A,
  SHA_B,
  SHA_C,
  UpdateFixtureServer,
  createFakeProviderContext,
  createTestConfig,
  makeFixtureProvider,
  makeTempDir,
  moduleSource,
} from "./helpers/updateFixtures.js";

describe("Updater", () => {
  let fixture: UpdateFixtureServer;
  let cleanups: Array<() => Promise<void>>;

  beforeEach(async () => {
    fixture = await UpdateFixtureServer.start();
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup().catch(() => undefined);
    }
    await fixture.close();
  });

  async function setup(overrides: Partial<AppConfig> = {}) {
    const dataDir = await makeTempDir("vega-updater-");
    const config = createTestConfig(dataDir, fixture.repo, overrides);
    const logger = new MemoryLogger();
    const providerRoot = providerRootDir(dataDir, fixture.repo);
    const stateStore = new StateStore({ providerRoot, logger });
    const context = createFakeProviderContext();
    const registry = new ProviderRegistry({ context, logger });
    const source = new SourceClient({
      repo: fixture.repo,
      branch: fixture.branch,
      logger,
      fetchImpl: nativeFetch,
      apiBaseUrl: fixture.apiBaseUrl,
      rawBaseUrl: fixture.rawBaseUrl,
      timeoutMs: 5000,
    });
    const updater = new Updater({ config, logger, registry, stateStore, source });

    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    cleanups.push(() => registry.dispose());
    cleanups.push(() => updater.stop());

    return {
      dataDir,
      config,
      logger,
      providerRoot,
      stateStore,
      context,
      registry,
      source,
      updater,
    };
  }

  function installSnapshotA(optional = false): void {
    fixture.setSnapshot(SHA_A, {
      providers: [
        makeFixtureProvider("alpha", "1.0.0", { optional }),
        makeFixtureProvider("beta", "1.0.0"),
      ],
    });
    fixture.setHead(SHA_A);
  }

  it("installs providers, writes state and snapshot files", async () => {
    installSnapshotA(true);
    const h = await setup();

    await h.updater.bootstrap(5000);

    const active = h.registry.getActiveSnapshot();
    expect(active?.sha).toBe(SHA_A);
    expect(Array.from(active?.bundles.keys() ?? []).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    expect(active?.bundles.get("alpha")?.modules.settings).toBeDefined();
    expect(active?.bundles.get("alpha")?.modules.episodes).toBeDefined();

    const state = h.updater.getState();
    expect(state.activeSha).toBe(SHA_A);
    expect(state.lastCheck).toBeTruthy();
    expect(state.lastSuccess).toBeTruthy();
    expect(state.nextCheck).toBeTruthy();
    expect(state.headEtag).toContain(SHA_A);
    expect(state.providers.alpha).toMatchObject({
      sha: SHA_A,
      version: "1.0.0",
      status: "active",
      error: null,
    });
    expect(state.providers.beta.status).toBe("active");

    expect(
      await fileExists(path.join(h.providerRoot, SHA_A, "manifest.json")),
    ).toBe(true);
    expect(
      await fileExists(path.join(h.providerRoot, SHA_A, "urls.json")),
    ).toBe(true);
    expect(
      await fileExists(path.join(h.providerRoot, SHA_A, "alpha", "stream.js")),
    ).toBe(true);
    expect(
      await fileExists(path.join(h.providerRoot, SHA_A, "alpha", "settings.js")),
    ).toBe(true);
    expect(await fileExists(path.join(h.providerRoot, "update.lock"))).toBe(false);
    expect(h.updater.getHealth().status).toBe("ok");
  });

  it("does not download anything when the SHA is unchanged", async () => {
    installSnapshotA();
    const h = await setup();
    await h.updater.bootstrap(5000);
    fixture.resetCounts();

    const summary = await h.updater.runOnce("noop");

    expect(summary.updated).toEqual([]);
    expect(summary.pending).toEqual([]);
    expect(summary.skipped).toEqual(["alpha", "beta"]);
    expect(fixture.counts.commits).toBe(1);
    expect(fixture.counts.rawFiles).toBe(0);
    expect(h.registry.getActiveSnapshot()?.sha).toBe(SHA_A);
  });

  it("preloads the installed snapshot from disk without any network access", async () => {
    installSnapshotA();
    const h = await setup();
    await h.updater.bootstrap(5000);

    const logger = new MemoryLogger();
    const stateStore = new StateStore({ providerRoot: h.providerRoot, logger });
    const registry = new ProviderRegistry({ context: h.context, logger });
    const updater = new Updater({
      config: h.config,
      logger,
      registry,
      stateStore,
      source: h.source,
    });
    cleanups.push(() => registry.dispose());
    cleanups.push(() => updater.stop());

    fixture.resetCounts();
    expect(await updater.preloadFromDisk()).toBe(true);
    expect(registry.getActiveSnapshot()?.sha).toBe(SHA_A);
    expect(registry.listProviders().map((bundle) => bundle.entry.value).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    expect(fixture.counts.commits).toBe(0);
    expect(fixture.counts.rawFiles).toBe(0);
  });

  it("re-downloads all enabled providers when the SHA changes", async () => {
    installSnapshotA();
    const h = await setup();
    await h.updater.bootstrap(5000);

    fixture.setSnapshot(SHA_B, {
      providers: [
        makeFixtureProvider("alpha", "2.0.0"),
        makeFixtureProvider("beta", "2.0.0"),
      ],
    });
    fixture.setHead(SHA_B);
    fixture.resetCounts();

    const summary = await h.updater.runOnce("sha-change");

    expect(summary.sha).toBe(SHA_B);
    expect(summary.updated).toEqual(["alpha", "beta"]);
    expect(summary.pending).toEqual([]);
    expect(fixture.counts.byPath["dist/alpha/posts.js"]).toBe(1);
    expect(fixture.counts.byPath["dist/alpha/meta.js"]).toBe(1);
    expect(fixture.counts.byPath["dist/alpha/stream.js"]).toBe(1);
    expect(fixture.counts.byPath["dist/beta/posts.js"]).toBe(1);
    expect(fixture.counts.byPath["dist/beta/meta.js"]).toBe(1);
    expect(fixture.counts.byPath["dist/beta/stream.js"]).toBe(1);

    const active = h.registry.getActiveSnapshot();
    expect(active?.sha).toBe(SHA_B);
    expect(active?.rootDir).toBe(path.join(h.providerRoot, SHA_B));
    expect(active?.bundles.get("alpha")?.entry.version).toBe("2.0.0");
    expect(active?.bundles.get("beta")?.entry.version).toBe("2.0.0");
    expect(h.updater.getState().previousSha).toBe(SHA_A);
  });

  it("keeps the old bundle as pending on a version header mismatch and retries without a SHA change", async () => {
    installSnapshotA();
    const h = await setup();
    await h.updater.bootstrap(5000);

    fixture.setSnapshot(SHA_B, {
      providers: [
        makeFixtureProvider("alpha", "2.0.0"),
        makeFixtureProvider("beta", "2.0.0", {
          modules: { posts: moduleSource("beta", "9.9.9", "posts") },
        }),
      ],
    });
    fixture.setHead(SHA_B);

    const first = await h.updater.runOnce("bad-header");
    expect(first.sha).toBe(SHA_B);
    expect(first.updated).toEqual(["alpha"]);
    expect(first.pending).toEqual(["beta"]);

    let active = h.registry.getActiveSnapshot();
    expect(active?.sha).toBe(SHA_B);
    expect(active?.bundles.get("alpha")?.entry.version).toBe("2.0.0");
    expect(active?.bundles.get("beta")?.entry.version).toBe("1.0.0");
    let state = h.updater.getState();
    expect(state.providers.beta.status).toBe("pending");
    expect(state.providers.beta.sha).toBe(SHA_A);
    expect(state.providers.beta.error).toMatch(/@vega-version/);
    expect(h.updater.getHealth().status).toBe("degraded");
    expect(h.updater.getHealth().pending).toEqual(["beta"]);

    fixture.setFile(
      SHA_B,
      "dist/beta/posts.js",
      moduleSource("beta", "2.0.0", "posts"),
    );
    fixture.resetCounts();
    const second = await h.updater.runOnce("retry-pending");

    expect(fixture.counts.commits).toBe(1);
    expect(fixture.counts.byPath["dist/alpha/posts.js"]).toBeUndefined();
    expect(fixture.counts.byPath["dist/beta/posts.js"]).toBe(1);
    expect(second.updated).toEqual(["beta"]);
    expect(second.pending).toEqual([]);
    expect(second.skipped).toEqual(["alpha"]);

    active = h.registry.getActiveSnapshot();
    expect(active?.sha).toBe(SHA_B);
    expect(active?.bundles.get("beta")?.entry.version).toBe("2.0.0");
    state = h.updater.getState();
    expect(state.providers.beta.status).toBe("active");
    expect(state.providers.beta.sha).toBe(SHA_B);
    expect(state.providers.beta.error).toBeNull();
    expect(h.updater.getHealth().status).toBe("ok");
  });

  it("rejects a provider that is missing a required module", async () => {
    installSnapshotA();
    const h = await setup();
    await h.updater.bootstrap(5000);

    fixture.setSnapshot(SHA_B, {
      providers: [
        makeFixtureProvider("alpha", "2.0.0", { modules: { stream: null } }),
        makeFixtureProvider("beta", "2.0.0"),
      ],
    });
    fixture.setHead(SHA_B);

    const summary = await h.updater.runOnce("missing-module");

    expect(summary.updated).toEqual(["beta"]);
    expect(summary.pending).toEqual(["alpha"]);
    const active = h.registry.getActiveSnapshot();
    expect(active?.bundles.get("alpha")?.entry.version).toBe("1.0.0");
    expect(active?.bundles.get("beta")?.entry.version).toBe("2.0.0");
    const state = h.updater.getState();
    expect(state.providers.alpha.status).toBe("pending");
    expect(state.providers.alpha.error).toMatch(/missing required module stream/);
    expect(state.providers.beta.status).toBe("active");
  });

  it("installs new providers and retires removed providers", async () => {
    installSnapshotA();
    const h = await setup();
    await h.updater.bootstrap(5000);

    fixture.setSnapshot(SHA_B, {
      providers: [
        makeFixtureProvider("beta", "2.0.0"),
        makeFixtureProvider("gamma", "1.0.0"),
      ],
    });
    fixture.setHead(SHA_B);

    const summary = await h.updater.runOnce("provider-set-change");

    expect(summary.updated).toEqual(["beta", "gamma"]);
    expect(summary.retired).toEqual(["alpha"]);
    const active = h.registry.getActiveSnapshot();
    expect(Array.from(active?.bundles.keys() ?? []).sort()).toEqual([
      "beta",
      "gamma",
    ]);
    expect(active?.bundles.has("alpha")).toBe(false);
    expect(h.updater.getState().providers.alpha).toBeUndefined();
    expect(h.registry.previousSnapshot()?.sha).toBe(SHA_A);
    expect(await fileExists(path.join(h.providerRoot, SHA_A))).toBe(true);
  });

  it("merges urls.json values missing from the new snapshot", async () => {
    fixture.setSnapshot(SHA_A, {
      providers: [makeFixtureProvider("alpha", "1.0.0")],
      urls: {
        shared: { url: "https://a.example" },
        onlyA: { url: "https://only-a.example" },
      },
    });
    fixture.setHead(SHA_A);
    const h = await setup();
    await h.updater.bootstrap(5000);
    expect(h.registry.getActiveSnapshot()?.urls.onlyA?.url).toBe(
      "https://only-a.example",
    );

    fixture.setSnapshot(SHA_B, {
      providers: [makeFixtureProvider("alpha", "2.0.0")],
      urls: { shared: { url: "https://b.example" } },
    });
    fixture.setHead(SHA_B);
    await h.updater.runOnce("urls-merge");

    const active = h.registry.getActiveSnapshot();
    expect(active?.urls.shared?.url).toBe("https://b.example");
    expect(active?.urls.onlyA?.url).toBe("https://only-a.example");
  });

  it("installs the pinned PROVIDER_SHA without asking the API for HEAD", async () => {
    fixture.setSnapshot(SHA_A, {
      providers: [makeFixtureProvider("alpha", "1.0.0")],
    });
    fixture.setSnapshot(SHA_B, {
      providers: [makeFixtureProvider("alpha", "2.0.0")],
    });
    fixture.setHead(SHA_B);
    const h = await setup({ providerSha: SHA_A });

    await h.updater.bootstrap(5000);

    const active = h.registry.getActiveSnapshot();
    expect(active?.sha).toBe(SHA_A);
    expect(active?.bundles.get("alpha")?.entry.version).toBe("1.0.0");
    expect(fixture.counts.commits).toBe(0);
    expect(h.updater.getState().activeSha).toBe(SHA_A);
    expect(h.updater.getState().providers.alpha.sha).toBe(SHA_A);
  });

  it("activates exactly once with a complete bundle map and keeps old leases working", async () => {
    installSnapshotA();
    const h = await setup();
    await h.updater.bootstrap(5000);

    const lease = h.registry.acquire();
    expect(lease.snapshot?.sha).toBe(SHA_A);
    const oldBundle = lease.snapshot?.bundles.get("alpha");

    const activations: string[] = [];
    const sizes: number[] = [];
    h.registry.onActivate((snapshot) => {
      activations.push(snapshot.sha);
      sizes.push(snapshot.bundles.size);
      for (const bundle of snapshot.bundles.values()) {
        expect(typeof bundle.modules.posts.getSearchPosts).toBe("function");
        expect(typeof bundle.modules.meta.getMeta).toBe("function");
        expect(typeof bundle.modules.stream.getStream).toBe("function");
      }
    });

    fixture.setSnapshot(SHA_B, {
      providers: [
        makeFixtureProvider("alpha", "2.0.0"),
        makeFixtureProvider("beta", "2.0.0"),
      ],
    });
    fixture.setHead(SHA_B);
    await h.updater.runOnce("atomic");

    expect(activations).toEqual([SHA_B]);
    expect(sizes).toEqual([2]);

    const posts = await oldBundle?.modules.posts.getSearchPosts({
      searchQuery: "movie",
      page: 1,
      providerValue: "alpha",
      providerContext: h.context,
    });
    expect(posts?.[0]?.title).toContain("alpha");
    lease.release();
    lease.release();

    const health = h.updater.getHealth();
    expect(health).toMatchObject({
      status: "ok",
      activeSha: SHA_B,
      providerCount: 2,
      pending: [],
      lastError: null,
    });
    expect(health.providers.alpha).toEqual({
      version: "2.0.0",
      status: "active",
    });
    expect(health.lastCheck).toBeTruthy();
    expect(health.lastSuccess).toBeTruthy();
    expect(health.nextCheck).toBeTruthy();
    expect(JSON.stringify(health)).not.toContain("http");
    expect(JSON.stringify(health)).not.toContain("token");
  });

  it("keeps the old bundle as pending when a provider module throws at require time", async () => {
    installSnapshotA();
    const h = await setup();
    await h.updater.bootstrap(5000);

    const throwingModule =
      "// @vega-provider beta\n// @vega-version 2.0.0\nthrow new Error(\"top-level boom\");\n";
    fixture.setSnapshot(SHA_B, {
      providers: [
        makeFixtureProvider("alpha", "2.0.0"),
        makeFixtureProvider("beta", "2.0.0", {
          modules: { stream: throwingModule },
        }),
      ],
    });
    fixture.setHead(SHA_B);

    const summary = await h.updater.runOnce("require-throw");

    expect(summary.updated).toEqual(["alpha"]);
    expect(summary.pending).toEqual(["beta"]);
    const active = h.registry.getActiveSnapshot();
    expect(active?.bundles.get("alpha")?.entry.version).toBe("2.0.0");
    expect(active?.bundles.get("beta")?.entry.version).toBe("1.0.0");
    const state = h.updater.getState();
    expect(state.providers.beta.status).toBe("pending");
    expect(state.providers.beta.error).toMatch(/top-level boom/);
  });

  it("falls back to raw branch downloads when the GitHub API fails", async () => {
    installSnapshotA();
    fixture.setApiStatus(500);
    const h = await setup();

    const first = await h.updater.runOnce("fallback");
    const active = h.registry.getActiveSnapshot();

    expect(active?.sha).toMatch(/^branch-[a-f0-9]+$/);
    expect(active?.bundles.get("alpha")?.entry.version).toBe("1.0.0");
    expect(active?.bundles.get("beta")?.entry.version).toBe("1.0.0");
    expect(first.sha).toBe(active?.sha);
    expect(h.updater.getState().activeSha).toBe(active?.sha);
    expect(h.updater.getState().headEtag).toBeNull();
    expect(fixture.counts.commits).toBe(1);

    fixture.resetCounts();
    const second = await h.updater.runOnce("fallback-noop");

    expect(second.sha).toBe(active?.sha);
    expect(second.updated).toEqual([]);
    expect(fixture.counts.byPath["manifest.json"]).toBe(1);
    expect(fixture.counts.byPath["urls.json"]).toBe(1);
    expect(fixture.counts.byPath["dist/alpha/posts.js"]).toBeUndefined();
    expect(fixture.counts.byPath["dist/beta/posts.js"]).toBeUndefined();
  });

  it("does not overlap runs when the lock file is present", async () => {
    installSnapshotA();
    const h = await setup();
    await h.updater.bootstrap(5000);

    const lockPath = path.join(h.providerRoot, "update.lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 99999, startedAt: new Date().toISOString() }),
    );
    fixture.resetCounts();
    const summary = await h.updater.runOnce("locked");

    expect(summary.updated).toEqual([]);
    expect(fixture.counts.commits).toBe(0);
    expect(fixture.counts.rawFiles).toBe(0);
    expect(h.registry.getActiveSnapshot()?.sha).toBe(SHA_A);

    await fs.unlink(lockPath);
    fixture.resetCounts();
    await h.updater.runOnce("unlocked");
    expect(fixture.counts.commits).toBe(1);
  });

  it("keeps only active and previous snapshot directories", async () => {
    installSnapshotA();
    const h = await setup();
    await h.updater.bootstrap(5000);

    fixture.setSnapshot(SHA_B, {
      providers: [
        makeFixtureProvider("alpha", "2.0.0"),
        makeFixtureProvider("beta", "2.0.0"),
      ],
    });
    fixture.setHead(SHA_B);
    await h.updater.runOnce("to-b");

    const staleDir = path.join(h.providerRoot, SHA_C);
    await fs.mkdir(staleDir, { recursive: true });
    await fs.writeFile(path.join(staleDir, "manifest.json"), "[]");

    await h.updater.runOnce("cleanup");

    expect(await fileExists(path.join(h.providerRoot, SHA_A))).toBe(true);
    expect(await fileExists(path.join(h.providerRoot, SHA_B))).toBe(true);
    expect(await fileExists(staleDir)).toBe(false);
  });

  it("reuses a complete on-disk snapshot on bootstrap without network access", async () => {
    installSnapshotA();
    const first = await setup();
    await first.updater.bootstrap(5000);

    fixture.resetCounts();
    const logger2 = new MemoryLogger();
    const registry2 = new ProviderRegistry({
      context: createFakeProviderContext(),
      logger: logger2,
    });
    const stateStore2 = new StateStore({
      providerRoot: first.providerRoot,
      logger: logger2,
    });
    const source2 = new SourceClient({
      repo: fixture.repo,
      branch: fixture.branch,
      logger: logger2,
      fetchImpl: nativeFetch,
      apiBaseUrl: fixture.apiBaseUrl,
      rawBaseUrl: fixture.rawBaseUrl,
      timeoutMs: 5000,
    });
    const updater2 = new Updater({
      config: first.config,
      logger: logger2,
      registry: registry2,
      stateStore: stateStore2,
      source: source2,
    });
    cleanups.push(() => registry2.dispose());
    cleanups.push(() => updater2.stop());

    await updater2.bootstrap(5000);

    expect(registry2.getActiveSnapshot()?.sha).toBe(SHA_A);
    expect(Array.from(registry2.getActiveSnapshot()?.bundles.keys() ?? []).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    expect(fixture.counts.commits).toBe(0);
    expect(fixture.counts.rawFiles).toBe(0);
  });
});
