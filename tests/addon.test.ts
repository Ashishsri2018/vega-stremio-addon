import http from "node:http";
import type { AddressInfo } from "node:net";
import type express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/addon/routes.js";
import { ADDON_ID, ADDON_VERSION } from "../src/addon/manifest.js";
import { parseStreamId } from "../src/addon/parseId.js";
import { verifyProxyToken } from "../src/proxy/sign.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import type {
  AddonRoutesDeps,
  HealthReport,
  LoggerLike,
  StremioStream,
  StreamHandlerApi,
  StreamRequest,
} from "../src/types.js";
import { nativeFetch } from "../src/util/nativeFetch.js";

const servers: http.Server[] = [];

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function startApp(app: express.Express): Promise<string> {
  return listen(http.createServer(app as unknown as http.RequestListener));
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig({} as NodeJS.ProcessEnv), ...overrides };
}

function makeLogger(errors: string[] = []): LoggerLike {
  const logger: LoggerLike = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (event) => {
      errors.push(event);
    },
    child: () => logger,
  };
  return logger;
}

const healthFixture: HealthReport = {
  status: "ok",
  activeSha: "f6dcbfeed",
  providerCount: 1,
  providers: { hdhub4u: { version: "2.27", status: "active" } },
  lastCheck: "2026-10-27T13:00:00.000Z",
  lastSuccess: "2026-10-27T13:00:05.000Z",
  nextCheck: "2026-10-27T18:10:00.000Z",
  pending: [],
  lastError: null,
};

function makeDeps(overrides: Partial<AddonRoutesDeps> = {}): AddonRoutesDeps {
  return {
    config: makeConfig(),
    logger: makeLogger(),
    pipeline: { handle: vi.fn(async () => []) },
    health: () => healthFixture,
    ...overrides,
  };
}

describe("manifest", () => {
  it("serves the exact stable manifest", async () => {
    const base = await startApp(createApp(makeDeps()));
    const response = await nativeFetch(`${base}/manifest.json`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.json()).toEqual({
      id: "community.vega.stremio",
      version: "1.0.0",
      name: "Vega Streams",
      description: "Streams from Vega providers",
      types: ["movie", "series"],
      resources: ["stream"],
      idPrefixes: ["tt"],
      catalogs: [],
      behaviorHints: { configurable: false },
    });
    expect(ADDON_ID).toBe("community.vega.stremio");
    expect(ADDON_VERSION).toBe("1.0.0");
  });
});

describe("CORS", () => {
  it("sets permissive headers and handles preflight", async () => {
    const base = await startApp(createApp(makeDeps()));

    const manifest = await nativeFetch(`${base}/manifest.json`, {
      headers: { Origin: "https://web.stremio.com" },
    });
    expect(manifest.headers.get("access-control-allow-origin")).toBe("*");
    expect(manifest.headers.get("access-control-allow-methods")).toContain("GET");
    expect(manifest.headers.get("access-control-allow-methods")).toContain("HEAD");
    expect(manifest.headers.get("access-control-allow-methods")).toContain("OPTIONS");
    expect(manifest.headers.get("access-control-allow-headers")).toContain("Content-Type");
    expect(manifest.headers.get("access-control-allow-headers")).toContain("Range");

    const preflight = await nativeFetch(`${base}/stream/movie/tt0111161.json`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://web.stremio.com",
        "Access-Control-Request-Headers": "range",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("health", () => {
  it("passes through the health report without caching", async () => {
    const base = await startApp(createApp(makeDeps()));
    const response = await nativeFetch(`${base}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(healthFixture);
  });

  it("returns HTTP 200 even when the health provider throws", async () => {
    const deps = makeDeps({
      health: () => {
        throw new Error("health failed");
      },
    });
    const base = await startApp(createApp(deps));
    const response = await nativeFetch(`${base}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("error");
  });
});

describe("parseStreamId", () => {
  const cases: Array<[string, string, StreamRequest | null]> = [
    ["movie", "tt0111161", { type: "movie", imdbId: "tt0111161" }],
    ["movie", "tt0111161.json", { type: "movie", imdbId: "tt0111161" }],
    ["movie", "tt0111161:1:1", null],
    ["movie", "tt0111161:1", null],
    ["series", "tt0944947:1:1", { type: "series", imdbId: "tt0944947", season: 1, episode: 1 }],
    ["series", "tt0944947:1", { type: "series", imdbId: "tt0944947", season: 1 }],
    ["series", "tt0944947:1:1.json", { type: "series", imdbId: "tt0944947", season: 1, episode: 1 }],
    ["series", "tt0944947", null],
    ["series", "tt0944947:0:1", null],
    ["series", "tt0944947:1:0", null],
    ["series", "tt0944947:1001:1", null],
    ["series", "tt0944947:1:10001", null],
    ["series", "tt0944947:1:1:1", null],
    ["series", "tt0944947::1", null],
    ["series", "tt0944947:1:", null],
    ["movie", "12345", null],
    ["movie", "ttabc", null],
    ["movie", "tt", null],
    ["anime", "tt0944947:1:1", null],
    ["tv", "tt0944947", null],
    ["Movie", "tt0111161", null],
  ];

  it.each(cases)("parses %s %s", (type, id, expected) => {
    expect(parseStreamId(type, id)).toEqual(expected);
  });
});

describe("stream routes", () => {
  it("answers HEAD without invoking the pipeline", async () => {
    const handle = vi.fn(async () => []);
    const base = await startApp(
      createApp(makeDeps({ pipeline: { handle } as StreamHandlerApi })),
    );

    const response = await nativeFetch(`${base}/stream/movie/tt0111161.json`, {
      method: "HEAD",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(handle).not.toHaveBeenCalled();
  });

  it("passes parsed movie, series, and season pack requests to the pipeline", async () => {
    const requests: StreamRequest[] = [];
    const handle = vi.fn(async (request: StreamRequest, signal?: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      requests.push(request);
      return [];
    });
    const pipeline: StreamHandlerApi = { handle };
    const base = await startApp(createApp(makeDeps({ pipeline })));

    const paths = [
      "/stream/movie/tt0111161.json",
      "/stream/series/tt0944947:1:1.json",
      "/stream/series/tt0944947:1.json",
      "/stream/movie/tt0133093",
    ];
    for (const path of paths) {
      const response = await nativeFetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ streams: [] });
    }

    expect(requests).toEqual([
      { type: "movie", imdbId: "tt0111161" },
      { type: "series", imdbId: "tt0944947", season: 1, episode: 1 },
      { type: "series", imdbId: "tt0944947", season: 1 },
      { type: "movie", imdbId: "tt0133093" },
    ]);
  });

  it("returns an empty stream list for malformed or unsupported ids without calling the pipeline", async () => {
    const handle = vi.fn(async () => []);
    const base = await startApp(createApp(makeDeps({ pipeline: { handle } })));

    const paths = [
      "/stream/movie/not-an-imdb-id.json",
      "/stream/movie/12345.json",
      "/stream/movie/ttabc.json",
      "/stream/movie/tt0111161:1:1.json",
      "/stream/series/tt0944947.json",
      "/stream/series/tt0944947:0:1.json",
      "/stream/series/tt0944947:1:10001.json",
      "/stream/series/tt0944947::1.json",
      "/stream/anime/tt0944947:1:1.json",
    ];
    for (const path of paths) {
      const response = await nativeFetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ streams: [] });
    }

    expect(handle).not.toHaveBeenCalled();
  });

  it("returns an empty stream list when the pipeline throws", async () => {
    const errors: string[] = [];
    const handle = vi.fn(async () => {
      throw new Error("provider exploded");
    });
    const deps = makeDeps({ pipeline: { handle }, logger: makeLogger(errors) });
    const base = await startApp(createApp(deps));

    const response = await nativeFetch(`${base}/stream/movie/tt0111161.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ streams: [] });
    expect(errors).toContain("stream_request_failed");
  });

  it("leaves proxy routes unregistered when the proxy is disabled", async () => {
    const base = await startApp(createApp(makeDeps()));
    const response = await nativeFetch(`${base}/proxy/not-a-token`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });

  it("wraps streams that require proxy headers and leaves other streams direct", async () => {
    const secret = "addon-test-secret";
    const headers = {
      Referer: "https://provider.example/",
      "User-Agent": "VegaTest/1.0",
    };
    const subtitles = [
      { id: "sub-1", url: "https://subs.example/movie.vtt", lang: "en" },
    ];
    const streams: StremioStream[] = [
      {
        name: "Signed",
        title: "1080p",
        url: "https://cdn.example.com/master.m3u8?token=abc",
        behaviorHints: { proxyHeaders: { request: headers } },
        subtitles,
      },
      { name: "Direct", url: "https://cdn.example.com/video.mp4" },
      {
        name: "Empty headers",
        url: "https://cdn.example.com/empty.mp4",
        behaviorHints: { proxyHeaders: { request: {} } },
      },
    ];

    const pipeline: StreamHandlerApi = { handle: vi.fn(async () => streams) };
    const config = makeConfig({ proxyEnabled: true, proxySecret: secret });
    const base = await startApp(createApp(makeDeps({ pipeline, config })));

    const response = await nativeFetch(`${base}/stream/movie/tt0111161.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { streams: StremioStream[] };
    expect(body.streams).toHaveLength(3);

    const proxyPrefix = `${base}/proxy/`;
    expect(body.streams[0]?.url.startsWith(proxyPrefix)).toBe(true);
    const token = body.streams[0]?.url.slice(proxyPrefix.length) ?? "";
    const payload = verifyProxyToken(token, secret);
    expect(payload?.u).toBe("https://cdn.example.com/master.m3u8?token=abc");
    expect(payload?.h).toEqual(headers);
    expect(payload?.e).toBeGreaterThan(Math.floor(Date.now() / 1000));

    expect(body.streams[0]?.behaviorHints?.proxyHeaders?.request).toEqual(headers);
    expect(body.streams[0]?.subtitles).toEqual(subtitles);
    expect(body.streams[1]?.url).toBe("https://cdn.example.com/video.mp4");
    expect(body.streams[2]?.url).toBe("https://cdn.example.com/empty.mp4");
  });

  it("uses PUBLIC_BASE_URL when building proxy stream urls", async () => {
    const secret = "public-base-secret";
    const pipeline: StreamHandlerApi = {
      handle: vi.fn(async () => [
        {
          name: "Signed",
          url: "https://cdn.example.com/file.mp4",
          behaviorHints: { proxyHeaders: { request: { Referer: "https://ref/" } } },
        },
      ]),
    };
    const config = makeConfig({
      proxyEnabled: true,
      proxySecret: secret,
      publicBaseUrl: "https://addon.example.com/base/",
    });
    const base = await startApp(createApp(makeDeps({ pipeline, config })));

    const response = await nativeFetch(`${base}/stream/movie/tt0111161.json`);
    const body = (await response.json()) as { streams: StremioStream[] };
    expect(body.streams[0]?.url.startsWith("https://addon.example.com/base/proxy/")).toBe(true);
  });
});

describe("unknown routes", () => {
  it("returns a JSON 404", async () => {
    const base = await startApp(createApp(makeDeps()));
    const response = await nativeFetch(`${base}/admin/update`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });
});
