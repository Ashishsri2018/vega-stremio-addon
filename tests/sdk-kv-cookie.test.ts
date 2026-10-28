import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KvStore } from "../src/providers/sdk/kvStore.js";
import { CookieJar } from "../src/providers/sdk/cookieJar.js";
import type { LoggerLike } from "../src/types.js";

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

function makeLogger(warnings: string[] = [], errors: string[] = []): LoggerLike {
  const logger: LoggerLike = {
    debug: () => undefined,
    info: () => undefined,
    warn: (event) => {
      warnings.push(event);
    },
    error: (event) => {
      errors.push(event);
    },
    child: () => logger,
  };
  return logger;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vega-sdk-store-"));
  tempDirs.push(dir);
  return dir;
}

function track(cleanup: () => Promise<void> | void): void {
  cleanups.push(cleanup);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("KvStore", () => {
  it("persists values across reopen and returns undefined for missing keys", async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, "nested", "kv.json");
    const store = await KvStore.open({ filePath, logger: makeLogger() });
    await store.set("debrid", {
      apiKey: "secret-key",
      nested: [1, 2, { enabled: true }],
    });
    await store.set("count", 3);
    expect(await store.get("missing")).toBeUndefined();
    await store.dispose();

    const reopened = await KvStore.open({ filePath, logger: makeLogger() });
    expect(await reopened.get("debrid")).toEqual({
      apiKey: "secret-key",
      nested: [1, 2, { enabled: true }],
    });
    expect(await reopened.get("count")).toBe(3);
    expect(await reopened.keys()).toEqual(["debrid", "count"]);
    await reopened.dispose();
  });

  it("rejects non-serializable values without storing them", async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, "kv.json");
    const store = await KvStore.open({ filePath, logger: makeLogger() });

    await expect(store.set("fn", () => undefined)).rejects.toThrow(
      /not JSON-serializable/,
    );
    await expect(store.set("missing", undefined)).rejects.toThrow(
      /not JSON-serializable/,
    );
    await expect(store.set("big", BigInt(1))).rejects.toThrow(
      /not JSON-serializable/,
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(store.set("circular", circular)).rejects.toThrow(
      /not JSON-serializable/,
    );

    expect(await store.keys()).toEqual([]);
    expect(await store.get("fn")).toBeUndefined();
    await store.dispose();
  });

  it("returns defensive clones and supports delete and clear", async () => {
    const dir = await tempDir();
    const store = await KvStore.open({
      filePath: path.join(dir, "kv.json"),
      logger: makeLogger(),
    });
    await store.set("value", { nested: { count: 1 } });
    const first = await store.get<{ nested: { count: number } }>("value");
    first!.nested.count = 99;
    expect(await store.get("value")).toEqual({ nested: { count: 1 } });

    expect(await store.delete("value")).toBe(true);
    expect(await store.delete("value")).toBe(false);
    await store.set("a", 1);
    await store.set("b", 2);
    await store.clear();
    expect(await store.keys()).toEqual([]);
    await store.dispose();
  });

  it("writes with a debounce and flushes explicitly", async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, "kv.json");
    const store = await KvStore.open({
      filePath,
      logger: makeLogger(),
      flushMs: 40,
    });

    await store.set("first", "one");
    expect(await exists(filePath)).toBe(false);
    await wait(150);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ first: "one" });

    await store.set("second", "two");
    await store.flush();
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      first: "one",
      second: "two",
    });
    await store.dispose();
  });

  it("starts empty when the file is malformed", async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, "kv.json");
    await writeFile(filePath, "{ this is not json", "utf8");
    const errors: string[] = [];
    const store = await KvStore.open({ filePath, logger: makeLogger([], errors) });
    expect(await store.keys()).toEqual([]);
    expect(errors).toContain("kv.load_failed");
    await store.set("recovered", true);
    expect(await store.get("recovered")).toBe(true);
    await store.dispose();
  });
});

describe("CookieJar", () => {
  it("captures cookies, merges headers, and persists across reopen", async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, "cookies.json");
    const jar = await CookieJar.open({ filePath, logger: makeLogger() });
    const future = new Date(Date.now() + 86_400_000).toUTCString();
    jar.captureFromResponse("https://www.example.com/login", [
      "sid=abc123; Path=/; HttpOnly",
      `pref=dark; Expires=${future}; Path=/`,
    ]);

    expect(await jar.getCookieHeader("https://www.example.com/")).toBe(
      "sid=abc123; pref=dark",
    );
    expect(await jar.getCookieMap("https://example.com/anything")).toEqual({
      sid: "abc123",
      pref: "dark",
    });

    const inputHeaders = { Cookie: "manual=1; sid=other", "X-Test": "yes" };
    const merged = await jar.mergeRequestHeaders(
      "https://www.example.com/",
      inputHeaders,
    );
    expect(merged.Cookie).toBe("manual=1; sid=other; pref=dark");
    expect(merged["X-Test"]).toBe("yes");
    expect(inputHeaders.Cookie).toBe("manual=1; sid=other");

    const added = await jar.mergeRequestHeaders("https://example.com/", {
      "X-Test": "yes",
    });
    expect(added.Cookie).toBe("sid=abc123; pref=dark");
    expect(added["X-Test"]).toBe("yes");

    await jar.dispose();
    const reopened = await CookieJar.open({ filePath, logger: makeLogger() });
    expect(await reopened.getCookieMap("https://www.example.com/")).toEqual({
      sid: "abc123",
      pref: "dark",
    });
    await reopened.dispose();
  });

  it("keeps domains separate while sharing multi-part registrable domains", async () => {
    const dir = await tempDir();
    const jar = await CookieJar.open({
      filePath: path.join(dir, "cookies.json"),
      logger: makeLogger(),
    });
    jar.captureFromResponse("https://www.example.co.uk/", ["uk=1; Path=/"]);
    jar.captureFromResponse("https://api.example.co.uk/", ["api=2; Path=/"]);
    jar.captureFromResponse("https://example.com/", ["com=3; Path=/"]);
    jar.captureFromResponse("https://example.net/", ["net=4; Path=/"]);

    expect(await jar.getCookieHeader("https://other.example.co.uk/")).toBe(
      "uk=1; api=2",
    );
    expect(await jar.getCookieHeader("https://example.com/")).toBe("com=3");
    expect(await jar.getCookieHeader("https://example.net/")).toBe("net=4");
    expect(await jar.getCookieHeader("https://example.org/")).toBeUndefined();
    await jar.dispose();
  });

  it("honors safe Domain attributes and drops unrelated domains", async () => {
    const dir = await tempDir();
    const jar = await CookieJar.open({
      filePath: path.join(dir, "cookies.json"),
      logger: makeLogger(),
    });
    jar.captureFromResponse("https://sub.example.com/", [
      "shared=1; Domain=.example.com; Path=/",
    ]);
    jar.captureFromResponse("https://example.com/", [
      "evil=1; Domain=.evil.com; Path=/",
    ]);

    expect(await jar.getCookieHeader("https://other.example.com/")).toBe(
      "shared=1",
    );
    expect(await jar.getCookieHeader("https://example.com/")).toBe("shared=1");
    await jar.dispose();
  });

  it("removes expired cookies and handles Max-Age deletion", async () => {
    const dir = await tempDir();
    const jar = await CookieJar.open({
      filePath: path.join(dir, "cookies.json"),
      logger: makeLogger(),
    });
    jar.captureFromResponse("https://expiry.example.com/", [
      "gone=1; Max-Age=0; Path=/",
      "old=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/",
      "fresh=1; Max-Age=60; Path=/",
    ]);
    expect(await jar.getCookieMap("https://expiry.example.com/")).toEqual({
      fresh: "1",
    });

    jar.captureFromResponse("https://expiry.example.com/", ["fresh=1; Max-Age=0; Path=/"]);
    expect(await jar.getCookieMap("https://expiry.example.com/")).toEqual({});
    await jar.dispose();
  });

  it("evicts the oldest cookies beyond the per-domain cap", async () => {
    const dir = await tempDir();
    const jar = await CookieJar.open({
      filePath: path.join(dir, "cookies.json"),
      logger: makeLogger(),
      maxCookiesPerDomain: 2,
      flushMs: 60_000,
    });
    jar.captureFromResponse("https://cap.example.com/", ["a=1; Path=/"]);
    await wait(3);
    jar.captureFromResponse("https://cap.example.com/", ["b=2; Path=/"]);
    await wait(3);
    jar.captureFromResponse("https://cap.example.com/", ["c=3; Path=/"]);
    expect(await jar.getCookieMap("https://cap.example.com/")).toEqual({
      b: "2",
      c: "3",
    });
    await jar.dispose();
  });

  it("evicts the oldest cookies to stay under the total size cap", async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, "cookies.json");
    const jar = await CookieJar.open({
      filePath,
      logger: makeLogger(),
      maxTotalBytes: 450,
      flushMs: 60_000,
    });
    for (let index = 0; index < 10; index += 1) {
      jar.captureFromResponse("https://big.example.com/", [
        `c${index}=${"x".repeat(80)}; Path=/`,
      ]);
      await wait(2);
    }

    const cookies = await jar.getCookieMap("https://big.example.com/");
    expect(Object.keys(cookies).length).toBeGreaterThan(0);
    expect(cookies.c9).toBeDefined();

    await jar.flush();
    const written = await readFile(filePath, "utf8");
    expect(Buffer.byteLength(written)).toBeLessThanOrEqual(451);
    await jar.dispose();
  });

  it("starts empty when the file is malformed", async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, "cookies.json");
    await writeFile(filePath, "not json at all", "utf8");
    const errors: string[] = [];
    const jar = await CookieJar.open({ filePath, logger: makeLogger([], errors) });
    expect(await jar.getCookieMap("https://example.com/")).toEqual({});
    expect(errors).toContain("cookie.load_failed");
    jar.captureFromResponse("https://example.com/", ["ok=1; Path=/"]);
    expect(await jar.getCookieMap("https://example.com/")).toEqual({ ok: "1" });
    await jar.dispose();
  });
});
