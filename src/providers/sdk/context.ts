import axios, { AxiosError, AxiosHeaders } from "axios";
import type {
  AxiosAdapter,
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";
import * as cheerio from "cheerio";
import type {
  CookieJarApi,
  HttpRequestOptions,
  HttpTransportApi,
  KVStoreApi,
  LoggerLike,
  ProviderContextLike,
  UrlsSnapshot,
} from "../../types.js";

const COMMON_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "Cache-Control": "max-age=0",
};

const SNAPSHOT_PATH_OWNER = "zenda-cross";
const SNAPSHOT_PATH_REPO = "vega-providers";
const RAW_GITHUB_HOST = "raw.githubusercontent.com";

interface TransportResponseInit {
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

class ResponseHeaders {
  private readonly map = new Map<string, string>();

  constructor(headers: Record<string, string>) {
    for (const [key, value] of Object.entries(headers)) {
      this.map.set(key.toLowerCase(), value);
    }
  }

  get(name: string): string | null {
    return this.map.get(name.toLowerCase()) ?? null;
  }

  has(name: string): boolean {
    return this.map.has(name.toLowerCase());
  }

  entries(): IterableIterator<[string, string]> {
    return this.map.entries();
  }

  keys(): IterableIterator<string> {
    return this.map.keys();
  }

  values(): IterableIterator<string> {
    return this.map.values();
  }

  forEach(callback: (value: string, key: string, parent: ResponseHeaders) => void): void {
    for (const [key, value] of this.map) callback(value, key, this);
  }
}

class TransportResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly headers: ResponseHeaders;
  private readonly body: Buffer;

  constructor(init: TransportResponseInit) {
    this.status = init.status;
    this.statusText = init.statusText;
    this.url = init.url;
    this.headers = new ResponseHeaders(init.headers);
    this.body = init.body;
    this.ok = init.status >= 200 && init.status < 300;
  }

  async text(): Promise<string> {
    return this.body.toString("utf8");
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }

  async buffer(): Promise<Buffer> {
    return Buffer.from(this.body);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const copy = new ArrayBuffer(this.body.byteLength);
    new Uint8Array(copy).set(this.body);
    return copy;
  }
}

let previousServedUrls: UrlsSnapshot | null = null;

function isSnapshotUrl(url: URL): boolean {
  if (url.hostname.toLowerCase() !== RAW_GITHUB_HOST) return false;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4) return false;
  return (
    parts[0]?.toLowerCase() === SNAPSHOT_PATH_OWNER &&
    parts[1]?.toLowerCase() === SNAPSHOT_PATH_REPO &&
    parts[parts.length - 1]?.toLowerCase() === "urls.json"
  );
}

function mergeWithPrevious(current: UrlsSnapshot): UrlsSnapshot {
  const merged: UrlsSnapshot = { ...current };
  if (previousServedUrls) {
    for (const [key, value] of Object.entries(previousServedUrls)) {
      if (!Object.prototype.hasOwnProperty.call(merged, key)) merged[key] = value;
    }
  }
  previousServedUrls = { ...merged };
  return merged;
}

function headerRecord(source: RequestInit["headers"]): Record<string, string> {
  const result: Record<string, string> = {};
  if (!source) return result;
  if (source instanceof Headers) {
    source.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  if (Array.isArray(source)) {
    for (const [key, value] of source) result[String(key)] = String(value);
    return result;
  }
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    result[key] = Array.isArray(value) ? value.map(String).join(", ") : String(value);
  }
  return result;
}

async function bodyFromInit(
  body: RequestInit["body"],
): Promise<string | Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new TypeError("Unsupported fetch request body type");
}

function fetchInit(options: {
  transport: HttpTransportApi;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Buffer;
  signal?: AbortSignal;
  redirect: "follow" | "manual";
}): Promise<TransportResponse> {
  const request: HttpRequestOptions = {
    url: options.url,
    method: options.method,
    headers: options.headers,
    redirect: options.redirect,
  };
  if (options.body !== undefined) request.body = options.body;
  if (options.signal) request.signal = options.signal;
  return options.transport.request(request).then((response) => new TransportResponse(response));
}

function combineBaseUrl(config: InternalAxiosRequestConfig): string {
  const url = config.url ?? "";
  if (!config.baseURL || /^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  return `${config.baseURL.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`;
}

function formatParam(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

function appendParams(url: string, params: unknown): string {
  if (params === undefined || params === null) return url;
  const search = new URLSearchParams();
  if (params instanceof URLSearchParams) {
    params.forEach((value, key) => search.append(key, value));
  } else if (typeof params === "object") {
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item === undefined || item === null) continue;
          search.append(key, formatParam(item));
        }
      } else {
        search.append(key, formatParam(value));
      }
    }
  }
  if ([...search.keys()].length === 0) return url;
  try {
    const parsed = new URL(url);
    search.forEach((value, key) => parsed.searchParams.append(key, value));
    return parsed.toString();
  } catch {
    return `${url}${url.includes("?") ? "&" : "?"}${search.toString()}`;
  }
}

function axiosHeaderRecord(headers: InternalAxiosRequestConfig["headers"]): Record<string, string> {
  const result: Record<string, string> = {};
  const source =
    headers && typeof (headers as { toJSON?: () => unknown }).toJSON === "function"
      ? ((headers as { toJSON: () => Record<string, unknown> }).toJSON() ?? {})
      : (headers as unknown as Record<string, unknown>);
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value === undefined || value === null) continue;
    result[key] = Array.isArray(value) ? value.map(String).join(", ") : String(value);
  }
  return result;
}

function setHeaderIfMissing(headers: Record<string, string>, name: string, value: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return;
  }
  headers[name] = value;
}

function axiosData(
  data: unknown,
  headers: Record<string, string>,
): string | Buffer | undefined {
  if (data === undefined || data === null) return undefined;
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof URLSearchParams) {
    setHeaderIfMissing(headers, "Content-Type", "application/x-www-form-urlencoded");
    return data.toString();
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === "object") {
    setHeaderIfMissing(headers, "Content-Type", "application/json");
    return JSON.stringify(data);
  }
  return String(data);
}

function axiosErrorCode(error: unknown, aborted: boolean): string {
  const candidate = error as { name?: string; code?: string } | null;
  if (candidate?.name === "TimeoutError" || candidate?.code === "ETIMEDOUT") {
    return "ETIMEDOUT";
  }
  if (aborted || candidate?.name === "AbortError" || candidate?.code === "ABORT_ERR") {
    return "ERR_CANCELED";
  }
  return "ERR_NETWORK";
}

function createAxiosAdapter(transport: HttpTransportApi): AxiosAdapter {
  return async (config): Promise<AxiosResponse> => {
    const headers = axiosHeaderRecord(config.headers);
    const data = axiosData(config.data, headers);
    const url = appendParams(combineBaseUrl(config), config.params);
    const signal = config.signal as AbortSignal | undefined;

    const request: HttpRequestOptions = {
      url,
      method: (config.method ?? "GET").toUpperCase(),
      headers,
      redirect: "follow",
    };
    if (data !== undefined) request.body = data;
    if (config.timeout && config.timeout > 0) request.timeoutMs = config.timeout;
    if (signal) request.signal = signal;

    let response;
    try {
      response = await transport.request(request);
    } catch (error) {
      const code = axiosErrorCode(error, Boolean((signal as { aborted?: boolean })?.aborted));
      const message = error instanceof Error ? error.message : String(error);
      throw new AxiosError(message, code, config, {}, undefined);
    }

    const contentType = response.headers["content-type"] ?? "";
    const responseType = config.responseType;
    let responseData: unknown;
    if (responseType === "arraybuffer" || responseType === "stream") {
      responseData = Buffer.from(response.body);
    } else {
      const text = response.body.toString("utf8");
      if (responseType === "json" || contentType.toLowerCase().includes("application/json")) {
        try {
          responseData = text.length > 0 ? JSON.parse(text) : text;
        } catch {
          responseData = text;
        }
      } else {
        responseData = text;
      }
    }

    const axiosResponse: AxiosResponse = {
      data: responseData,
      status: response.status,
      statusText: response.statusText,
      headers: AxiosHeaders.from(response.headers),
      config,
      request: {},
    };

    const validateStatus = config.validateStatus ?? ((status: number) => status >= 200 && status < 300);
    if (!validateStatus(response.status)) {
      throw new AxiosError(
        `Request failed with status code ${response.status}`,
        response.status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST",
        config,
        {},
        axiosResponse,
      );
    }
    return axiosResponse;
  };
}

export function createProviderContext(options: {
  transport: HttpTransportApi;
  kvStore: KVStoreApi;
  cookieJar: CookieJarApi;
  logger: LoggerLike;
}): ProviderContextLike {
  const axiosInstance: AxiosInstance = axios.create({
    adapter: createAxiosAdapter(options.transport),
  });

  const openWebView = async (): Promise<never> => {
    const error = new Error("WAF_REQUIRED: browser solver unavailable") as Error & {
      code?: string;
    };
    error.code = "WAF_REQUIRED";
    throw error;
  };

  return {
    axios: axiosInstance,
    commonHeaders: { ...COMMON_HEADERS },
    cheerio,
    openWebView,
    kvStore: options.kvStore,
    getCookies: (url: string) => options.cookieJar.getCookieMap(url),
  };
}

export function installGlobalFetch(options: {
  transport: HttpTransportApi;
  cookieJar: CookieJarApi;
  logger: LoggerLike;
  getActiveUrls: () => UrlsSnapshot | null;
}): void {
  previousServedUrls = null;

  const globalRecord = globalThis as typeof globalThis & {
    providerGlobal?: unknown;
  };
  if (!globalRecord.providerGlobal) globalRecord.providerGlobal = globalThis;

  const shim = async (input: string | URL | Request, init?: RequestInit): Promise<TransportResponse> => {
    const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const rawUrl = request ? request.url : input instanceof URL ? input.toString() : String(input);
    const parsedUrl = new URL(rawUrl);

    if (isSnapshotUrl(parsedUrl)) {
      const active = options.getActiveUrls();
      if (active !== null) {
        const merged = mergeWithPrevious(active);
        return new TransportResponse({
          status: 200,
          statusText: "OK",
          url: rawUrl,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(merged)),
        });
      }
    }

    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = init?.headers
      ? headerRecord(init.headers)
      : request
        ? headerRecord(request.headers)
        : {};
    const redirect =
      (init?.redirect ?? request?.redirect) === "manual" ? "manual" : "follow";
    const signal = init?.signal ?? request?.signal ?? undefined;

    let body: string | Buffer | undefined;
    if (init?.body !== undefined) {
      body = await bodyFromInit(init.body);
    } else if (request && method !== "GET" && method !== "HEAD" && !request.bodyUsed) {
      const buffer = Buffer.from(await request.arrayBuffer());
      body = buffer.length > 0 ? buffer : undefined;
    }

    return fetchInit({
      transport: options.transport,
      url: rawUrl,
      method,
      headers,
      body,
      signal: signal ?? undefined,
      redirect,
    });
  };

  globalThis.fetch = shim as unknown as typeof fetch;
}

export function clearProviderUrlCache(): void {
  delete (globalThis as typeof globalThis & {
    __vegaProviderBaseUrlCache__?: unknown;
  }).__vegaProviderBaseUrlCache__;
}
