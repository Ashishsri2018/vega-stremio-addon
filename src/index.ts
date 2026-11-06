import type { Server } from "node:http";
import { configWarnings, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createRuntime } from "./runtime.js";
import { CinemetaClient } from "./cinemeta/client.js";
import { StreamPipeline } from "./pipeline/streamHandler.js";
import { createApp } from "./addon/routes.js";
import { nativeFetch } from "./util/nativeFetch.js";
import { detectCrashLoop } from "./util/startupGuard.js";

const BOOTSTRAP_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  for (const message of configWarnings(config)) {
    logger.warn("config_warning", { message });
  }

  const safeMode = await detectCrashLoop(config.dataDir, logger);
  const runtime = await createRuntime(config, logger);

  const cinemeta = new CinemetaClient({
    baseUrl: config.cinemetaUrl,
    logger,
    fetchImpl: nativeFetch,
    timeoutMs: config.httpTimeoutMs,
  });
  const pipeline = new StreamPipeline({
    config,
    logger,
    registry: runtime.registry,
    cinemeta,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown_started", { signal });
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    if (server) server.close();
    try {
      pipeline.dispose();
      await runtime.dispose();
      logger.info("shutdown_complete", { signal });
      process.exit(process.exitCode ?? 0);
    } catch (error) {
      logger.error("shutdown_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };

  let server: Server | null = null;

  process.on("uncaughtException", (error) => {
    logger.error("uncaught_exception", { error: error.message });
    if (shuttingDown) {
      process.exit(1);
      return;
    }
    void shutdown("uncaught-exception");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled_rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });

  const app = createApp({
    config,
    logger,
    pipeline,
    health: () => {
      const report = runtime.updater.getHealth();
      const snapshot = runtime.registry.getActiveSnapshot();
      return {
        ...report,
        snapshotAgeMs: snapshot ? Date.now() - snapshot.createdAt : null,
      };
    },
    settingsKeys: () => runtime.settings.listConfiguredKeys(),
  });

  server = app.listen(config.port, () => {
    logger.info("server_started", {
      port: config.port,
      dataDir: config.dataDir,
      providers: runtime.registry.listProviders().length,
      activeSha: runtime.registry.getActiveSnapshot()?.sha ?? null,
      safeMode,
    });
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    logger.error("server_error", { code: error.code ?? "unknown", error: error.message });
    process.exitCode = 1;
    void shutdown("server-error");
  });

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  const bootstrap = async (): Promise<void> => {
    if (safeMode) {
      const loaded = await runtime.updater.preloadFromDisk();
      logger.warn("startup_safe_mode", {
        loaded,
        reason: "repeated rapid restarts; automatic provider updates are disabled",
      });
    } else {
      await runtime.updater.bootstrap(BOOTSTRAP_TIMEOUT_MS);
      if (shuttingDown) return;
      runtime.updater.start();
    }

    await runtime.settings
      .applySchemaDefaults(runtime.registry.listProviders(), runtime.context)
      .catch((error: unknown) => {
        logger.warn("provider_settings_seed_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  void bootstrap().catch((error: unknown) => {
    logger.error("bootstrap_failed", {
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
});
