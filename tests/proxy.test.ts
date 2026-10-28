import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type express from "express";
import expressApp from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProxyToken,
  signProxyToken,
  verifyProxyToken,
  type ProxyPayload,
} from "../src/proxy/sign.js";
import {
  assertUrlAllowed,
  createProxyHandler,
  isPrivateAddress,
  rewriteHlsPlaylist,
} from "../src/proxy/server.js";
import type { LoggerLike } from "../src/types.js";
import { nativeFetch } from "../src/util/nativeFetch.js";

const secret = "proxy-test-secret";
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

function makeLogger(): LoggerLike {
  const logger: LoggerLike = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger;
}

function signRaw(encoded: string, signingSecret: string): string {
  const signature = createHmac("sha256", signingSecret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

describe("proxy token signing", () => {
  it("roundtrips a payload with headers", () => {
    const now = Math.floor(Date.now() / 1000);
    const payload: ProxyPayload = {
      u: "https://cdn.example.com/a.m3u8?token=abc",
      h: { Referer: "https://provider.example/", "User-Agent": "VegaTest/1.0" },
      e: now + 120,
    };
    const token = signProxyToken(payload, secret);

    expect(verifyProxyToken(token, secret, now)).toEqual(payload);
  });

  it("defaults to a six hour expiry and omits empty headers", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createProxyToken("https://cdn.example.com/a.mp4", {}, secret);
    const payload = verifyProxyToken(token, secret, now);

    expect(payload?.u).toBe("https://cdn.example.com/a.mp4");
    expect(payload?.h).toBeUndefined();
    expect(payload?.e).toBeGreaterThanOrEqual(now + 6 * 60 * 60 - 5);
    expect(payload?.e).toBeLessThanOrEqual(now + 6 * 60 * 60 + 5);
  });

  it("rejects tampered tokens, wrong secrets, and malformed tokens", () => {
    const token = createProxyToken("https://cdn.example.com/a.mp4", undefined, secret);
    const [encoded = "", signature = ""] = token.split(".");
    const tamperedPayload = `${encoded.slice(0, -1)}${encoded.endsWith("A") ? "B" : "A"}.${signature}`;
    const tamperedSignature = `${encoded}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;

    expect(verifyProxyToken(tamperedPayload, secret)).toBeNull();
    expect(verifyProxyToken(tamperedSignature, secret)).toBeNull();
    expect(verifyProxyToken(token, "another-secret")).toBeNull();
    expect(verifyProxyToken("garbage", secret)).toBeNull();
    expect(verifyProxyToken("a.b.c", secret)).toBeNull();
    expect(verifyProxyToken("", secret)).toBeNull();
  });

  it("enforces expiry at the exact boundary", () => {
    const now = 1_800_000_000;
    const token = signProxyToken({ u: "https://cdn.example.com/a.mp4", e: now }, secret);

    expect(verifyProxyToken(token, secret, now)).not.toBeNull();
    expect(verifyProxyToken(token, secret, now + 1)).toBeNull();
    expect(verifyProxyToken(token, secret, now - 1)).not.toBeNull();
  });

  it("expires short-lived tokens", () => {
    const token = createProxyToken("https://cdn.example.com/a.mp4", undefined, secret, 5);
    const now = Math.floor(Date.now() / 1000);

    expect(verifyProxyToken(token, secret, now + 6)).toBeNull();
  });

  it("rejects malformed payload shapes", () => {
    const now = Math.floor(Date.now() / 1000);
    const badJson = Buffer.from("{not json", "utf8").toString("base64url");
    const cases = [
      signRaw(badJson, secret),
      signProxyToken({ u: "ftp://example.com/a", e: now + 60 }, secret),
      signProxyToken({ u: "not a url", e: now + 60 }, secret),
      signProxyToken({ u: "https://example.com/a", e: "soon" } as unknown as ProxyPayload, secret),
      signProxyToken(
        { u: "https://example.com/a", e: now + 60, h: ["x"] } as unknown as ProxyPayload,
        secret,
      ),
      signProxyToken(
        { u: "https://example.com/a", e: now + 60, h: { Referer: "a\r\nb" } } as ProxyPayload,
        secret,
      ),
    ];

    for (const token of cases) {
      expect(verifyProxyToken(token, secret, now)).toBeNull();
    }
  });

  it("never embeds the signing secret in the token", () => {
    const token = createProxyToken("https://cdn.example.com/a.mp4", undefined, secret);
    expect(token).not.toContain(secret);
  });
});

describe("isPrivateAddress", () => {
  it.each([
    ["127.0.0.1", true],
    ["10.0.0.1", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.1.1", true],
    ["169.254.1.1", true],
    ["192.0.0.1", true],
    ["192.0.2.1", true],
    ["198.18.0.1", true],
    ["198.19.255.255", true],
    ["198.51.100.1", true],
    ["203.0.113.1", true],
    ["0.0.0.0", true],
    ["100.64.0.1", true],
    ["100.127.255.255", true],
    ["224.0.0.1", true],
    ["255.255.255.255", true],
    ["::1", true],
    ["::", true],
    ["fc00::1", true],
    ["fd12:3456:789a::1", true],
    ["fe80::1", true],
    ["ff02::1", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:7f00:1", true],
    ["::ffff:10.0.0.1", true],
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["172.15.255.255", false],
    ["172.32.0.1", false],
    ["100.63.255.255", false],
    ["100.128.0.1", false],
    ["198.20.0.1", false],
    ["::ffff:8.8.8.8", false],
    ["2606:4700:4700::1111", false],
  ])("classifies %s as private=%s", (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });
});

describe("assertUrlAllowed", () => {
  it("accepts public DNS results", async () => {
    await expect(
      assertUrlAllowed("https://example.com/file.mp4", false, async () => ["93.184.216.34"]),
    ).resolves.toBeUndefined();
  });

  it("rejects localhost and private DNS results", async () => {
    await expect(
      assertUrlAllowed("http://localhost:8080/file.mp4", false, async () => ["127.0.0.1"]),
    ).rejects.toThrow();
    await expect(
      assertUrlAllowed("https://example.com/file.mp4", false, async () => ["10.0.0.5"]),
    ).rejects.toThrow();
    await expect(
      assertUrlAllowed("https://example.com/file.mp4", false, async () => [
        "93.184.216.34",
        "192.168.1.10",
      ]),
    ).rejects.toThrow();
  });

  it("rejects private IP literals without resolving DNS", async () => {
    let calls = 0;
    const resolver = async (): Promise<string[]> => {
      calls += 1;
      return ["93.184.216.34"];
    };

    await expect(assertUrlAllowed("http://127.0.0.1/", false, resolver)).rejects.toThrow();
    await expect(assertUrlAllowed("http://[::1]/", false, resolver)).rejects.toThrow();
    await expect(assertUrlAllowed("http://[::ffff:127.0.0.1]/", false, resolver)).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("rejects non-http protocols even when private hosts are allowed", async () => {
    await expect(assertUrlAllowed("ftp://example.com/file", true)).rejects.toThrow();
    await expect(assertUrlAllowed("file:///etc/passwd", true)).rejects.toThrow();
    await expect(assertUrlAllowed("not a url", true)).rejects.toThrow();
  });

  it("allows private hosts only when explicitly enabled", async () => {
    await expect(assertUrlAllowed("http://127.0.0.1:1234/file", true)).resolves.toBeUndefined();
    await expect(
      assertUrlAllowed("http://localhost:1234/file", true, async () => ["127.0.0.1"]),
    ).resolves.toBeUndefined();
  });

  it("fails closed when DNS fails or returns nothing", async () => {
    await expect(
      assertUrlAllowed("https://example.com/file", false, async () => {
        throw new Error("dns failure");
      }),
    ).rejects.toThrow();
    await expect(
      assertUrlAllowed("https://example.com/file", false, async () => []),
    ).rejects.toThrow();
  });
});

describe("rewriteHlsPlaylist", () => {
  it("rewrites segments, keys, maps, media, and iframe URIs while preserving tags", () => {
    const playlist = [
      "#EXTM3U",
      "# just a comment",
      "#EXT-X-VERSION:3",
      '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"',
      '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="https://keys.example.net/session?kid=1&fmt=bin"',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio/index.m3u8"',
      "#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720",
      "video/720.m3u8",
      "#EXTINF:9.9,",
      "seg1.ts",
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="iframe.m3u8"',
      "https://cdn.example.com/abs/seg2.ts?token=abc",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const baseUrl = "https://cdn.example.com/live/master.m3u8";
    const makeProxyUrl = (url: string): string => `proxied:${url}`;
    const seen: string[] = [];

    const output = rewriteHlsPlaylist(playlist, baseUrl, (url) => {
      seen.push(url);
      return makeProxyUrl(url);
    });

    const expected = [
      "#EXTM3U",
      "# just a comment",
      "#EXT-X-VERSION:3",
      '#EXT-X-KEY:METHOD=AES-128,URI="proxied:https://cdn.example.com/live/keys/key.bin"',
      '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="proxied:https://keys.example.net/session?kid=1&fmt=bin"',
      '#EXT-X-MAP:URI="proxied:https://cdn.example.com/live/init.mp4"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="proxied:https://cdn.example.com/live/audio/index.m3u8"',
      "#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720",
      "proxied:https://cdn.example.com/live/video/720.m3u8",
      "#EXTINF:9.9,",
      "proxied:https://cdn.example.com/live/seg1.ts",
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="proxied:https://cdn.example.com/live/iframe.m3u8"',
      "proxied:https://cdn.example.com/abs/seg2.ts?token=abc",
      "#EXT-X-ENDLIST",
    ].join("\n");

    expect(output).toBe(expected);
    expect(seen).toContain("https://cdn.example.com/abs/seg2.ts?token=abc");
    expect(seen).toHaveLength(8);
  });

  it("leaves non-http URIs and unparseable lines untouched", () => {
    const playlist = [
      "#EXTM3U",
      '#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"',
      "http://[invalid",
    ].join("\n");

    const output = rewriteHlsPlaylist(playlist, "https://cdn.example.com/master.m3u8", (url) => `p:${url}`);
    expect(output).toBe(playlist);
  });

  it("preserves a BOM and CRLF line endings", () => {
    const playlist = "\uFEFF#EXTM3U\r\n#EXTINF:1,\r\nseg.ts\r\n";

    const output = rewriteHlsPlaylist(
      playlist,
      "https://cdn.example.com/master.m3u8",
      (url) => `p:${url}`,
    );

    expect(output).toBe("\uFEFF#EXTM3U\r\n#EXTINF:1,\r\np:https://cdn.example.com/seg.ts\r\n");
  });
});

interface TargetRequest {
  path: string;
  method: string;
  range?: string;
  referer?: string;
  userAgent?: string;
  acceptEncoding?: string;
}

const targetRequests: TargetRequest[] = [];

async function setupProxy(options: { allowPrivateHosts?: boolean } = {}): Promise<{
  targetBase: string;
  proxyBase: string;
}> {
  targetRequests.length = 0;

  const target = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://target").pathname;
    targetRequests.push({
      path,
      method: req.method ?? "",
      range: typeof req.headers.range === "string" ? req.headers.range : undefined,
      referer: typeof req.headers.referer === "string" ? req.headers.referer : undefined,
      userAgent:
        typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
      acceptEncoding:
        typeof req.headers["accept-encoding"] === "string"
          ? req.headers["accept-encoding"]
          : undefined,
    });

    if (path === "/media.bin") {
      if (req.headers.range === "bytes=0-3") {
        res.writeHead(206, {
          "Content-Type": "video/mp4",
          "Content-Range": "bytes 0-3/10",
          "Content-Length": "4",
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        });
        res.end("0123");
      } else {
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": "10",
          "Accept-Ranges": "bytes",
        });
        res.end("0123456789");
      }
      return;
    }

    if (path === "/playlist.m3u8") {
      const playlist = [
        "#EXTM3U",
        '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
        "#EXTINF:1,",
        "seg.ts",
        "#EXT-X-ENDLIST",
        "",
      ].join("\n");
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(playlist);
      return;
    }

    if (path === "/seg.ts") {
      res.writeHead(200, { "Content-Type": "video/mp2t" });
      res.end("SEGMENT");
      return;
    }

    if (path === "/key.bin") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end("KEY");
      return;
    }

    if (path === "/redirect") {
      res.writeHead(302, { Location: "/media.bin" });
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  const targetBase = await listen(target);

  const app = expressApp();
  app.all(
    "/proxy/:token",
    createProxyHandler({
      secret,
      logger: makeLogger(),
      fetchImpl: nativeFetch,
      allowPrivateHosts: options.allowPrivateHosts ?? true,
    }),
  );
  const proxyBase = await startApp(app);

  return { targetBase, proxyBase };
}

describe("proxy handler end-to-end", () => {
  it("forwards Range and payload headers and returns 206 with Content-Range", async () => {
    const { targetBase, proxyBase } = await setupProxy();
    const token = createProxyToken(
      `${targetBase}/media.bin`,
      { Referer: "https://provider.example/", "User-Agent": "VegaTest/1.0" },
      secret,
    );

    const response = await nativeFetch(`${proxyBase}/proxy/${token}`, {
      headers: { Range: "bytes=0-3" },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("0123");

    const upstream = targetRequests.find((entry) => entry.path === "/media.bin");
    expect(upstream?.range).toBe("bytes=0-3");
    expect(upstream?.referer).toBe("https://provider.example/");
    expect(upstream?.userAgent).toBe("VegaTest/1.0");
    expect(upstream?.acceptEncoding?.split(",").map((value) => value.trim())).toEqual([
      "identity",
      "identity",
    ]);
  });

  it("streams HEAD responses without a body", async () => {
    const { targetBase, proxyBase } = await setupProxy();
    const token = createProxyToken(`${targetBase}/media.bin`, undefined, secret);

    const response = await nativeFetch(`${proxyBase}/proxy/${token}`, { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("10");
    expect(await response.text()).toBe("");
    expect(targetRequests.find((entry) => entry.path === "/media.bin")?.method).toBe("HEAD");
  });

  it("follows redirects and streams the final response", async () => {
    const { targetBase, proxyBase } = await setupProxy();
    const token = createProxyToken(`${targetBase}/redirect`, undefined, secret);

    const response = await nativeFetch(`${proxyBase}/proxy/${token}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("0123456789");
    expect(targetRequests.map((entry) => entry.path)).toEqual(["/redirect", "/media.bin"]);
  });

  it("rewrites HLS playlists and keeps signed headers for segments", async () => {
    const { targetBase, proxyBase } = await setupProxy();
    const headers = {
      "User-Agent": "VegaTest/1.0",
      Referer: "https://provider.example/",
    };
    const playlistToken = createProxyToken(`${targetBase}/playlist.m3u8`, headers, secret);
    const playlistPayload = verifyProxyToken(playlistToken, secret);

    const response = await nativeFetch(`${proxyBase}/proxy/${playlistToken}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/vnd.apple.mpegurl");

    const playlist = await response.text();
    expect(playlist).toContain("#EXTM3U");
    const proxyUrls = playlist.match(/https?:\/\/[^\s"']+/g) ?? [];
    expect(proxyUrls).toHaveLength(2);

    const resolved = proxyUrls.map((url) => {
      const pathname = new URL(url).pathname;
      const token = pathname.slice("/proxy/".length);
      return { url, payload: verifyProxyToken(token, secret) };
    });
    const segment = resolved.find((entry) => entry.payload?.u === `${targetBase}/seg.ts`);
    const key = resolved.find((entry) => entry.payload?.u === `${targetBase}/key.bin`);

    expect(segment).toBeDefined();
    expect(key).toBeDefined();
    expect(segment?.payload?.h).toEqual(headers);
    expect(segment?.payload?.e).toBe(playlistPayload?.e);

    const segmentResponse = await nativeFetch(segment?.url ?? "");
    expect(segmentResponse.status).toBe(200);
    expect(await segmentResponse.text()).toBe("SEGMENT");

    const upstream = targetRequests.find((entry) => entry.path === "/seg.ts");
    expect(upstream?.userAgent).toBe("VegaTest/1.0");
    expect(upstream?.referer).toBe("https://provider.example/");

    const keyResponse = await nativeFetch(key?.url ?? "");
    expect(keyResponse.status).toBe(200);
    expect(await keyResponse.text()).toBe("KEY");
  });

  it("rejects missing, expired, wrong-secret, and non-http tokens", async () => {
    const { targetBase, proxyBase } = await setupProxy();
    const now = Math.floor(Date.now() / 1000);
    const before = targetRequests.length;
    const tokens = [
      "not-a-token",
      createProxyToken(`${targetBase}/media.bin`, undefined, "wrong-secret"),
      signProxyToken({ u: `${targetBase}/media.bin`, e: now - 10 }, secret),
      signProxyToken({ u: "file:///etc/passwd", e: now + 60 }, secret),
    ];

    for (const token of tokens) {
      const response = await nativeFetch(`${proxyBase}/proxy/${token}`);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
    expect(targetRequests.length).toBe(before);
  });

  it("rejects non-GET and non-HEAD methods with 405", async () => {
    const { targetBase, proxyBase } = await setupProxy();
    const token = createProxyToken(`${targetBase}/media.bin`, undefined, secret);

    const response = await nativeFetch(`${proxyBase}/proxy/${token}`, { method: "POST" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(await response.json()).toEqual({ error: "method not allowed" });
    expect(targetRequests).toHaveLength(0);
  });

  it("blocks private targets by default even with a valid token", async () => {
    const { targetBase, proxyBase } = await setupProxy({ allowPrivateHosts: false });
    const token = createProxyToken(`${targetBase}/media.bin`, undefined, secret);

    const response = await nativeFetch(`${proxyBase}/proxy/${token}`);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "bad gateway" });
    expect(targetRequests).toHaveLength(0);
  });
});
