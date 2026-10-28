import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { Request, RequestHandler, Response as ExpressResponse } from "express";
import type { LoggerLike } from "../types.js";
import { nativeFetch } from "../util/nativeFetch.js";
import {
  signProxyToken,
  verifyProxyToken,
  type ProxyPayload,
} from "./sign.js";

export interface ProxyHandlerOptions {
  secret: string;
  logger: LoggerLike;
  fetchImpl?: typeof fetch;
  allowPrivateHosts?: boolean;
  maxRedirects?: number;
  maxPlaylistBytes?: number;
}

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_PLAYLIST_BYTES = 5 * 1024 * 1024;
const HLS_CONTENT_TYPE = "application/vnd.apple.mpegurl";
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const URI_TAG = /^#EXT-X-(?:SESSION-KEY|KEY|MAP|MEDIA|I-FRAME-STREAM-INF):/;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

class ProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxyError";
  }
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function parseIpv6(value: string): number[] | null {
  let address = value.toLowerCase();
  const zoneIndex = address.indexOf("%");
  if (zoneIndex >= 0) address = address.slice(0, zoneIndex);

  const lastColon = address.lastIndexOf(":");
  if (lastColon < 0) return null;
  const tail = address.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = parseIpv4(tail);
    if (!octets) return null;
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    address = `${address.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const tailGroups = halves.length === 2 && halves[1] !== "" ? (halves[1] ?? "").split(":") : [];

  let groups: string[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const missing = 8 - head.length - tailGroups.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<string>(missing).fill("0"), ...tailGroups];
  }

  if (groups.length !== 8) return null;
  const parsed: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    parsed.push(Number.parseInt(group, 16));
  }
  return parsed;
}

function isPrivateIpv6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;

  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateIpv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true;
  if ((g0 & 0xff00) === 0xff00) return true;
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  let value = ip.trim();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);

  const family = isIP(value);
  if (family === 4) {
    const octets = parseIpv4(value);
    return octets ? isPrivateIpv4(octets) : true;
  }
  if (family === 6) {
    const groups = parseIpv6(value);
    return groups ? isPrivateIpv6(groups) : true;
  }
  return true;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true });
  return results.map((entry) => entry.address);
}

export async function assertUrlAllowed(
  targetUrl: string,
  allowPrivateHosts = false,
  resolveHost: (hostname: string) => Promise<string[]> = defaultResolveHost,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    throw new ProxyError("invalid target url");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProxyError("unsupported target protocol");
  }
  if (allowPrivateHosts) return;

  let hostname = url.hostname;
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  if (!hostname) throw new ProxyError("target has no host");

  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) throw new ProxyError("target address is not allowed");
    return;
  }

  let addresses: string[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    throw new ProxyError("target dns resolution failed");
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new ProxyError("target resolved to no addresses");
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) throw new ProxyError("target address is not allowed");
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function resolvePlaylistUri(uri: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(uri, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

export function rewriteHlsPlaylist(
  playlist: string,
  baseUrl: string,
  makeProxyUrl: (absoluteUrl: string) => string,
): string {
  const hasBom = playlist.startsWith("\uFEFF");
  const source = hasBom ? playlist.slice(1) : playlist;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r\n|\n|\r/);

  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed === "") return line;

    if (trimmed.startsWith("#")) {
      if (!URI_TAG.test(trimmed)) return line;
      return line.replace(/URI="([^"]*)"/g, (match, uri: string) => {
        const resolved = resolvePlaylistUri(uri, baseUrl);
        return resolved ? `URI="${makeProxyUrl(resolved)}"` : match;
      });
    }

    const resolved = resolvePlaylistUri(trimmed, baseUrl);
    return resolved ? makeProxyUrl(resolved) : line;
  });

  const output = rewritten.join(newline);
  return hasBom ? `\uFEFF${output}` : output;
}

function isSafeForwardHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (!name || /[\r\n]/.test(name)) return false;
  if (HOP_BY_HOP_HEADERS.has(lower)) return false;
  if (lower.startsWith("proxy-")) return false;
  if (lower === "accept-encoding" || lower === "range" || lower === "if-range") return false;
  return true;
}

function buildUpstreamHeaders(payload: ProxyPayload, req: Request): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(payload.h ?? {})) {
    if (typeof value !== "string") continue;
    if (!isSafeForwardHeader(name) || /[\r\n]/.test(value)) continue;
    headers[name] = value;
  }

  const range = req.get("range");
  const ifRange = req.get("if-range");
  if (range) headers.Range = range;
  if (ifRange) headers["If-Range"] = ifRange;
  headers["Accept-Encoding"] = "identity";

  return headers;
}

function isPlaylistUrl(targetUrl: string): boolean {
  try {
    return new URL(targetUrl).pathname.toLowerCase().endsWith(".m3u8");
  } catch {
    return false;
  }
}

function safeLogTarget(targetUrl: string): { host?: string; path?: string } {
  try {
    const url = new URL(targetUrl);
    return { host: url.hostname, path: url.pathname };
  } catch {
    return {};
  }
}

function buildProxyBase(req: Request, token: string): string {
  const host = req.get("host") ?? "localhost";
  const rawPath = (req.originalUrl || req.url || "").split("?")[0] ?? "";
  const tokenSegment = `/${token}`;
  const index = token === "" ? -1 : rawPath.lastIndexOf(tokenSegment);
  const prefix = index >= 0 ? rawPath.slice(0, index + 1) : "/proxy/";
  return `${req.protocol}://${host}${prefix}`;
}

async function cancelBody(response: FetchResponse): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be closed or locked; nothing to do.
  }
}

async function readPlaylist(response: FetchResponse, limit: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) {
    await cancelBody(response);
    throw new ProxyError("playlist too large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new ProxyError("playlist too large");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore a locked reader after cancellation.
    }
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function fetchFollowingRedirects(
  targetUrl: string,
  req: Request,
  payload: ProxyPayload,
  options: Required<Pick<ProxyHandlerOptions, "allowPrivateHosts" | "maxRedirects">> & {
    fetchImpl: typeof fetch;
    signal: AbortSignal;
  },
): Promise<{ response: FetchResponse; finalUrl: string }> {
  const headers = buildUpstreamHeaders(payload, req);
  let currentUrl = targetUrl;

  for (let redirects = 0; ; redirects += 1) {
    await assertUrlAllowed(currentUrl, options.allowPrivateHosts);
    const response = await options.fetchImpl(currentUrl, {
      method: req.method,
      headers,
      redirect: "manual",
      signal: options.signal,
    });

    const location = response.headers.get("location");
    if (!REDIRECT_STATUS.has(response.status) || !location) {
      return { response, finalUrl: currentUrl };
    }

    await cancelBody(response);
    if (redirects >= options.maxRedirects) {
      throw new ProxyError("too many redirects");
    }

    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new ProxyError("invalid redirect location");
    }
    if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
      throw new ProxyError("unsupported redirect protocol");
    }
    currentUrl = nextUrl.toString();
  }
}

function copyUpstreamHeaders(response: FetchResponse, res: ExpressResponse): void {
  for (const name of [
    "content-type",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "cache-control",
  ]) {
    const value = response.headers.get(name);
    if (value !== null) res.setHeader(name, value);
  }

  if (!response.headers.get("content-encoding")) {
    const length = response.headers.get("content-length");
    if (length !== null) res.setHeader("content-length", length);
  }
}

function sendProxyError(res: ExpressResponse): void {
  if (res.writableEnded) return;
  if (res.headersSent || res.destroyed) {
    if (!res.destroyed) res.destroy();
    return;
  }
  res.status(502).json({ error: "bad gateway" });
}

async function handleProxyRequest(
  req: Request,
  res: ExpressResponse,
  options: {
    secret: string;
    logger: LoggerLike;
    fetchImpl: typeof fetch;
    allowPrivateHosts: boolean;
    maxRedirects: number;
    maxPlaylistBytes: number;
  },
): Promise<void> {
  const startedAt = Date.now();

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const token = typeof req.params.token === "string" ? req.params.token : "";
  const payload = token ? verifyProxyToken(token, options.secret) : null;
  if (!payload || !isHttpUrl(payload.u)) {
    options.logger.warn("proxy_forbidden", { status: 403 });
    res.status(403).json({ error: "forbidden" });
    return;
  }

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const onClose = (): void => {
    if (!res.writableEnded) abort();
  };
  res.once("close", onClose);
  req.once("aborted", abort);

  let loggedUrl = payload.u;

  try {
    const { response, finalUrl } = await fetchFollowingRedirects(
      payload.u,
      req,
      payload,
      {
        allowPrivateHosts: options.allowPrivateHosts,
        maxRedirects: options.maxRedirects,
        fetchImpl: options.fetchImpl,
        signal: controller.signal,
      },
    );
    loggedUrl = finalUrl;

    const logFields = safeLogTarget(finalUrl);
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const isPlaylist = isPlaylistUrl(finalUrl) || contentType.includes("mpegurl");

    if (isPlaylist && req.method === "GET") {
      if (response.status < 200 || response.status >= 300) {
        await cancelBody(response);
        res.status(response.status).end();
        options.logger.warn("proxy_upstream_error", {
          ...logFields,
          status: response.status,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      const playlist = await readPlaylist(response, options.maxPlaylistBytes);
      const proxyBase = buildProxyBase(req, token);
      const rewritten = rewriteHlsPlaylist(playlist, finalUrl, (absoluteUrl) => {
        const segmentPayload: ProxyPayload = { u: absoluteUrl, e: payload.e };
        if (payload.h) segmentPayload.h = payload.h;
        return `${proxyBase}${signProxyToken(segmentPayload, options.secret)}`;
      });

      res.status(200);
      res.setHeader("Content-Type", HLS_CONTENT_TYPE);
      res.send(rewritten);
      options.logger.debug("proxy_hls", {
        ...logFields,
        status: 200,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    res.status(response.status);
    copyUpstreamHeaders(response, res);

    if (req.method === "HEAD" || !response.body) {
      res.end();
    } else {
      const body = Readable.fromWeb(
        response.body as unknown as NodeWebReadableStream<Uint8Array>,
      );
      await pipeline(body, res);
    }

    options.logger.debug("proxy_response", {
      ...logFields,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
  } catch {
    if (controller.signal.aborted) return;

    options.logger.warn("proxy_error", {
      ...safeLogTarget(loggedUrl),
      status: 502,
      durationMs: Date.now() - startedAt,
    });
    sendProxyError(res);
  } finally {
    res.off("close", onClose);
    req.off("aborted", abort);
  }
}

export function createProxyHandler(options: ProxyHandlerOptions): RequestHandler {
  const settings = {
    secret: options.secret,
    logger: options.logger,
    fetchImpl: options.fetchImpl ?? nativeFetch,
    allowPrivateHosts: options.allowPrivateHosts === true,
    maxRedirects:
      options.maxRedirects !== undefined
        ? Math.max(0, Math.floor(options.maxRedirects))
        : DEFAULT_MAX_REDIRECTS,
    maxPlaylistBytes:
      options.maxPlaylistBytes !== undefined
        ? Math.max(0, Math.floor(options.maxPlaylistBytes))
        : DEFAULT_MAX_PLAYLIST_BYTES,
  };

  return (req, res): void => {
    void handleProxyRequest(req, res, settings);
  };
}
