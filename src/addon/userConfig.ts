import { z } from "zod";
import { inferQuality } from "../pipeline/mapStreams.js";
import type { StremioStream } from "../types.js";

const USER_CONFIG_VERSION = 1;

export interface UserConfig {
  maxRes: number | null;
  minRes: number | null;
  includeUnknown: boolean;
}

export const DEFAULT_USER_CONFIG: UserConfig = {
  maxRes: null,
  minRes: null,
  includeUnknown: true,
};

const schema = z
  .object({
    v: z.literal(USER_CONFIG_VERSION).optional(),
    maxRes: z.number().int().min(144).max(4320).nullable().optional(),
    minRes: z.number().int().min(144).max(4320).nullable().optional(),
    includeUnknown: z.boolean().optional(),
  })
  .refine(
    (value) => {
      const max = value.maxRes ?? null;
      const min = value.minRes ?? null;
      return max === null || min === null || min <= max;
    },
    { message: "minRes must not exceed maxRes" },
  );

export function encodeUserConfig(config: UserConfig): string {
  const payload: Record<string, unknown> = { v: USER_CONFIG_VERSION };
  if (config.maxRes !== null) payload.maxRes = config.maxRes;
  if (config.minRes !== null) payload.minRes = config.minRes;
  if (!config.includeUnknown) payload.includeUnknown = false;
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function parseUserConfig(segment: string | undefined): UserConfig {
  if (!segment) return DEFAULT_USER_CONFIG;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return DEFAULT_USER_CONFIG;
  }

  const parsed = schema.safeParse(decoded);
  if (!parsed.success) return DEFAULT_USER_CONFIG;

  return {
    maxRes: parsed.data.maxRes ?? null,
    minRes: parsed.data.minRes ?? null,
    includeUnknown: parsed.data.includeUnknown ?? true,
  };
}

export function filterStreams(
  streams: StremioStream[],
  config: UserConfig,
): StremioStream[] {
  const { maxRes, minRes, includeUnknown } = config;
  if (maxRes === null && minRes === null && includeUnknown) return streams;

  return streams.filter((stream) => {
    const quality = inferQuality(stream);
    if (quality === 0) return includeUnknown;
    if (maxRes !== null && quality > maxRes) return false;
    if (minRes !== null && quality < minRes) return false;
    return true;
  });
}
