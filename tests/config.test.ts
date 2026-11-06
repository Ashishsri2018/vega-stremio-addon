import { describe, expect, it } from "vitest";
import { ConfigError, configWarnings, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig({});
    expect(config.port).toBe(7000);
    expect(config.dataDir).toBe("/data");
    expect(config.providerSource).toBe("Zenda-Cross/vega-providers");
    expect(config.providerBranch).toBe("main");
    expect(config.providerSha).toBeNull();
    expect(config.updateIntervalMinHours).toBe(4);
    expect(config.updateIntervalMaxHours).toBe(6);
    expect(config.disabledProviders).toEqual([]);
    expect(config.includeMagnets).toBe(false);
    expect(config.proxyEnabled).toBe(false);
    expect(config.logLevel).toBe("info");
    expect(config.settingsFile).toBe("/data/provider-settings.json");
    expect(config.providerSettingsJson).toBeNull();
    expect(config.cinemetaUrl).toBe("https://v3-cinemeta.strem.io");
    expect(config.searchConcurrency).toBe(16);
    expect(config.settleMs).toBe(8000);
    expect(config.emptyFenceMs).toBe(0);
    expect(config.streamRateLimitPerMin).toBe(120);
    expect(config.streamGlobalRateLimitPerMin).toBe(600);
    expect(config.streamMaxConcurrent).toBe(64);
    expect(config.proxyRateLimitPerMin).toBe(240);
    expect(config.proxyGlobalRateLimitPerMin).toBe(1200);
    expect(config.proxyMaxConcurrent).toBe(64);
  });

  it("reads PROVIDER_SETTINGS_JSON and treats blank values as unset", () => {
    const inline = '{"skipTimings":false,"kv":{"gofile_account_token":"abc"}}';
    expect(loadConfig({ PROVIDER_SETTINGS_JSON: inline }).providerSettingsJson).toBe(inline);
    expect(loadConfig({ PROVIDER_SETTINGS_JSON: "   " }).providerSettingsJson).toBeNull();
  });

  it("parses booleans and numbers from strings", () => {
    const config = loadConfig({
      PORT: "8123",
      INCLUDE_MAGNETS: "true",
      UPDATE_INTERVAL_MIN_HOURS: "0.5",
      DATA_DIR: "/srv/vega",
    });
    expect(config.port).toBe(8123);
    expect(config.includeMagnets).toBe(true);
    expect(config.updateIntervalMinHours).toBe(0.5);
    expect(config.settingsFile).toBe("/srv/vega/provider-settings.json");
  });

  it("parses DISABLED_PROVIDERS as a trimmed, deduplicated list", () => {
    expect(
      loadConfig({ DISABLED_PROVIDERS: " torrentio, internetArchive ,, torrentio " })
        .disabledProviders,
    ).toEqual(["torrentio", "internetArchive"]);
    expect(loadConfig({ DISABLED_PROVIDERS: "   " }).disabledProviders).toEqual([]);
  });

  it("rejects invalid provider values in DISABLED_PROVIDERS", () => {
    expect(() => loadConfig({ DISABLED_PROVIDERS: "torrentio,bad/value" })).toThrow(
      ConfigError,
    );
  });

  it("rejects inverted update intervals", () => {
    expect(() =>
      loadConfig({ UPDATE_INTERVAL_MIN_HOURS: "8", UPDATE_INTERVAL_MAX_HOURS: "4" }),
    ).toThrow(ConfigError);
  });

  it("requires PROXY_SECRET when proxy is enabled", () => {
    expect(() => loadConfig({ PROXY_ENABLED: "true" })).toThrow(/PROXY_SECRET/);
    const config = loadConfig({ PROXY_ENABLED: "true", PROXY_SECRET: "secret" });
    expect(config.proxySecret).toBe("secret");
  });

  it("validates PROVIDER_SHA", () => {
    expect(() => loadConfig({ PROVIDER_SHA: "not-a-sha" })).toThrow(ConfigError);
    const config = loadConfig({ PROVIDER_SHA: "ABCDEF1234567" });
    expect(config.providerSha).toBe("abcdef1234567");
  });

  it("validates PUBLIC_BASE_URL", () => {
    expect(() => loadConfig({ PUBLIC_BASE_URL: "ftp://example.com" })).toThrow(ConfigError);
    expect(loadConfig({ PUBLIC_BASE_URL: "https://addon.example.com/" }).publicBaseUrl).toBe(
      "https://addon.example.com",
    );
  });

  it("rejects unknown log levels", () => {
    expect(() => loadConfig({ LOG_LEVEL: "verbose" })).toThrow(ConfigError);
  });

  it("rejects settle and empty-fence values beyond the global deadline", () => {
    expect(() =>
      loadConfig({ SETTLE_MS: "20000", GLOBAL_DEADLINE_MS: "10000" }),
    ).toThrow(/SETTLE_MS/);
    expect(() =>
      loadConfig({ EMPTY_FENCE_MS: "20000", GLOBAL_DEADLINE_MS: "10000" }),
    ).toThrow(/EMPTY_FENCE_MS/);
    expect(loadConfig({ SETTLE_MS: "10000", GLOBAL_DEADLINE_MS: "10000" }).settleMs).toBe(
      10000,
    );
  });

  it("validates PROVIDER_SETTINGS_JSON shape at startup", () => {
    expect(() => loadConfig({ PROVIDER_SETTINGS_JSON: "not json" })).toThrow(
      /PROVIDER_SETTINGS_JSON/,
    );
    expect(() => loadConfig({ PROVIDER_SETTINGS_JSON: "[]" })).toThrow(
      /must contain an object/,
    );
    expect(() =>
      loadConfig({ PROVIDER_SETTINGS_JSON: '{"skipTimings":"yes"}' }),
    ).toThrow(/skipTimings must be a boolean/);
    expect(() =>
      loadConfig({ PROVIDER_SETTINGS_JSON: '{"kv":[]}' }),
    ).toThrow(/kv must be an object/);

    const valid = '{"skipTimings":true,"kv":{"debrid_api_key":"x"}}';
    expect(loadConfig({ PROVIDER_SETTINGS_JSON: valid }).providerSettingsJson).toBe(valid);
  });

  it("warns when the global deadline exceeds the Beamup proxy cutoff", () => {
    const warnings = configWarnings(loadConfig({}));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Beamup");
    expect(configWarnings(loadConfig({ GLOBAL_DEADLINE_MS: "8000" }))).toEqual([]);
  });
});
