import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { createRuntime } from "../runtime.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const runtime = await createRuntime(config, logger);

  try {
    await runtime.updater.preloadFromDisk();
    const summary = await runtime.updater.runOnce("cli");
    await runtime.settings
      .applySchemaDefaults(runtime.registry.listProviders(), runtime.context)
      .catch((error: unknown) => {
        logger.warn("provider_settings_seed_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    logger.info("cli_update_complete", {
      sha: summary.sha,
      updated: summary.updated.length,
      skipped: summary.skipped.length,
      pending: summary.pending.length,
      retired: summary.retired.length,
      downloadedBytes: summary.downloadedBytes,
      durationMs: summary.durationMs,
      providers: runtime.registry.listProviders().length,
    });

    const health = runtime.updater.getHealth();
    process.exitCode = health.status === "error" ? 1 : 0;
  } finally {
    await runtime.dispose();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `update failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
