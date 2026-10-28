import { isIP } from "node:net";
import { readJsonFile, writeJsonAtomic } from "../../util/fs.js";
import type { CookieJarApi, LoggerLike } from "../../types.js";

export interface CookieJarOptions {
  filePath: string;
  logger: LoggerLike;
  flushMs?: number;
  maxCookiesPerDomain?: number;
  maxTotalBytes?: number;
}

interface StoredCookie {
  value: string;
  expiresAt?: number;
  path?: string;
  createdAt: number;
}

interface PersistedCookieJar {
  version: 1;
  domains: Record<string, Record<string, StoredCookie>>;
}

interface ParsedSetCookie {
  name: string;
  value: string;
  expiresAt?: number;
  deleteCookie: boolean;
  domain?: string;
  path?: string;
}

const DEFAULT_FLUSH_MS = 500;
const DEFAULT_MAX_COOKIES_PER_DOMAIN = 100;
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024;

const MULTI_PART_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "net.uk",
  "sch.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "co.in",
  "net.in",
  "org.in",
  "firm.in",
  "gen.in",
  "ind.in",
  "com.br",
  "net.br",
  "org.br",
  "gov.br",
  "co.jp",
  "or.jp",
  "ne.jp",
  "ac.jp",
  "go.jp",
  "co.nz",
  "net.nz",
  "org.nz",
  "govt.nz",
  "co.za",
  "org.za",
  "net.za",
  "com.mx",
  "com.tr",
  "com.sg",
  "com.hk",
  "com.tw",
  "com.cn",
  "com.my",
  "com.ph",
  "com.vn",
  "com.pk",
  "com.bd",
  "com.eg",
  "com.sa",
  "com.ae",
  "com.ng",
  "com.ar",
  "com.co",
  "com.pe",
  "com.ve",
  "com.ec",
  "com.uy",
  "com.py",
  "com.bo",
  "com.do",
  "com.gt",
  "com.sv",
  "com.hn",
  "com.ni",
  "com.pa",
  "com.pr",
  "co.id",
  "co.th",
  "co.kr",
  "co.ke",
  "co.il",
]);

function normalizeHost(value: string): string {
  let host = value.trim().toLowerCase();
  if (host.startsWith("[")) host = host.replace(/^\[|\]$/g, "");
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

function isIpAddress(host: string): boolean {
  return isIP(host) !== 0;
}

function isPublicSuffix(domain: string): boolean {
  if (isIpAddress(domain)) return false;
  const labels = domain.split(".").filter(Boolean);
  if (labels.length <= 1) return true;
  return labels.length === 2 && MULTI_PART_SUFFIXES.has(domain);
}

function registrableDomain(host: string): string {
  const normalized = normalizeHost(host);
  if (!normalized) return "";
  if (isIpAddress(normalized)) return normalized;
  const labels = normalized.split(".").filter(Boolean);
  if (labels.length <= 2) return normalized;
  const suffix = labels.slice(-2).join(".");
  if (MULTI_PART_SUFFIXES.has(suffix)) {
    return labels.slice(-3).join(".");
  }
  return suffix;
}

function isDomainMatch(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function captureDomain(host: string, domainAttribute: string | undefined): string | null {
  const requestDomain = registrableDomain(host);
  if (!domainAttribute) return requestDomain || null;
  const attribute = normalizeHost(domainAttribute.replace(/^\.+/, ""));
  if (!attribute) return requestDomain || null;
  if (isIpAddress(host)) return attribute === host ? host : null;
  if (!isDomainMatch(host, attribute)) return null;
  if (isPublicSuffix(attribute)) {
    return attribute === host ? requestDomain || null : null;
  }
  return registrableDomain(attribute) || null;
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === "/") return true;
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function parseSetCookie(line: string, now: number): ParsedSetCookie | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const firstSemicolon = trimmed.indexOf(";");
  const pair = firstSemicolon === -1 ? trimmed : trimmed.slice(0, firstSemicolon);
  const equals = pair.indexOf("=");
  if (equals <= 0) return null;
  const name = pair.slice(0, equals).trim();
  if (!name) return null;
  const value = pair.slice(equals + 1).trim();

  let expiresAt: number | undefined;
  let maxAgeSeconds: number | undefined;
  let domain: string | undefined;
  let path: string | undefined;

  if (firstSemicolon !== -1) {
    for (const segment of trimmed.slice(firstSemicolon + 1).split(";")) {
      const attribute = segment.trim();
      if (!attribute) continue;
      const index = attribute.indexOf("=");
      const key = (index === -1 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
      const attributeValue = index === -1 ? "" : attribute.slice(index + 1).trim();
      if (key === "expires") {
        const parsed = Date.parse(attributeValue);
        if (Number.isFinite(parsed)) expiresAt = parsed;
      } else if (key === "max-age") {
        if (/^[+-]?\d+$/.test(attributeValue)) {
          const seconds = Number(attributeValue);
          if (Number.isFinite(seconds)) maxAgeSeconds = seconds;
        }
      } else if (key === "domain") {
        if (attributeValue) domain = attributeValue;
      } else if (key === "path") {
        if (attributeValue.startsWith("/")) path = attributeValue;
      }
    }
  }

  let deleteCookie = false;
  if (maxAgeSeconds !== undefined) {
    if (maxAgeSeconds <= 0) {
      deleteCookie = true;
      expiresAt = now;
    } else {
      expiresAt = now + maxAgeSeconds * 1000;
    }
  } else if (expiresAt !== undefined && expiresAt <= now) {
    deleteCookie = true;
  }

  return { name, value, expiresAt, deleteCookie, domain, path: path ?? "/" };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function parseStoredCookie(value: unknown): StoredCookie | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.value !== "string") return null;
  const createdAt =
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
      ? value.createdAt
      : Date.now();
  const cookie: StoredCookie = { value: value.value, createdAt };
  if (typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)) {
    cookie.expiresAt = value.expiresAt;
  }
  if (typeof value.path === "string" && value.path.startsWith("/")) {
    cookie.path = value.path;
  }
  return cookie;
}

export class CookieJar implements CookieJarApi {
  private readonly filePath: string;
  private readonly logger: LoggerLike;
  private readonly flushMs: number;
  private readonly maxCookiesPerDomain: number;
  private readonly maxTotalBytes: number;
  private readonly domains = new Map<string, Map<string, StoredCookie>>();

  private timer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private disposed = false;

  private constructor(options: CookieJarOptions) {
    this.filePath = options.filePath;
    this.logger = options.logger;
    this.flushMs = Math.max(0, options.flushMs ?? DEFAULT_FLUSH_MS);
    this.maxCookiesPerDomain = Math.max(
      1,
      options.maxCookiesPerDomain ?? DEFAULT_MAX_COOKIES_PER_DOMAIN,
    );
    this.maxTotalBytes = Math.max(1, options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES);
  }

  static async open(options: CookieJarOptions): Promise<CookieJar> {
    const jar = new CookieJar(options);
    await jar.load();
    return jar;
  }

  private async load(): Promise<void> {
    let data: unknown;
    try {
      data = await readJsonFile<unknown>(this.filePath);
    } catch {
      this.logger.error("cookie.load_failed", {
        message: "Cookie jar file could not be read or parsed",
      });
      return;
    }
    if (data === null) return;
    if (!isPlainObject(data) || !isPlainObject(data.domains)) {
      this.logger.error("cookie.load_failed", {
        message: "Cookie jar file does not contain a domains object",
      });
      return;
    }

    for (const [rawDomain, rawCookies] of Object.entries(data.domains)) {
      const domain = normalizeHost(rawDomain);
      if (!domain || !isPlainObject(rawCookies)) continue;
      const cookies = new Map<string, StoredCookie>();
      for (const [name, rawCookie] of Object.entries(rawCookies)) {
        if (!name) continue;
        const cookie = parseStoredCookie(rawCookie);
        if (cookie) cookies.set(name, cookie);
      }
      if (cookies.size > 0) this.domains.set(domain, cookies);
    }
    this.pruneExpired();
    this.enforceLimits();
  }

  async getCookieHeader(url: string): Promise<string | undefined> {
    const cookies = this.collectCookies(url);
    if (cookies.length === 0) return undefined;
    return cookies.map(([name, cookie]) => `${name}=${cookie.value}`).join("; ");
  }

  async getCookieMap(url: string): Promise<Record<string, string>> {
    return Object.fromEntries(
      this.collectCookies(url).map(([name, cookie]) => [name, cookie.value]),
    );
  }

  captureFromResponse(url: string, setCookie: string[]): void {
    if (setCookie.length === 0) return;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return;
    }
    const host = normalizeHost(parsedUrl.hostname);
    if (!host) return;
    const now = Date.now();
    let changed = false;

    for (const line of setCookie) {
      const parsed = parseSetCookie(line, now);
      if (!parsed) continue;
      const domain = captureDomain(host, parsed.domain);
      if (!domain) continue;

      let cookies = this.domains.get(domain);
      if (parsed.deleteCookie) {
        if (cookies?.delete(parsed.name)) changed = true;
        continue;
      }
      if (!cookies) {
        cookies = new Map<string, StoredCookie>();
        this.domains.set(domain, cookies);
      }
      cookies.set(parsed.name, {
        value: parsed.value,
        expiresAt: parsed.expiresAt,
        path: parsed.path,
        createdAt: now,
      });
      changed = true;
    }

    if (!changed) return;
    this.pruneExpired();
    this.enforceLimits();
    this.scheduleFlush();
  }

  async mergeRequestHeaders(
    url: string,
    headers: Record<string, string>,
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) result[key] = value;

    const cookies = this.collectCookies(url);
    if (cookies.length === 0) return result;

    const cookieKey = Object.keys(result).find((key) => key.toLowerCase() === "cookie");
    if (!cookieKey) {
      result.Cookie = cookies.map(([name, cookie]) => `${name}=${cookie.value}`).join("; ");
      return result;
    }

    const existingValue = result[cookieKey] ?? "";
    const present = new Set<string>();
    for (const segment of existingValue.split(";")) {
      const equals = segment.indexOf("=");
      const name = (equals === -1 ? segment : segment.slice(0, equals)).trim();
      if (name) present.add(name);
    }
    const missing = cookies.filter(([name]) => !present.has(name));
    if (missing.length === 0) return result;

    const appended = missing.map(([name, cookie]) => `${name}=${cookie.value}`).join("; ");
    const base = existingValue.trim().replace(/;$/, "");
    result[cookieKey] = base ? `${base}; ${appended}` : appended;
    return result;
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.enqueueWrite();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.enqueueWrite();
  }

  private collectCookies(url: string): Array<[string, StoredCookie]> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return [];
    }
    const host = normalizeHost(parsedUrl.hostname);
    const domain = registrableDomain(host);
    if (!domain) return [];
    const cookies = this.domains.get(domain);
    if (!cookies) return [];

    const requestPath = parsedUrl.pathname || "/";
    const now = Date.now();
    const result: Array<[string, StoredCookie]> = [];
    let changed = false;
    for (const [name, cookie] of cookies) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        cookies.delete(name);
        changed = true;
        continue;
      }
      if (!pathMatches(cookie.path ?? "/", requestPath)) continue;
      result.push([name, cookie]);
    }
    if (cookies.size === 0) this.domains.delete(domain);
    if (changed) this.scheduleFlush();
    return result;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [domain, cookies] of this.domains) {
      for (const [name, cookie] of cookies) {
        if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
          cookies.delete(name);
        }
      }
      if (cookies.size === 0) this.domains.delete(domain);
    }
  }

  private enforceLimits(): void {
    for (const [domain, cookies] of this.domains) {
      if (cookies.size > this.maxCookiesPerDomain) {
        const ordered = [...cookies.entries()].sort(
          (left, right) => left[1].createdAt - right[1].createdAt,
        );
        const excess = cookies.size - this.maxCookiesPerDomain;
        for (let index = 0; index < excess; index += 1) {
          const entry = ordered[index];
          if (entry) cookies.delete(entry[0]);
        }
      }
      if (cookies.size === 0) this.domains.delete(domain);
    }

    let size = this.serializedSize();
    if (size <= this.maxTotalBytes) return;

    const ordered: Array<{ domain: string; name: string; createdAt: number }> = [];
    for (const [domain, cookies] of this.domains) {
      for (const [name, cookie] of cookies) {
        ordered.push({ domain, name, createdAt: cookie.createdAt });
      }
    }
    ordered.sort((left, right) => left.createdAt - right.createdAt);

    for (const entry of ordered) {
      if (size <= this.maxTotalBytes) break;
      const cookies = this.domains.get(entry.domain);
      const cookie = cookies?.get(entry.name);
      if (!cookies || !cookie) continue;
      const approximate = Buffer.byteLength(JSON.stringify({ [entry.name]: cookie }));
      cookies.delete(entry.name);
      if (cookies.size === 0) this.domains.delete(entry.domain);
      size -= approximate + 1;
    }

    let guard = 0;
    while (this.serializedSize() > this.maxTotalBytes && guard < 100_000) {
      guard += 1;
      let oldest: { domain: string; name: string; createdAt: number } | null = null;
      for (const [domain, cookies] of this.domains) {
        for (const [name, cookie] of cookies) {
          if (!oldest || cookie.createdAt < oldest.createdAt) {
            oldest = { domain, name, createdAt: cookie.createdAt };
          }
        }
      }
      if (!oldest) break;
      const cookies = this.domains.get(oldest.domain);
      cookies?.delete(oldest.name);
      if (cookies && cookies.size === 0) this.domains.delete(oldest.domain);
    }
  }

  private serializedSize(): number {
    return Buffer.byteLength(`${JSON.stringify(this.toJSON(), null, 2)}\n`);
  }

  private toJSON(): PersistedCookieJar {
    const domains = Object.fromEntries(
      [...this.domains].map(([domain, cookies]) => [domain, Object.fromEntries(cookies)]),
    );
    return { version: 1, domains };
  }

  private scheduleFlush(): void {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueueWrite().catch((error) => {
        this.logger.error("cookie.flush_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.flushMs);
    this.timer.unref?.();
  }

  private enqueueWrite(): Promise<void> {
    const task = this.writeChain.then(() => writeJsonAtomic(this.filePath, this.toJSON()));
    this.writeChain = task.catch(() => undefined);
    return task;
  }
}
