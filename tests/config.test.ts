import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

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
    expect(config.includeMagnets).toBe(false);
    expect(config.proxyEnabled).toBe(false);
    expect(config.logLevel).toBe("info");
    expect(config.settingsFile).toBe("/data/provider-settings.json");
    expect(config.providerSettingsJson).toBeNull();
    expect(config.cinemetaUrl).toBe("https://v3-cinemeta.strem.io");
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
});
