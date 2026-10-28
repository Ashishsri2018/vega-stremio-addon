import { createRequire } from "node:module";
import { STATUS_CODES } from "node:http";
import zlib from "node:zlib";
import { Semaphore } from "../../util/concurrency.js";
import { nativeFetch } from "../../util/nativeFetch.js";
import type {
  CookieJarApi,
  HttpRequestOptions,
  HttpResponseData,
  HttpTransportApi,
  LoggerLike,
} from "../../types.js";

const requireModule = createRequire(import.meta.url);

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_PER_HOST = 6;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface HttpTransportOptions {
  cookieJar: CookieJarApi;
  logger: LoggerLike;
  defaultTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  maxPerHost?: number;
  impersonate?: string;
  useCurlCffi?: boolean;
}

interface CurlResponseLike {
  status: number;
  statusText?: string;
  url?: string;
  headers?: unknown;
  buffer(): Buffer;
}

type CurlHelper = (url: string, options: Record<string, unknown>) => Promise<CurlResponseLike>;

interface CurlApiLike {
  get: CurlHelper;
  post?: CurlHelper;
  put?: CurlHelper;
  delete?: CurlHelper;
  del?: CurlHelper;
  patch?: CurlHelper;
  head?: CurlHelper;
}

class ResponseSizeError extends Error {
  constructor(maxBytes: number) {
    super(`Response body exceeds maximum size of ${maxBytes} bytes`);
    this.name = "ResponseSizeError";
  }
}

function defaultStatusText(status: number): string {
  return STATUS_CODES[status] ?? "OK";
}

function headerName(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === target);
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return headerName(headers, name) !== undefined;
}

function copyHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value !== undefined && value !== null) result[key] = String(value);
  }
  return result;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function makeAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error("Request aborted") as Error & { code?: string };
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function appendHeader(
  gathered: Map<string, string[]>,
  name: string,
  value: string,
): void {
  const key = name.trim().toLowerCase();
  if (!key) return;
  const existing = gathered.get(key);
  if (existing) existing.push(value);
  else gathered.set(key, [value]);
}

function collectHeaders(headers: unknown): {
  headers: Record<string, string>;
  setCookies: string[];
} {
  const gathered = new Map<string, string[]>();

  if (typeof headers === "string") {
    for (const line of headers.split(/\r?\n/)) {
      const index = line.indexOf(":");
      if (index <= 0) continue;
      appendHeader(gathered, line.slice(0, index), line.slice(index + 1).trim());
    }
  } else if (headers && typeof headers === "object") {
    const candidate = headers as {
      entries?: () => IterableIterator<[string, string]>;
      forEach?: (callback: (value: string, key: string) => void) => void;
      getAll?: (name: string) => string[];
      get?: (name: string) => string | null;
      getSetCookie?: () => string[];
    };

    let setCookieValues: string[] | undefined;
    if (typeof candidate.getSetCookie === "function") {
      const values = candidate.getSetCookie();
      if (Array.isArray(values) && values.length > 0) setCookieValues = values.map(String);
    }
    if ((!setCookieValues || setCookieValues.length === 0) && typeof candidate.getAll === "function") {
      const values = candidate.getAll("set-cookie");
      if (Array.isArray(values) && values.length > 0) setCookieValues = values.map(String);
    }

    if (typeof candidate.entries === "function") {
      for (const [key, value] of candidate.entries()) {
        if (key.toLowerCase() === "set-cookie") continue;
        appendHeader(gathered, key, String(value));
      }
    } else if (typeof candidate.forEach === "function") {
      candidate.forEach((value, key) => {
        if (key.toLowerCase() === "set-cookie") return;
        appendHeader(gathered, key, String(value));
      });
    } else {
      for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        if (key.toLowerCase() === "set-cookie") {
          const list = Array.isArray(value) ? value : [value];
          for (const item of list) appendHeader(gathered, key, String(item));
          continue;
        }
        if (Array.isArray(value)) {
          for (const item of value) appendHeader(gathered, key, String(item));
        } else if (value !== undefined && value !== null) {
          appendHeader(gathered, key, String(value));
        }
      }
    }

    if (!setCookieValues || setCookieValues.length === 0) {
      if (typeof candidate.get === "function") {
        const value = candidate.get("set-cookie");
        if (value) setCookieValues = [value];
      }
    }
    if (setCookieValues) {
      for (const value of setCookieValues) appendHeader(gathered, "set-cookie", value);
    }
  }

  const record: Record<string, string> = {};
  const setCookies: string[] = [];
  for (const [key, values] of gathered) {
    record[key] = values.join(", ");
    if (key === "set-cookie") setCookies.push(...values);
  }
  return { headers: record, setCookies };
}

type ZlibCallback = (error: Error | null, result: Buffer) => void;
type ZlibAsync = (
  buffer: Buffer,
  options: zlib.ZlibOptions,
  callback: ZlibCallback,
) => void;

function runZlib(fn: ZlibAsync, body: Buffer, maxOutputLength: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    fn(body, { maxOutputLength }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function isBufferTooLarge(error: unknown): boolean {
  if (error instanceof ResponseSizeError) return true;
  const candidate = error as { code?: string; message?: string } | null;
  return (
    candidate?.code === "ERR_BUFFER_TOO_LARGE" ||
    /maxOutputLength|buffer too large|cannot create a buffer larger/i.test(
      candidate?.message ?? "",
    )
  );
}

async function decodeContent(
  body: Buffer,
  contentEncoding: string | undefined,
  maxBytes: number,
): Promise<Buffer> {
  const encodings = (contentEncoding ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0 && value !== "identity")
    .reverse();
  if (encodings.length === 0) return body;

  let decoded = body;
  for (const encoding of encodings) {
    try {
      if (encoding === "gzip" || encoding === "x-gzip") {
        decoded = await runZlib(zlib.gunzip, decoded, maxBytes);
      } else if (encoding === "br") {
        decoded = await runZlib(zlib.brotliDecompress, decoded, maxBytes);
      } else if (encoding === "deflate") {
        try {
          decoded = await runZlib(zlib.inflate, decoded, maxBytes);
        } catch (error) {
          if (isBufferTooLarge(error)) throw error;
          decoded = await runZlib(zlib.inflateRaw, decoded, maxBytes);
        }
      }
    } catch (error) {
      if (isBufferTooLarge(error)) throw new ResponseSizeError(maxBytes);
      throw error;
    }
  }
  return decoded;
}

async function readResponseBody(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          throw new ResponseSizeError(maxBytes);
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released after cancel/abort.
    }
  }
  return Buffer.concat(chunks, total);
}

function resolveCurlApi(loaded: unknown): CurlApiLike | null {
  if (!loaded || typeof loaded !== "object") return null;
  const direct = loaded as Partial<CurlApiLike>;
  const fallback =
    "default" in loaded
      ? ((loaded as { default?: Partial<CurlApiLike> }).default ?? null)
      : null;
  const candidate =
    typeof direct.get === "function"
      ? direct
      : fallback && typeof fallback.get === "function"
        ? fallback
        : null;
  if (!candidate || typeof candidate.get !== "function") return null;
  return candidate as CurlApiLike;
}

export class HttpTransport implements HttpTransportApi {
  private readonly cookieJar: CookieJarApi;
  private readonly logger: LoggerLike;
  private readonly defaultTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxResponseBytes: number;
  private readonly maxPerHost: number;
  private readonly impersonate: string;
  private readonly useCurlCffi: boolean;
  private readonly hostSemaphores = new Map<string, Semaphore>();

  private curlApi: CurlApiLike | null | undefined;
  private curlBroken = false;
  private curlWarningLogged = false;

  constructor(options: HttpTransportOptions) {
    this.cookieJar = options.cookieJar;
    this.logger = options.logger;
    this.defaultTimeoutMs = Math.max(1, options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? nativeFetch;
    this.maxResponseBytes = Math.max(
      1,
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.maxPerHost = Math.max(1, options.maxPerHost ?? DEFAULT_MAX_PER_HOST);
    this.impersonate = options.impersonate ?? "chrome120";
    this.useCurlCffi = options.useCurlCffi !== false;
  }

  async request(options: HttpRequestOptions): Promise<HttpResponseData> {
    const timeoutMs = Math.max(1, options.timeoutMs ?? this.defaultTimeoutMs);
    const semaphore = this.semaphoreFor(options.url);
    return semaphore.run(() => this.performRequest(options, timeoutMs));
  }

  private semaphoreFor(url: string): Semaphore {
    const host = hostnameOf(url) || "invalid";
    let semaphore = this.hostSemaphores.get(host);
    if (!semaphore) {
      semaphore = new Semaphore(this.maxPerHost);
      this.hostSemaphores.set(host, semaphore);
    }
    return semaphore;
  }

  private async performRequest(
    options: HttpRequestOptions,
    timeoutMs: number,
  ): Promise<HttpResponseData> {
    if (options.signal?.aborted) throw makeAbortError(options.signal.reason);
    const headers = await this.prepareHeaders(options.url, options.headers);
    const prepared: HttpRequestOptions = { ...options, headers };

    if (this.useCurlCffi && !this.curlBroken) {
      try {
        return await this.curlRequest(prepared, timeoutMs);
      } catch (error) {
        this.disableCurl(error);
      }
    }
    return this.nativeRequest(prepared, timeoutMs);
  }

  private async prepareHeaders(
    url: string,
    headers: Record<string, string> | undefined,
  ): Promise<Record<string, string>> {
    let result = copyHeaders(headers);
    if (hostnameOf(url) !== "raw.githubusercontent.com") {
      result = await this.cookieJar.mergeRequestHeaders(url, result);
    }
    const acceptEncoding = headerName(result, "accept-encoding");
    if (acceptEncoding) delete result[acceptEncoding];
    return result;
  }

  private disableCurl(error: unknown): void {
    this.curlBroken = true;
    this.curlApi = null;
    if (!this.curlWarningLogged) {
      this.curlWarningLogged = true;
      this.logger.warn("http.curl_cffi_unavailable", {
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  private getCurlApi(): CurlApiLike | null {
    if (!this.useCurlCffi || this.curlBroken) return null;
    if (this.curlApi !== undefined) return this.curlApi;
    try {
      const loaded: unknown = requireModule("curl-cffi-node");
      const api = resolveCurlApi(loaded);
      if (!api) throw new Error("curl-cffi-node did not expose HTTP helpers");
      this.curlApi = api;
      return api;
    } catch (error) {
      this.disableCurl(error);
      return null;
    }
  }

  private curlHelper(api: CurlApiLike, method: string): CurlHelper | null {
    switch (method) {
      case "GET":
        return api.get;
      case "POST":
        return api.post ?? null;
      case "PUT":
        return api.put ?? null;
      case "DELETE":
        return api.delete ?? api.del ?? null;
      case "PATCH":
        return api.patch ?? null;
      case "HEAD":
        return api.head ?? null;
      default:
        return null;
    }
  }

  private async curlRequest(
    options: HttpRequestOptions,
    timeoutMs: number,
  ): Promise<HttpResponseData> {
    const api = this.getCurlApi();
    if (!api) throw new Error("curl-cffi-node is unavailable");
    const method = (options.method ?? "GET").toUpperCase();
    const helper = this.curlHelper(api, method);
    if (!helper) throw new Error(`curl-cffi-node has no helper for ${method}`);

    const followRedirects = options.redirect !== "manual";
    const response = await helper(options.url, {
      headers: options.headers ?? {},
      data: options.body,
      impersonate: this.impersonate,
      verify: false,
      allowRedirects: followRedirects,
      followRedirects,
      timeout: timeoutMs / 1000,
    });

    if (!response || typeof response.buffer !== "function") {
      throw new Error("curl-cffi-node returned an unexpected response");
    }

    const collected = collectHeaders(response.headers);
    const rawBody = bufferFrom(response.buffer());
    const body = await this.decodeBody(rawBody, collected.headers["content-encoding"]);
    const url = response.url || options.url;
    const status = Number(response.status);
    this.captureCookies(url, collected.setCookies);
    return {
      status,
      statusText: response.statusText || defaultStatusText(status),
      url,
      headers: collected.headers,
      body,
    };
  }

  private async decodeBody(
    body: Buffer,
    contentEncoding: string | undefined,
  ): Promise<Buffer> {
    let decoded = body;
    if (contentEncoding) {
      try {
        decoded = await decodeContent(body, contentEncoding, this.maxResponseBytes);
      } catch (error) {
        if (isBufferTooLarge(error) || error instanceof ResponseSizeError) throw error;
        // Some HTTP stacks transparently decode while keeping the
        // content-encoding header, so failed decodes leave the bytes alone.
        decoded = body;
      }
    }
    if (decoded.length > this.maxResponseBytes) {
      throw new ResponseSizeError(this.maxResponseBytes);
    }
    return decoded;
  }

  private async nativeRequest(
    options: HttpRequestOptions,
    timeoutMs: number,
  ): Promise<HttpResponseData> {
    const controller = new AbortController();
    const callerSignal = options.signal;
    let callerAbort: (() => void) | undefined;
    if (callerSignal) {
      if (callerSignal.aborted) {
        controller.abort(callerSignal.reason);
      } else {
        callerAbort = () => controller.abort(callerSignal.reason);
        callerSignal.addEventListener("abort", callerAbort, { once: true });
      }
    }

    const timeoutError = (): Error => {
      const error = new Error(`HTTP request timed out after ${timeoutMs}ms`);
      error.name = "TimeoutError";
      (error as Error & { code?: string }).code = "ETIMEDOUT";
      return error;
    };

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = timeoutError();
        controller.abort(error);
        reject(error);
      }, timeoutMs);
      timer.unref?.();
    });

    const headers = copyHeaders(options.headers);
    if (!hasHeader(headers, "user-agent")) headers["User-Agent"] = DEFAULT_USER_AGENT;
    const method = (options.method ?? "GET").toUpperCase();
    const init: RequestInit = {
      method,
      headers,
      redirect: options.redirect === "manual" ? "manual" : "follow",
      signal: controller.signal,
    };
    if (options.body !== undefined && method !== "GET" && method !== "HEAD") {
      init.body = options.body as unknown as RequestInit["body"];
    }

    const work = (async (): Promise<HttpResponseData> => {
      const response = await this.fetchImpl(options.url, init);
      const collected = collectHeaders(response.headers);
      const finalUrl = response.url || options.url;
      this.captureCookies(finalUrl, collected.setCookies);
      const rawBody = await readResponseBody(response, this.maxResponseBytes, controller);
      const body = await this.decodeBody(
        rawBody,
        collected.headers["content-encoding"],
      );
      return {
        status: response.status,
        statusText: response.statusText || defaultStatusText(response.status),
        url: finalUrl,
        headers: collected.headers,
        body,
      };
    })();

    try {
      return await Promise.race([work, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
      if (callerAbort && callerSignal) {
        callerSignal.removeEventListener("abort", callerAbort);
      }
      work.catch(() => undefined);
    }
  }

  private captureCookies(url: string, setCookies: string[]): void {
    if (setCookies.length === 0) return;
    try {
      this.cookieJar.captureFromResponse(url, setCookies);
    } catch (error) {
      this.logger.warn("http.cookie_capture_failed", {
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}

function bufferFrom(value: Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}
