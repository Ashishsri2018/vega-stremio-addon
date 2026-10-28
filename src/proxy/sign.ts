import { createHmac, timingSafeEqual } from "node:crypto";

export interface ProxyPayload {
  u: string;
  h?: Record<string, string>;
  e: number;
}

const DEFAULT_TTL_SECONDS = 6 * 60 * 60;

function hmac(input: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(input).digest();
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isHeaderRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([name, headerValue]) =>
      name.length > 0 && typeof headerValue === "string" && !/[\r\n]/.test(headerValue),
  );
}

export function signProxyToken(payload: ProxyPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = hmac(encoded, secret).toString("base64url");
  return `${encoded}.${signature}`;
}

export function verifyProxyToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): ProxyPayload | null {
  if (typeof token !== "string") return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [encoded, signature] = parts;
  if (!encoded || !signature) return null;

  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }

  const expected = hmac(encoded, secret);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const payload = parsed as Record<string, unknown>;

  if (typeof payload.u !== "string" || !isHttpUrl(payload.u)) return null;
  if (typeof payload.e !== "number" || !Number.isFinite(payload.e)) return null;
  if (payload.e < nowSeconds) return null;
  if (payload.h !== undefined && !isHeaderRecord(payload.h)) return null;

  const result: ProxyPayload = { u: payload.u, e: payload.e };
  if (payload.h !== undefined) result.h = payload.h as Record<string, string>;
  return result;
}

export function createProxyToken(
  targetUrl: string,
  headers: Record<string, string> | undefined,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): string {
  const ttl = Number.isFinite(ttlSeconds) ? Math.floor(ttlSeconds) : DEFAULT_TTL_SECONDS;
  const payload: ProxyPayload = {
    u: targetUrl,
    ...(headers && Object.keys(headers).length > 0 ? { h: headers } : {}),
    e: Math.floor(Date.now() / 1000) + ttl,
  };
  return signProxyToken(payload, secret);
}
