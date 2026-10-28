import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createRuntime } from "./runtime.js";
import { CinemetaClient } from "./cinemeta/client.js";
import { StreamPipeline } from "./pipeline/streamHandler.js";
import { createApp } from "./addon/routes.js";
import { nativeFetch } from "./util/nativeFetch.js";

const BOOTSTRAP_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const runtime = await createRuntime(config, logger);

  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled_rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });
  process.on("uncaughtException", (error) => {
    logger.error("uncaught_exception", { error: error.message });
  });

  await runtime.updater.bootstrap(BOOTSTRAP_TIMEOUT_MS);
  await runtime.settings
    .applySchemaDefaults(runtime.registry.listProviders(), runtime.context)
    .catch((error: unknown) => {
      logger.warn("provider_settings_seed_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

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
  const app = createApp({
    config,
    logger,
    pipeline,
    health: () => runtime.updater.getHealth(),
  });

  const server = app.listen(config.port, () => {
    logger.info("server_started", {
      port: config.port,
      dataDir: config.dataDir,
      providers: runtime.registry.listProviders().length,
      activeSha: runtime.registry.getActiveSnapshot()?.sha ?? null,
    });
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    logger.error("server_error", { code: error.code ?? "unknown", error: error.message });
    process.exitCode = 1;
    void shutdown("server-error");
  });

  runtime.updater.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown_started", { signal });
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close();
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

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
});
