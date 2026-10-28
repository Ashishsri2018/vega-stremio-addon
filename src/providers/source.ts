import { createHash } from "node:crypto";
import type { LoggerLike } from "../types.js";
import { nativeFetch } from "../util/nativeFetch.js";

export interface SourceClientOptions {
  repo: string;
  branch: string;
  token?: string | null;
  logger: LoggerLike;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  apiBaseUrl?: string;
  rawBaseUrl?: string;
}

const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_RAW_BASE = "https://raw.githubusercontent.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;

export class SourceHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SourceHttpError";
    this.status = status;
  }
}

function encodePath(value: string): string {
  return value
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function joinBase(base: string, ...suffixes: string[]): string {
  return `${base.replace(/\/+$/, "")}/${suffixes.join("/")}`;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class SourceClient {
  private readonly repo: string;
  private readonly branch: string;
  private readonly token: string | null;
  private readonly logger: LoggerLike;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly apiBase: string;
  private readonly rawBase: string;

  constructor(options: SourceClientOptions) {
    this.repo = options.repo;
    this.branch = options.branch;
    this.token = options.token ?? null;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? nativeFetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.apiBase = options.apiBaseUrl ?? DEFAULT_API_BASE;
    this.rawBase = options.rawBaseUrl ?? DEFAULT_RAW_BASE;
  }

  async resolveHead(
    currentEtag?: string | null,
  ): Promise<
    | { notModified: true; sha: string | null }
    | { notModified: false; sha: string; etag: string | null }
  > {
    const url = joinBase(
      this.apiBase,
      "repos",
      encodePath(this.repo),
      "commits",
      encodeURIComponent(this.branch),
    );
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "vega-stremio-addon",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (currentEtag) headers["If-None-Match"] = currentEtag;

    const { response, body } = await this.request(url, { headers }, "github-head");
    if (response.status === 304) {
      this.logger.debug("source_head_not_modified");
      return { notModified: true, sha: null };
    }
    if (!response.ok) {
      throw new SourceHttpError(
        `GitHub API request failed with status ${response.status}`,
        response.status,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripBom(body.toString("utf8")));
    } catch {
      throw new Error("GitHub API returned invalid JSON");
    }
    if (!isRecord(parsed) || typeof parsed.sha !== "string" || parsed.sha.length === 0) {
      throw new Error("GitHub API response is missing a commit sha");
    }
    const etag = response.headers.get("etag");
    return { notModified: false, sha: parsed.sha, etag };
  }

  async fetchFile(sha: string | null, filePath: string): Promise<Buffer> {
    const encodedPath = encodePath(filePath);
    let url: string;
    if (sha) {
      url = joinBase(
        this.rawBase,
        encodePath(this.repo),
        encodeURIComponent(sha),
        encodedPath,
      );
    } else {
      const branchPath = this.branch
        .split("/")
        .filter((segment) => segment.length > 0)
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      url = `${joinBase(
        this.rawBase,
        encodePath(this.repo),
        "refs",
        "heads",
        branchPath,
        encodedPath,
      )}?t=${Date.now()}`;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const { response, body } = await this.request(url, { headers: {} }, "raw");
        if (!response.ok) {
          throw new SourceHttpError(
            `Raw download failed with status ${response.status} for ${filePath}`,
            response.status,
          );
        }
        return body;
      } catch (error) {
        lastError = error;
        if (attempt === 1) {
          this.logger.warn("source_raw_retry", {
            file: filePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Raw download failed for ${filePath}`);
  }

  async fetchJson<T>(sha: string | null, filePath: string): Promise<T> {
    const body = await this.fetchFile(sha, filePath);
    try {
      return JSON.parse(stripBom(body.toString("utf8"))) as T;
    } catch {
      throw new Error(`Invalid JSON in ${filePath}`);
    }
  }

  private async request(
    url: string,
    init: RequestInit,
    label: string,
  ): Promise<{ response: Response; body: Buffer }> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`${label} request timed out`));
    }, this.timeoutMs);
    timer.unref?.();

    try {
      const response = await this.fetchImpl(url, {
        ...init,
        redirect: "follow",
        signal: controller.signal,
      });
      if (response.status === 304) {
        await response.body?.cancel().catch(() => undefined);
        return { response, body: Buffer.alloc(0) };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { response, body: Buffer.alloc(0) };
      }

      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Response exceeds the ${MAX_FILE_BYTES} byte limit`);
      }

      if (!response.body) {
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length > MAX_FILE_BYTES) {
          throw new Error(`Response exceeds the ${MAX_FILE_BYTES} byte limit`);
        }
        return { response, body };
      }

      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > MAX_FILE_BYTES) {
            controller.abort(new Error("Response size limit exceeded"));
            await reader.cancel().catch(() => undefined);
            throw new Error(`Response exceeds the ${MAX_FILE_BYTES} byte limit`);
          }
          chunks.push(Buffer.from(value));
        }
      }
      return { response, body: Buffer.concat(chunks, total) };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`${label} request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function computeBranchSnapshotSha(manifestBytes: Buffer, urlsBytes: Buffer): string {
  const hash = createHash("sha256");
  hash.update(manifestBytes);
  hash.update(Buffer.from([0]));
  hash.update(urlsBytes);
  return `branch-${hash.digest("hex").slice(0, 16)}`;
}
