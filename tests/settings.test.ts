import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/providers/settings.js";
import type { ProviderBundle } from "../src/types.js";
import {
  MemoryKvStore,
  MemoryLogger,
  createFakeProviderContext,
  fakeBundle,
  waitFor,
} from "./helpers/updateFixtures.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("SettingsManager", () => {
  let tempDir: string;
  let filePath: string;
  let kv: MemoryKvStore;
  let logger: MemoryLogger;
  let manager: SettingsManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vega-settings-"));
    filePath = path.join(tempDir, "provider-settings.json");
    kv = new MemoryKvStore();
    logger = new MemoryLogger();
    manager = new SettingsManager({
      filePath,
      kvStore: kv,
      logger,
      schemaTimeoutMs: 200,
    });
  });

  afterEach(async () => {
    await manager.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeSettings(value: unknown): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(value));
  }

  it("returns defaults when the settings file is missing", async () => {
    await manager.load();
    expect(manager.get()).toEqual({ skipTimings: false, kv: {} });
  });

  it("seeds schema defaults only for missing keys and applies skipTimings last", async () => {
    await kv.set("alpha_skipTimings", true);
    await kv.set("alpha_existing", "user-value");
    await kv.set("gofile_account_token", "provider-written");
    await manager.load();

    const bundles: ProviderBundle[] = [
      fakeBundle("alpha", "1.0.0", () => [
        { key: "alpha_skipTimings", defaultValue: true },
        { key: "alpha_quality", defaultValue: "auto" },
        { key: "alpha_existing", defaultValue: "default" },
        { key: "alpha_no_default" },
      ]),
    ];
    await manager.applySchemaDefaults(bundles, createFakeProviderContext(kv));

    expect(await kv.get("alpha_skipTimings")).toBe(false);
    expect(await kv.get("alpha_quality")).toBe("auto");
    expect(await kv.get("alpha_existing")).toBe("user-value");
    expect(await kv.get("alpha_no_default")).toBeUndefined();
    expect(await kv.get("gofile_account_token")).toBe("provider-written");
    expect(logger.hasEvent("provider_settings_schema_failed")).toBe(false);
  });

  it("applies skipTimings overrides and lets explicit file kv win", async () => {
    await kv.set("foo_skipTimings", true);
    await kv.set("bar_skipTimings", true);
    await kv.set("autoEmbed_skipTimings", true);
    await kv.set("upper_SkipTimings", true);
    await kv.set("gofile_account_token", "provider-written");
    await writeSettings({
      skipTimings: false,
      kv: { foo_skipTimings: true, provider_quality: "manual" },
    });

    await manager.load();

    expect(manager.get().skipTimings).toBe(false);
    expect(await kv.get("foo_skipTimings")).toBe(true);
    expect(await kv.get("bar_skipTimings")).toBe(false);
    expect(await kv.get("autoEmbed_skipTimings")).toBe(false);
    expect(await kv.get("upper_SkipTimings")).toBe(true);
    expect(await kv.get("gofile_account_token")).toBe("provider-written");
    expect(await kv.get("provider_quality")).toBe("manual");
    expect(manager.get().kv).toEqual({
      foo_skipTimings: true,
      provider_quality: "manual",
    });
  });

  it("leaves existing skipTimings values alone when skipTimings is true", async () => {
    await kv.set("foo_skipTimings", true);
    await kv.set("bar_skipTimings", false);
    await writeSettings({ skipTimings: true });

    await manager.load();

    expect(manager.get().skipTimings).toBe(true);
    expect(await kv.get("foo_skipTimings")).toBe(true);
    expect(await kv.get("bar_skipTimings")).toBe(false);
  });

  it("never overwrites an existing value with a schema default and lets explicit kv win", async () => {
    await writeSettings({ kv: { alpha_quality: "manual" } });
    await manager.load();
    await kv.set("beta_quality", "already-set");

    const bundles: ProviderBundle[] = [
      fakeBundle("alpha", "1.0.0", () => [
        { key: "alpha_quality", defaultValue: "auto" },
      ]),
      fakeBundle("beta", "1.0.0", () => [
        { key: "beta_quality", defaultValue: "schema-default" },
      ]),
    ];
    await manager.applySchemaDefaults(bundles, createFakeProviderContext(kv));

    expect(await kv.get("alpha_quality")).toBe("manual");
    expect(await kv.get("beta_quality")).toBe("already-set");
    expect(manager.get().kv.alpha_quality).toBe("manual");
  });

  it("keeps the last good configuration when the file is malformed", async () => {
    await writeSettings({ skipTimings: false, kv: { good_key: "good" } });
    await manager.load();
    expect(manager.get().kv.good_key).toBe("good");

    await fs.writeFile(filePath, "{ not json");
    await manager.load();
    expect(manager.get().kv.good_key).toBe("good");
    expect(logger.hasEvent("provider_settings_invalid", "error")).toBe(true);

    await writeSettings({ skipTimings: "yes", kv: {} });
    await manager.load();
    expect(manager.get().kv.good_key).toBe("good");
    expect(
      logger.entries.filter(
        (entry) =>
          entry.event === "provider_settings_invalid" && entry.level === "error",
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("prefers inline JSON from PROVIDER_SETTINGS_JSON over the settings file", async () => {
    await writeSettings({ kv: { from_file: "file-value" } });
    const inlineManager = new SettingsManager({
      filePath,
      inlineJson: JSON.stringify({
        skipTimings: true,
        kv: { from_env: "env-value" },
      }),
      kvStore: kv,
      logger,
    });
    try {
      await inlineManager.load();
      expect(inlineManager.get()).toEqual({
        skipTimings: true,
        kv: { from_env: "env-value" },
      });
      expect(await kv.get("from_env")).toBe("env-value");
      expect(await kv.get("from_file")).toBeUndefined();
      const loaded = logger.entries.find(
        (entry) => entry.event === "provider_settings_loaded",
      );
      expect(loaded?.fields?.source).toBe("env");
    } finally {
      await inlineManager.dispose();
    }
  });

  it("keeps the last good configuration when inline JSON is malformed", async () => {
    const inlineManager = new SettingsManager({
      filePath,
      inlineJson: "{ not json",
      kvStore: kv,
      logger,
    });
    try {
      await inlineManager.load();
      expect(inlineManager.get()).toEqual({ skipTimings: false, kv: {} });
      const invalid = logger.entries.find(
        (entry) => entry.event === "provider_settings_invalid",
      );
      expect(invalid?.level).toBe("error");
      expect(invalid?.fields?.source).toBe("env");
    } finally {
      await inlineManager.dispose();
    }
  });

  it("falls back to the file when inline JSON is empty", async () => {
    await writeSettings({ kv: { from_file: 1 } });
    const inlineManager = new SettingsManager({
      filePath,
      inlineJson: "   ",
      kvStore: kv,
      logger,
    });
    try {
      await inlineManager.load();
      expect(inlineManager.get().kv).toEqual({ from_file: 1 });
    } finally {
      await inlineManager.dispose();
    }
  });

  it("reloads on SIGHUP and removes the listener on dispose", async () => {
    await manager.load();
    manager.startWatching();

    await writeSettings({ skipTimings: true, kv: { live_key: 1 } });
    process.emit("SIGHUP");
    await waitFor(() => manager.get().kv.live_key === 1);
    expect(manager.get().skipTimings).toBe(true);
    expect(await kv.get("live_key")).toBe(1);

    await manager.dispose();
    await writeSettings({ skipTimings: false, kv: { live_key: 2 } });
    process.emit("SIGHUP");
    await sleep(100);
    expect(manager.get().kv.live_key).toBe(1);
  });

  it("times out slow provider schemas without blocking other providers", async () => {
    const slowManager = new SettingsManager({
      filePath,
      kvStore: kv,
      logger,
      schemaTimeoutMs: 20,
    });
    try {
      await slowManager.load();
      const bundles: ProviderBundle[] = [
        fakeBundle("good", "1.0.0", () => [
          { key: "good_quality", defaultValue: "auto" },
        ]),
        fakeBundle("slow", "1.0.0", () => new Promise(() => undefined)),
      ];

      await slowManager.applySchemaDefaults(
        bundles,
        createFakeProviderContext(kv),
      );

      expect(await kv.get("good_quality")).toBe("auto");
      expect(logger.hasEvent("provider_settings_schema_failed", "warn")).toBe(
        true,
      );
    } finally {
      await slowManager.dispose();
    }
  });

  it("warns about unknown explicit keys but still stores them", async () => {
    await writeSettings({ kv: { mystery_key: 42, alpha_skipTimings: false } });
    await manager.load();

    expect(await kv.get("mystery_key")).toBe(42);
    const warning = logger.entries.find(
      (entry) => entry.event === "provider_settings_unknown_key",
    );
    expect(warning?.fields?.key).toBe("mystery_key");
    expect(
      logger.entries.some(
        (entry) =>
          entry.event === "provider_settings_unknown_key" &&
          entry.fields?.key === "alpha_skipTimings",
      ),
    ).toBe(false);
  });
});
