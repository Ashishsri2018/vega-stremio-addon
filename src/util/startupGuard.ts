import path from "node:path";
import type { LoggerLike } from "../types.js";
import { readJsonFile, writeJsonAtomic } from "./fs.js";

const CRASH_WINDOW_MS = 2 * 60 * 1000;
const MAX_STARTS_PER_WINDOW = 3;

export async function detectCrashLoop(
  dataDir: string,
  logger: LoggerLike,
): Promise<boolean> {
  const file = path.join(dataDir, "startup-history.json");
  const now = Date.now();
  let history: number[] = [];
  try {
    const stored = await readJsonFile<unknown>(file);
    if (Array.isArray(stored)) {
      history = stored.filter(
        (value): value is number => typeof value === "number" && Number.isFinite(value),
      );
    }
  } catch (error) {
    logger.warn("startup_history_read_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  history = history.filter(
    (timestamp) => timestamp <= now && now - timestamp < CRASH_WINDOW_MS,
  );
  history.push(now);

  try {
    await writeJsonAtomic(file, history);
  } catch (error) {
    logger.warn("startup_history_write_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (history.length >= MAX_STARTS_PER_WINDOW) {
    logger.error("startup_crash_loop_detected", {
      starts: history.length,
      windowMs: CRASH_WINDOW_MS,
    });
    return true;
  }
  return false;
}
