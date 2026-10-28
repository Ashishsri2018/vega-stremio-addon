import { createRequire } from "node:module";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { HttpTransport } from "../src/providers/sdk/http.js";
import { CookieJar } from "../src/providers/sdk/cookieJar.js";
import {
  clearProviderUrlCache,
  createProviderContext,
  installGlobalFetch,
} from "../src/providers/sdk/context.js";
import type {
  CookieJarApi,
  HttpRequestOptions,
  HttpTransportApi,
  KVStoreApi,
  LoggerLike,
  UrlsSnapshot,
} from "../src/types.js";

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

const curlLoadable = (() => {
  try {
    createRequire(import.meta.url)("curl-cffi-node");
    return true;
  } catch {
    return false;
  }
})();

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vega-sdk-http-"));
  tempDirs.push(dir);
  return dir;
}

function track(cleanup: () => Promise<void> | void): void {
  cleanups.push(cleanup);
}

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

interface TestServer {
  baseUrl: string;
  server: http.Server;
}

async function startServer(handler: http.RequestListener): Promise<TestServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  track(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function makeJar(): Promise<CookieJar> {
  const dir = await tempDir();
  const jar = await CookieJar.open({
    filePath: path.join(dir, "cookies.json"),
    logger: makeLogger(),
    flushMs: 60_000,
  });
  track(() => jar.dispose());
  return jar;
}

function makeTransport(
  cookieJar: CookieJarApi,
  logger: LoggerLike,
  options: Partial<ConstructorParameters<typeof HttpTransport>[0]> = {},
): HttpTransport {
  return new HttpTransport({ cookieJar, logger, useCurlCffi: false, ...options });
}

function fakeCookieJar(): CookieJarApi {
  return {
    async getCookieHeader() {
      return undefined;
    },
    async getCookieMap() {
      return {};
    },
    captureFromResponse() {
      return undefined;
    },
    async mergeRequestHeaders(_url, headers) {
      return { ...headers };
    },
    async flush() {
      return undefined;
    },
  };
}

function fakeKvStore(): KVStoreApi {
  const values = new Map<string, unknown>();
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return values.get(key) as T | undefined;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      return values.delete(key);
    },
    async keys() {
      return [...values.keys()];
    },
    async clear() {
      values.clear();
    },
  };
}

function recordingTransport(): { transport: HttpTransportApi; calls: HttpRequestOptions[] } {
  const calls: HttpRequestOptions[] = [];
  return {
    calls,
    transport: {
      async request(options) {
        calls.push(options);
        return {
          status: 200,
          statusText: "OK",
          url: options.url,
          headers: { "content-type": "text/plain" },
          body: Buffer.from("live"),
        };
      },
    },
  };
}

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearProviderUrlCache();
  }
});

describe("HttpTransport native fetch backend", () => {
  it("fetches text and JSON responses with normalized headers", async () => {
    const { baseUrl } = await startServer((req, res) => {
      if (req.url === "/json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, value: 42 }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("hello transport");
    });
    const transport = makeTransport(await makeJar(), makeLogger());

    const text = await transport.request({ url: `${baseUrl}/text` });
    expect(text.status).toBe(200);
    expect(text.statusText).toBe("OK");
    expect(text.url).toBe(`${baseUrl}/text`);
    expect(text.body.toString()).toBe("hello transport");
    expect(text.headers["content-type"]).toContain("text/plain");

    const json = await transport.request({ url: `${baseUrl}/json` });
    expect(JSON.parse(json.body.toString())).toEqual({ ok: true, value: 42 });
    expect(json.headers["content-type"]).toBe("application/json");
  });

  it("decompresses gzip response bodies", async () => {
    const payload = JSON.stringify({ compressed: true, text: "vega ".repeat(100) });
    const compressed = gzipSync(Buffer.from(payload));
    const { baseUrl } = await startServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "Content-Length": compressed.length,
      });
      res.end(compressed);
    });
    const transport = makeTransport(await makeJar(), makeLogger());

    const response = await transport.request({ url: `${baseUrl}/gzip` });
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(JSON.parse(response.body.toString())).toEqual({
      compressed: true,
      text: "vega ".repeat(100),
    });
  });

  it("decompresses gzip bodies from fetch implementations that do not decode", async () => {
    const payload = "compressed by the transport";
    const compressed = gzipSync(Buffer.from(payload));
    const fetchImpl: typeof fetch = async () =>
      new Response(compressed as unknown as RequestInit["body"], {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-encoding": "gzip",
        },
      });
    const transport = makeTransport(await makeJar(), makeLogger(), { fetchImpl });

    const response = await transport.request({ url: "https://example.com/gzip" });
    expect(response.body.toString()).toBe(payload);
  });

  it("rejects requests that exceed the response size cap", async () => {
    const { baseUrl } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(Buffer.alloc(8192, "a"));
    });
    const transport = makeTransport(await makeJar(), makeLogger(), {
      maxResponseBytes: 1024,
    });

    await expect(transport.request({ url: `${baseUrl}/large` })).rejects.toThrow(
      /exceeds maximum size/i,
    );
  });

  it("rejects on timeout even when the server never responds", async () => {
    const { baseUrl } = await startServer(() => {
      // Intentionally leave the response open.
    });
    const transport = makeTransport(await makeJar(), makeLogger(), {
      defaultTimeoutMs: 5000,
    });

    await expect(
      transport.request({ url: `${baseUrl}/slow`, timeoutMs: 120 }),
    ).rejects.toThrow(/timed out/i);
  });

  it("does not issue a request for an already-aborted signal", async () => {
    let hits = 0;
    const { baseUrl } = await startServer((_req, res) => {
      hits += 1;
      res.end("ok");
    });
    const transport = makeTransport(await makeJar(), makeLogger());
    const controller = new AbortController();
    controller.abort();

    await expect(
      transport.request({ url: `${baseUrl}/aborted`, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(hits).toBe(0);
  });

  it("aborts an in-flight request", async () => {
    const { baseUrl } = await startServer(() => {
      // Intentionally leave the response open.
    });
    const transport = makeTransport(await makeJar(), makeLogger(), {
      defaultTimeoutMs: 5000,
    });
    const controller = new AbortController();
    const pending = transport.request({
      url: `${baseUrl}/abort-during`,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("follows redirects and exposes manual redirect responses", async () => {
    const { baseUrl } = await startServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/final" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("final");
    });
    const transport = makeTransport(await makeJar(), makeLogger());

    const followed = await transport.request({ url: `${baseUrl}/redirect` });
    expect(followed.status).toBe(200);
    expect(followed.body.toString()).toBe("final");
    expect(followed.url).toBe(`${baseUrl}/final`);

    const manual = await transport.request({
      url: `${baseUrl}/redirect`,
      redirect: "manual",
    });
    expect(manual.status).toBe(302);
    expect(manual.headers.location).toBe("/final");
    expect(manual.url).toBe(`${baseUrl}/redirect`);
  });

  it("captures set-cookie headers and merges them into later requests", async () => {
    const { baseUrl } = await startServer((req, res) => {
      if (req.url === "/cookie/set") {
        res.setHeader("Set-Cookie", [
          "session=abc123; Path=/; HttpOnly",
          "theme=dark; Path=/",
        ]);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("set");
        return;
      }
      const cookie = req.headers.cookie ?? "";
      const ok = cookie.includes("session=abc123") && cookie.includes("theme=dark");
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/plain" });
      res.end(cookie);
    });
    const jar = await makeJar();
    const transport = makeTransport(jar, makeLogger());

    await transport.request({ url: `${baseUrl}/cookie/set` });
    expect(await jar.getCookieHeader(`${baseUrl}/`)).toContain("session=abc123");
    expect(await jar.getCookieMap(`${baseUrl}/`)).toMatchObject({
      session: "abc123",
      theme: "dark",
    });

    const withJar = await transport.request({ url: `${baseUrl}/cookie/check` });
    expect(withJar.status).toBe(200);

    const withExplicit = await transport.request({
      url: `${baseUrl}/cookie/check`,
      headers: { Cookie: "manual=1" },
    });
    expect(withExplicit.status).toBe(200);
    expect(withExplicit.body.toString()).toContain("manual=1");
    expect(withExplicit.body.toString()).toContain("session=abc123");
  });

  it("does not forward jar cookies to raw.githubusercontent.com", async () => {
    let mergeCalls = 0;
    const jar: CookieJarApi = {
      ...fakeCookieJar(),
      async mergeRequestHeaders(_url, headers) {
        mergeCalls += 1;
        return { ...headers, Cookie: "leaked=1" };
      },
    };
    let sentHeaders: RequestInit["headers"];
    const fetchImpl: typeof fetch = async (_input, init) => {
      sentHeaders = init?.headers;
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    };
    const transport = makeTransport(jar, makeLogger(), { fetchImpl });

    await transport.request({
      url: "https://raw.githubusercontent.com/Zenda-Cross/vega-providers/refs/heads/main/urls.json",
    });
    expect(mergeCalls).toBe(0);
    expect(new Headers(sentHeaders).has("cookie")).toBe(false);
  });

  it.skipIf(curlLoadable)("falls back to native fetch when curl-cffi is unavailable", async () => {
    const warnings: string[] = [];
    const { baseUrl } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("fallback");
    });
    const transport = new HttpTransport({
      cookieJar: await makeJar(),
      logger: makeLogger(warnings),
      useCurlCffi: true,
    });

    const first = await transport.request({ url: `${baseUrl}/one` });
    expect(first.body.toString()).toBe("fallback");
    const second = await transport.request({ url: `${baseUrl}/two` });
    expect(second.body.toString()).toBe("fallback");

    expect(
      warnings.filter((event) => event === "http.curl_cffi_unavailable"),
    ).toHaveLength(1);
  });
});

describe("provider context", () => {
  it("returns the upstream common headers and a WAF error", async () => {
    const context = createProviderContext({
      transport: recordingTransport().transport,
      kvStore: fakeKvStore(),
      cookieJar: fakeCookieJar(),
      logger: makeLogger(),
    });

    expect(context.commonHeaders["User-Agent"]).toContain("Chrome/131");
    expect(context.commonHeaders["sec-ch-ua-platform"]).toBe('"Windows"');
    expect(Object.keys(context.commonHeaders)).toHaveLength(12);
    expect(context.cheerio.load("<h1>Hello</h1>")("h1").text()).toBe("Hello");

    const error = (await context.openWebView("https://example.com").catch(
      (caught: unknown) => caught,
    )) as Error & { code?: string };
    expect(error.message).toContain("WAF_REQUIRED");
    expect(error.code).toBe("WAF_REQUIRED");
  });

  it("serves the active urls.json snapshot without hitting the transport", async () => {
    const { transport, calls } = recordingTransport();
    let active: UrlsSnapshot | null = {
      alpha: { name: "Alpha", url: "https://alpha.example" },
    };
    installGlobalFetch({
      transport,
      cookieJar: fakeCookieJar(),
      logger: makeLogger(),
      getActiveUrls: () => active,
    });

    const snapshotUrl =
      "https://raw.githubusercontent.com/Zenda-Cross/vega-providers/refs/heads/main/urls.json";
    const response = await fetch(snapshotUrl);
    expect(calls).toHaveLength(0);
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.has("CONTENT-TYPE")).toBe(true);
    expect(await response.json()).toEqual({
      alpha: { name: "Alpha", url: "https://alpha.example" },
    });

    const requestResponse = await fetch(
      new Request(
        "https://raw.githubusercontent.com/Zenda-Cross/vega-providers/abc123/urls.json",
      ),
    );
    expect(await requestResponse.json()).toEqual({
      alpha: { name: "Alpha", url: "https://alpha.example" },
    });

    active = { beta: { name: "Beta", url: "https://beta.example" } };
    const merged = (await (await fetch(snapshotUrl)).json()) as UrlsSnapshot;
    expect(merged.beta?.url).toBe("https://beta.example");
    expect(merged.alpha?.url).toBe("https://alpha.example");
    expect(calls).toHaveLength(0);
  });

  it("leaves the provider base url cache untouched on reads", async () => {
    installGlobalFetch({
      transport: recordingTransport().transport,
      cookieJar: fakeCookieJar(),
      logger: makeLogger(),
      getActiveUrls: () => ({ alpha: { url: "https://alpha.example" } }),
    });
    const globalRecord = globalThis as typeof globalThis & {
      __vegaProviderBaseUrlCache__?: unknown;
    };
    globalRecord.__vegaProviderBaseUrlCache__ = { alpha: "cached" };

    await fetch(
      "https://raw.githubusercontent.com/Zenda-Cross/vega-providers/main/urls.json",
    );
    expect(globalRecord.__vegaProviderBaseUrlCache__).toEqual({ alpha: "cached" });

    clearProviderUrlCache();
    expect(globalRecord.__vegaProviderBaseUrlCache__).toBeUndefined();
  });

  it("falls through to the transport when no snapshot is active", async () => {
    const { transport, calls } = recordingTransport();
    installGlobalFetch({
      transport,
      cookieJar: fakeCookieJar(),
      logger: makeLogger(),
      getActiveUrls: () => null,
    });

    const response = await fetch(
      "https://raw.githubusercontent.com/Zenda-Cross/vega-providers/main/urls.json",
    );
    expect(calls).toHaveLength(1);
    expect(await response.text()).toBe("live");
  });

  it("runs provider axios requests through the transport adapter", async () => {
    const { baseUrl } = await startServer((req, res) => {
      if (req.url === "/missing") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (req.url === "/echo" || req.url?.startsWith("/echo?")) {
        const url = new URL(req.url, "http://localhost");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ query: url.search }));
        return;
      }
      if (req.url === "/echo-body") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              method: req.method,
              body: Buffer.concat(chunks).toString("utf8"),
              contentType: req.headers["content-type"] ?? "",
            }),
          );
        });
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          header: req.headers["x-provider"] ?? null,
        }),
      );
    });
    const transport = makeTransport(fakeCookieJar(), makeLogger());
    const context = createProviderContext({
      transport,
      kvStore: fakeKvStore(),
      cookieJar: fakeCookieJar(),
      logger: makeLogger(),
    });
    const controller = new AbortController();

    const response = await context.axios.get<{ ok: boolean; header: string }>(
      "/json",
      {
        baseURL: baseUrl,
        headers: { "x-provider": "yes" },
        signal: controller.signal,
      },
    );
    expect(response.status).toBe(200);
    expect(response.statusText).toBe("OK");
    expect(response.data).toEqual({ ok: true, header: "yes" });
    expect(response.headers["content-type"]).toContain("application/json");

    const echoed = await context.axios.get<{ query: string }>("/echo", {
      baseURL: baseUrl,
      params: { a: "1", b: ["x", "y"] },
    });
    expect(echoed.data.query).toBe("?a=1&b=x&b=y");

    const posted = await context.axios.post<{
      method: string;
      body: string;
      contentType: string;
    }>("/echo-body", { hello: "world" }, { baseURL: baseUrl });
    expect(posted.data.method).toBe("POST");
    expect(JSON.parse(posted.data.body)).toEqual({ hello: "world" });
    expect(posted.data.contentType).toContain("application/json");

    const form = await context.axios.post<{
      body: string;
      contentType: string;
    }>("/echo-body", new URLSearchParams({ a: "1", b: "2" }), {
      baseURL: baseUrl,
    });
    expect(form.data.body).toBe("a=1&b=2");
    expect(form.data.contentType).toContain("application/x-www-form-urlencoded");

    let failure: unknown;
    try {
      await context.axios.get(`${baseUrl}/missing`);
    } catch (error) {
      failure = error;
    }
    expect((failure as { response?: { status?: number } }).response?.status).toBe(404);
    expect((failure as { code?: string }).code).toBe("ERR_BAD_REQUEST");
  });
});
