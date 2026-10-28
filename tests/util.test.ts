import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mapLimit,
  mapLimitSettled,
  Semaphore,
  TimeoutError,
  withTimeout,
} from "../src/util/concurrency.js";
import { TtlCache } from "../src/util/cache.js";
import { readJsonFile, writeJsonAtomic } from "../src/util/fs.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vega-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("fs helpers", () => {
  it("writes and reads JSON atomically", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "nested", "state.json");
    await writeJsonAtomic(file, { hello: "world" });
    await expect(readJsonFile(file)).resolves.toEqual({ hello: "world" });
    expect(await readFile(file, "utf8")).toContain("\n");
  });

  it("returns null for missing files", async () => {
    const dir = await tempDir();
    await expect(readJsonFile(path.join(dir, "missing.json"))).resolves.toBeNull();
  });
});

describe("concurrency helpers", () => {
  it("limits mapLimit concurrency and preserves order", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapLimit([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("mapLimitSettled captures failures", async () => {
    const results = await mapLimitSettled([1, 2], 2, async (value) => {
      if (value === 1) throw new Error("nope");
      return value;
    });
    expect(results[0]?.status).toBe("rejected");
    expect(results[1]?.status).toBe("fulfilled");
  });

  it("semaphore serializes beyond the limit", async () => {
    const semaphore = new Semaphore(1);
    const events: string[] = [];
    await Promise.all([
      semaphore.run(async () => {
        events.push("a-start");
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push("a-end");
      }),
      semaphore.run(async () => {
        events.push("b-start");
      }),
    ]);
    expect(events).toEqual(["a-start", "a-end", "b-start"]);
  });

  it("withTimeout rejects late work", async () => {
    await expect(
      withTimeout(new Promise(() => undefined), 10, "slow"),
    ).rejects.toBeInstanceOf(TimeoutError);
    await expect(withTimeout(Promise.resolve("ok"), 100)).resolves.toBe("ok");
  });
});

describe("TtlCache", () => {
  it("expires entries", async () => {
    const cache = new TtlCache<string, number>(20);
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cache.get("a")).toBeUndefined();
  });

  it("evicts oldest when full", () => {
    const cache = new TtlCache<string, number>(1000, 2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });
});
