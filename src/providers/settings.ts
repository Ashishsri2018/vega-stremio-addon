import { promises as fs } from "node:fs";
import type {
  LoggerLike,
  KVStoreApi,
  NormalizedProviderSettings,
  ProviderBundle,
  ProviderContextLike,
  ProviderSettingsFile,
  SettingsManagerApi,
  SettingsSchemaField,
} from "../types.js";
import { mapLimit, withTimeout } from "../util/concurrency.js";

const SKIP_TIMINGS_SUFFIX = "_skipTimings";
const DEFAULT_SCHEMA_TIMEOUT_MS = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaults(): NormalizedProviderSettings {
  return { skipTimings: false, kv: {} };
}

function parseSettingsJson(raw: string, label: string): ProviderSettingsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label} must contain an object`);
  }
  if (
    parsed.skipTimings !== undefined &&
    typeof parsed.skipTimings !== "boolean"
  ) {
    throw new Error("provider settings skipTimings must be a boolean");
  }
  if (parsed.kv !== undefined && !isRecord(parsed.kv)) {
    throw new Error("provider settings kv must be an object");
  }

  return {
    skipTimings: parsed.skipTimings as boolean | undefined,
    kv: parsed.kv as Record<string, unknown> | undefined,
  };
}

async function readSettingsFile(filePath: string): Promise<ProviderSettingsFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  return parseSettingsJson(raw, "provider settings file");
}

export class SettingsManager implements SettingsManagerApi {
  private readonly filePath: string;
  private readonly inlineJson: string | null;
  private readonly kvStore: KVStoreApi;
  private readonly logger: LoggerLike;
  private readonly schemaTimeoutMs: number;
  private current: NormalizedProviderSettings = defaults();
  private explicitKeys = new Set<string>();
  private readonly knownSchemaKeys = new Set<string>();
  private sighupHandler: (() => void) | null = null;
  private disposed = false;

  constructor(options: {
    filePath: string;
    inlineJson?: string | null;
    kvStore: KVStoreApi;
    logger: LoggerLike;
    schemaTimeoutMs?: number;
  }) {
    this.filePath = options.filePath;
    this.inlineJson =
      options.inlineJson && options.inlineJson.trim() !== ""
        ? options.inlineJson
        : null;
    this.kvStore = options.kvStore;
    this.logger = options.logger;
    this.schemaTimeoutMs = options.schemaTimeoutMs ?? DEFAULT_SCHEMA_TIMEOUT_MS;
  }

  get(): NormalizedProviderSettings {
    return {
      skipTimings: this.current.skipTimings,
      kv: { ...this.current.kv },
    };
  }

  async load(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    const source = this.inlineJson !== null ? "env" : "file";
    let parsed: ProviderSettingsFile | null;
    try {
      parsed =
        this.inlineJson !== null
          ? parseSettingsJson(this.inlineJson, "PROVIDER_SETTINGS_JSON")
          : await readSettingsFile(this.filePath);
    } catch (error) {
      this.logger.error("provider_settings_invalid", {
        source,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (parsed === null) {
      this.current = defaults();
      this.explicitKeys = new Set();
      await this.applyConfigToKv(true);
      this.logger.info("provider_settings_loaded", {
        source,
        skipTimings: this.current.skipTimings,
        keyCount: 0,
      });
      return;
    }

    const kv = parsed.kv ?? {};
    this.current = {
      skipTimings: parsed.skipTimings ?? false,
      kv: { ...kv },
    };
    this.explicitKeys = new Set(Object.keys(kv));
    await this.applyConfigToKv(true);
    this.logger.info("provider_settings_loaded", {
      source,
      skipTimings: this.current.skipTimings,
      keyCount: this.explicitKeys.size,
    });
  }

  async applySchemaDefaults(
    bundles: ProviderBundle[],
    context: ProviderContextLike,
  ): Promise<void> {
    const providers = bundles.filter(
      (bundle) =>
        bundle.modules.settings &&
        typeof bundle.modules.settings.getSettingsSchema === "function",
    );

    await mapLimit(providers, 4, async (bundle) => {
      let fields: SettingsSchemaField[] = [];
      try {
        const settings = bundle.modules.settings;
        if (!settings) return;
        const result = await withTimeout(
          Promise.resolve().then(() =>
            settings.getSettingsSchema({ providerContext: context }),
          ),
          this.schemaTimeoutMs,
          `settings schema for ${bundle.entry.value}`,
        );
        if (!Array.isArray(result)) {
          throw new Error("getSettingsSchema did not return an array");
        }
        fields = result as SettingsSchemaField[];
      } catch (error) {
        this.logger.warn("provider_settings_schema_failed", {
          provider: bundle.entry.value,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      for (const field of fields) {
        if (!isRecord(field) || typeof field.key !== "string" || !field.key) continue;
        this.knownSchemaKeys.add(field.key);
        if (!Object.prototype.hasOwnProperty.call(field, "defaultValue")) continue;
        const existing = await this.kvStore.get(field.key);
        if (existing === undefined) {
          await this.kvStore.set(field.key, field.defaultValue);
        }
      }
    });

    await this.applyConfigToKv(false);
  }

  startWatching(): void {
    if (this.sighupHandler || this.disposed) return;
    this.sighupHandler = () => {
      void this.reload().catch((error: unknown) => {
        this.logger.error("provider_settings_reload_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };
    process.on("SIGHUP", this.sighupHandler);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.sighupHandler) {
      process.off("SIGHUP", this.sighupHandler);
      this.sighupHandler = null;
    }
  }

  private async applyConfigToKv(warnUnknown: boolean): Promise<void> {
    const keys = await this.kvStore.keys();
    for (const key of keys) {
      if (!key.endsWith(SKIP_TIMINGS_SUFFIX)) continue;
      if (this.explicitKeys.has(key)) continue;
      if (this.current.skipTimings) continue;
      await this.kvStore.set(key, false);
    }

    for (const [key, value] of Object.entries(this.current.kv)) {
      if (value === undefined) continue;
      if (
        warnUnknown &&
        !key.endsWith(SKIP_TIMINGS_SUFFIX) &&
        !this.knownSchemaKeys.has(key)
      ) {
        this.logger.warn("provider_settings_unknown_key", { key });
      }
      await this.kvStore.set(key, value);
    }
  }
}
