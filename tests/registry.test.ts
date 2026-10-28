import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { ProviderSnapshot } from "../src/types.js";
import {
  MemoryLogger,
  createFakeProviderContext,
  fakeBundle,
} from "./helpers/updateFixtures.js";

const nodeRequire = createRequire(import.meta.url);

function makeSnapshot(sha: string, rootDir: string): ProviderSnapshot {
  return {
    sha,
    rootDir,
    urls: {},
    bundles: new Map([
      ["alpha", fakeBundle("alpha", "1.0.0", null)],
      ["beta", fakeBundle("beta", "1.0.0", null)],
    ]),
    createdAt: Date.now(),
  };
}

describe("ProviderRegistry", () => {
  let tempDir: string;
  let rootA: string;
  let rootB: string;
  let rootC: string;
  let logger: MemoryLogger;
  let registry: ProviderRegistry;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vega-registry-"));
    rootA = path.join(tempDir, "a");
    rootB = path.join(tempDir, "b");
    rootC = path.join(tempDir, "c");
    await Promise.all([
      fs.mkdir(rootA, { recursive: true }),
      fs.mkdir(rootB, { recursive: true }),
      fs.mkdir(rootC, { recursive: true }),
    ]);
    logger = new MemoryLogger();
    registry = new ProviderRegistry({
      context: createFakeProviderContext(),
      logger,
      gracePeriodMs: 60_000,
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await registry.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("keeps old modules loaded until the last lease is released", async () => {
    const modulePath = path.join(rootA, "alpha.js");
    await fs.writeFile(modulePath, 'module.exports = { value: "alpha" };\n');
    nodeRequire(modulePath);

    const snapshotA = makeSnapshot("a", rootA);
    const snapshotB = makeSnapshot("b", rootB);
    registry.activate(snapshotA);
    expect(registry.listProviders().map((bundle) => bundle.entry.value)).toEqual([
      "alpha",
      "beta",
    ]);

    const lease = registry.acquire();
    expect(lease.snapshot).toBe(snapshotA);

    registry.activate(snapshotB);
    expect(registry.getActiveSnapshot()).toBe(snapshotB);
    expect(registry.previousSnapshot()).toBe(snapshotA);
    expect(nodeRequire.cache[modulePath]).toBeDefined();

    lease.release();
    expect(nodeRequire.cache[modulePath]).toBeUndefined();
    lease.release();
  });

  it("returns a null lease when no snapshot is active", () => {
    const lease = registry.acquire();
    expect(lease.snapshot).toBeNull();
    expect(() => lease.release()).not.toThrow();
  });

  it("fires activation listeners and contains listener errors", () => {
    const events: string[] = [];
    const unsubscribe = registry.onActivate((snapshot) => {
      events.push(snapshot.sha);
      throw new Error("listener boom");
    });
    registry.onActivate((snapshot) => {
      events.push(`second-${snapshot.sha}`);
    });

    expect(() => registry.activate(makeSnapshot("a", rootA))).not.toThrow();
    expect(events).toEqual(["a", "second-a"]);
    expect(logger.hasEvent("provider_registry_listener_failed", "error")).toBe(true);

    unsubscribe();
    registry.activate(makeSnapshot("b", rootB));
    expect(events).toEqual(["a", "second-a", "second-b"]);
  });

  it("tracks previous snapshots across activations", () => {
    const snapshotA = makeSnapshot("a", rootA);
    const snapshotB = makeSnapshot("b", rootB);
    const snapshotC = makeSnapshot("c", rootC);

    registry.activate(snapshotA);
    expect(registry.previousSnapshot()).toBeNull();
    registry.activate(snapshotB);
    expect(registry.previousSnapshot()).toBe(snapshotA);
    registry.activate(snapshotC);
    expect(registry.previousSnapshot()).toBe(snapshotB);
    expect(registry.getActiveSnapshot()).toBe(snapshotC);
  });

  it("purges retired require.cache entries after the grace period", async () => {
    vi.useFakeTimers();
    const local = new ProviderRegistry({
      context: createFakeProviderContext(),
      logger,
      gracePeriodMs: 1000,
    });
    try {
      const modulePath = path.join(rootA, "grace.js");
      await fs.writeFile(modulePath, "module.exports = 1;\n");
      nodeRequire(modulePath);

      local.activate(makeSnapshot("a", rootA));
      const lease = local.acquire();
      local.activate(makeSnapshot("b", rootB));
      expect(nodeRequire.cache[modulePath]).toBeDefined();

      vi.advanceTimersByTime(1000);
      expect(nodeRequire.cache[modulePath]).toBeUndefined();
      lease.release();
    } finally {
      await local.dispose();
      vi.useRealTimers();
    }
  });

  it("dispose clears timers, purges modules and drops the active snapshot", async () => {
    vi.useFakeTimers();
    const moduleA = path.join(rootA, "dispose-a.js");
    const moduleB = path.join(rootB, "dispose-b.js");
    await fs.writeFile(moduleA, "module.exports = 1;\n");
    await fs.writeFile(moduleB, "module.exports = 2;\n");
    nodeRequire(moduleA);
    nodeRequire(moduleB);

    const local = new ProviderRegistry({
      context: createFakeProviderContext(),
      logger,
      gracePeriodMs: 1000,
    });
    local.activate(makeSnapshot("a", rootA));
    const lease = local.acquire();
    local.activate(makeSnapshot("b", rootB));
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await local.dispose();

    expect(vi.getTimerCount()).toBe(0);
    expect(local.getActiveSnapshot()).toBeNull();
    expect(local.previousSnapshot()).toBeNull();
    expect(nodeRequire.cache[moduleA]).toBeUndefined();
    expect(nodeRequire.cache[moduleB]).toBeUndefined();
    lease.release();
    vi.useRealTimers();
  });
});
