import path from "node:path";
import type { AppConfig } from "./config.js";
import type { LoggerLike, ProviderContextLike } from "./types.js";
import { ensureDir } from "./util/fs.js";
import { nativeFetch } from "./util/nativeFetch.js";
import { KvStore } from "./providers/sdk/kvStore.js";
import { CookieJar } from "./providers/sdk/cookieJar.js";
import { HttpTransport } from "./providers/sdk/http.js";
import {
  clearProviderUrlCache,
  createProviderContext,
  installGlobalFetch,
} from "./providers/sdk/context.js";
import { ProviderRegistry } from "./providers/registry.js";
import { StateStore, providerRootDir } from "./providers/state.js";
import { SourceClient } from "./providers/source.js";
import { Updater } from "./providers/updater.js";
import { SettingsManager } from "./providers/settings.js";

export interface Runtime {
  config: AppConfig;
  logger: LoggerLike;
  kvStore: KvStore;
  cookieJar: CookieJar;
  transport: HttpTransport;
  context: ProviderContextLike;
  registry: ProviderRegistry;
  settings: SettingsManager;
  stateStore: StateStore;
  source: SourceClient;
  updater: Updater;
  dispose(): Promise<void>;
}

export async function createRuntime(config: AppConfig, logger: LoggerLike): Promise<Runtime> {
  await ensureDir(config.dataDir);

  const kvStore = await KvStore.open({
    filePath: path.join(config.dataDir, "kv.json"),
    flushMs: config.kvFlushMs,
    logger,
  });
  const cookieJar = await CookieJar.open({
    filePath: path.join(config.dataDir, "cookies.json"),
    logger,
    flushMs: config.kvFlushMs,
  });
  const transport = new HttpTransport({
    cookieJar,
    logger,
    defaultTimeoutMs: config.httpTimeoutMs,
    fetchImpl: nativeFetch,
  });
  const context = createProviderContext({
    transport,
    kvStore,
    cookieJar,
    logger,
  });
  const registry = new ProviderRegistry({ context, logger });

  installGlobalFetch({
    transport,
    cookieJar,
    logger,
    getActiveUrls: () => registry.getActiveSnapshot()?.urls ?? null,
  });

  const settings = new SettingsManager({
    filePath: config.settingsFile,
    inlineJson: config.providerSettingsJson,
    kvStore,
    logger,
  });
  await settings.load();
  settings.startWatching();

  registry.onActivate((snapshot) => {
    clearProviderUrlCache();
    void settings
      .applySchemaDefaults(Array.from(snapshot.bundles.values()), context)
      .catch((error: unknown) => {
        logger.warn("provider_settings_seed_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });

  const stateStore = new StateStore({
    providerRoot: providerRootDir(config.dataDir, config.providerSource),
    logger,
  });
  const source = new SourceClient({
    repo: config.providerSource,
    branch: config.providerBranch,
    token: config.githubToken,
    logger,
    fetchImpl: nativeFetch,
    timeoutMs: config.httpTimeoutMs,
  });
  const updater = new Updater({ config, logger, registry, stateStore, source });

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    settings.dispose();
    await updater.stop().catch(() => undefined);
    await registry.dispose().catch(() => undefined);
    await cookieJar.dispose().catch(() => undefined);
    await kvStore.dispose().catch(() => undefined);
  };

  return {
    config,
    logger,
    kvStore,
    cookieJar,
    transport,
    context,
    registry,
    settings,
    stateStore,
    source,
    updater,
    dispose,
  };
}
