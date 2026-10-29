import path from "node:path";
import { z } from "zod";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfig {
  port: number;
  dataDir: string;
  providerSource: string;
  providerBranch: string;
  providerSha: string | null;
  githubToken: string | null;
  updateOnStart: boolean;
  updateIntervalMinHours: number;
  updateIntervalMaxHours: number;
  updateConcurrency: number;
  httpTimeoutMs: number;
  searchConcurrency: number;
  searchTimeoutMs: number;
  metaTimeoutMs: number;
  streamTimeoutMs: number;
  globalDeadlineMs: number;
  settleMs: number;
  emptyFenceMs: number;
  includeMagnets: boolean;
  proxyEnabled: boolean;
  proxySecret: string | null;
  publicBaseUrl: string | null;
  settingsFile: string;
  providerSettingsJson: string | null;
  logLevel: LogLevel;
  cinemetaUrl: string;
  kvFlushMs: number;
  providerCacheTtlMs: number;
  streamCacheTtlMs: number;
}

const envBool = (def: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === "") return def;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "off"].includes(normalized)) return false;
    }
    return value;
  }, z.boolean());

const envInt = (def: number, min: number, max: number) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === "") return def;
      if (typeof value === "number") return value;
      if (typeof value === "string" && value.trim() !== "") return Number(value);
      return value;
    },
    z.number().int().min(min).max(max),
  );

const envNumber = (def: number, min: number, max: number) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === "") return def;
      if (typeof value === "number") return value;
      if (typeof value === "string" && value.trim() !== "") return Number(value);
      return value;
    },
    z.number().min(min).max(max),
  );

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === "" ? null : value));

const schema = z.object({
  PORT: envInt(7000, 1, 65535),
  DATA_DIR: z.string().trim().min(1).default("/data"),
  PROVIDER_SOURCE: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must be owner/repo")
    .default("Zenda-Cross/vega-providers"),
  PROVIDER_BRANCH: z.string().trim().min(1).default("main"),
  PROVIDER_SHA: z
    .string()
    .trim()
    .regex(/^$|^[0-9a-fA-F]{7,40}$/, "must be a git commit sha")
    .default(""),
  GITHUB_TOKEN: optionalString,
  UPDATE_ON_START: envBool(true),
  UPDATE_INTERVAL_MIN_HOURS: envNumber(4, 0.05, 24),
  UPDATE_INTERVAL_MAX_HOURS: envNumber(6, 0.05, 24),
  UPDATE_CONCURRENCY: envInt(8, 1, 32),
  HTTP_TIMEOUT_MS: envInt(15000, 1000, 120000),
  SEARCH_CONCURRENCY: envInt(16, 1, 32),
  SEARCH_TIMEOUT_MS: envInt(10000, 1000, 120000),
  META_TIMEOUT_MS: envInt(15000, 1000, 120000),
  STREAM_TIMEOUT_MS: envInt(20000, 1000, 120000),
  GLOBAL_DEADLINE_MS: envInt(45000, 2000, 300000),
  SETTLE_MS: envInt(8000, 0, 120000),
  EMPTY_FENCE_MS: envInt(0, 0, 300000),
  INCLUDE_MAGNETS: envBool(false),
  PROXY_ENABLED: envBool(false),
  PROXY_SECRET: optionalString,
  PUBLIC_BASE_URL: optionalString,
  SETTINGS_FILE: optionalString,
  PROVIDER_SETTINGS_JSON: optionalString,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  CINEMETA_URL: z.string().url().default("https://v3-cinemeta.strem.io"),
  KV_FLUSH_MS: envInt(500, 0, 60000),
  PROVIDER_CACHE_TTL_MS: envInt(21600000, 1000, 604800000),
  STREAM_CACHE_TTL_MS: envInt(60000, 0, 3600000),
});

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid configuration: ${details}`);
  }

  const value = parsed.data;
  if (value.UPDATE_INTERVAL_MIN_HOURS > value.UPDATE_INTERVAL_MAX_HOURS) {
    throw new ConfigError("UPDATE_INTERVAL_MIN_HOURS must be <= UPDATE_INTERVAL_MAX_HOURS");
  }
  if (value.PROXY_ENABLED && !value.PROXY_SECRET) {
    throw new ConfigError("PROXY_SECRET is required when PROXY_ENABLED=true");
  }
  if (value.PUBLIC_BASE_URL) {
    let url: URL;
    try {
      url = new URL(value.PUBLIC_BASE_URL);
    } catch {
      throw new ConfigError("PUBLIC_BASE_URL must be a valid absolute URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ConfigError("PUBLIC_BASE_URL must use http or https");
    }
  }

  return {
    port: value.PORT,
    dataDir: path.resolve(value.DATA_DIR),
    providerSource: value.PROVIDER_SOURCE,
    providerBranch: value.PROVIDER_BRANCH,
    providerSha: value.PROVIDER_SHA ? value.PROVIDER_SHA.toLowerCase() : null,
    githubToken: value.GITHUB_TOKEN,
    updateOnStart: value.UPDATE_ON_START,
    updateIntervalMinHours: value.UPDATE_INTERVAL_MIN_HOURS,
    updateIntervalMaxHours: value.UPDATE_INTERVAL_MAX_HOURS,
    updateConcurrency: value.UPDATE_CONCURRENCY,
    httpTimeoutMs: value.HTTP_TIMEOUT_MS,
    searchConcurrency: value.SEARCH_CONCURRENCY,
    searchTimeoutMs: value.SEARCH_TIMEOUT_MS,
    metaTimeoutMs: value.META_TIMEOUT_MS,
    streamTimeoutMs: value.STREAM_TIMEOUT_MS,
    globalDeadlineMs: value.GLOBAL_DEADLINE_MS,
    settleMs: value.SETTLE_MS,
    emptyFenceMs: value.EMPTY_FENCE_MS,
    includeMagnets: value.INCLUDE_MAGNETS,
    proxyEnabled: value.PROXY_ENABLED,
    proxySecret: value.PROXY_SECRET,
    publicBaseUrl: value.PUBLIC_BASE_URL ? value.PUBLIC_BASE_URL.replace(/\/+$/, "") : null,
    settingsFile: path.resolve(
      value.SETTINGS_FILE ?? path.join(value.DATA_DIR, "provider-settings.json"),
    ),
    providerSettingsJson: value.PROVIDER_SETTINGS_JSON,
    logLevel: value.LOG_LEVEL,
    cinemetaUrl: value.CINEMETA_URL.replace(/\/+$/, ""),
    kvFlushMs: value.KV_FLUSH_MS,
    providerCacheTtlMs: value.PROVIDER_CACHE_TTL_MS,
    streamCacheTtlMs: value.STREAM_CACHE_TTL_MS,
  };
}
