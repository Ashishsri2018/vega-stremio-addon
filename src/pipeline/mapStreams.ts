import type {
  ProviderStream,
  StremioStream,
  StremioSubtitle,
  SubtitleTrack,
} from "../types.js";

export interface MapStreamsOptions {
  providerValue: string;
  providerName: string;
  includeMagnets: boolean;
  perProviderLimit?: number;
}

const DEFAULT_PER_PROVIDER_LIMIT = 20;

const BLOCKED_HEADERS = new Set([
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "content-type",
  "accept-encoding",
]);

const PLACEHOLDER_HOSTS = new Set([
  "example.com",
  "www.example.com",
  "example.org",
  "example.net",
  "localhost",
  "localhost.localdomain",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
]);

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isPlaceholderHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (PLACEHOLDER_HOSTS.has(host)) return true;
  return (
    host.endsWith(".example.com") ||
    host.endsWith(".example.org") ||
    host.endsWith(".example.net")
  );
}

function isMagnet(value: string): boolean {
  return /^magnet:\?/i.test(value);
}

function filterHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers || typeof headers !== "object") return result;

  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (typeof rawName !== "string" || typeof rawValue !== "string") continue;
    const name = rawName.trim();
    const value = rawValue.trim();
    if (!name || !value) continue;
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) continue;
    if (/[\r\n]/.test(value)) continue;
    const lower = name.toLowerCase();
    if (BLOCKED_HEADERS.has(lower) || lower.startsWith("proxy-")) continue;
    result[name] = value;
  }

  return result;
}

function normalizeSubtitles(
  subtitles: SubtitleTrack[] | undefined,
  providerValue: string,
  streamIndex: number,
): StremioSubtitle[] {
  if (!Array.isArray(subtitles)) return [];
  const result: StremioSubtitle[] = [];

  subtitles.forEach((track) => {
    if (!track || typeof track !== "object") return;
    const uri = trimString(track.uri);
    if (!parseHttpUrl(uri)) return;
    const language = trimString(track.language) || "en";
    const id =
      result.length === 0
        ? `${providerValue}-${streamIndex}`
        : `${providerValue}-${streamIndex}-${result.length}`;
    result.push({ id, url: uri, lang: language });
  });

  return result;
}

function collectTags(stream: ProviderStream): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown): void => {
    const tag = trimString(value);
    if (!tag || seen.has(tag)) return;
    seen.add(tag);
    tags.push(tag);
  };

  if (Array.isArray(stream.tags)) {
    for (const tag of stream.tags) push(tag);
  }
  push(stream.tag);
  return tags;
}

export function mapProviderStreams(
  streams: ProviderStream[],
  options: MapStreamsOptions,
): StremioStream[] {
  const mapped: StremioStream[] = [];
  const seenUrls = new Set<string>();
  const providerName = trimString(options.providerName) || options.providerValue;
  const limit = Math.max(
    0,
    Math.floor(options.perProviderLimit ?? DEFAULT_PER_PROVIDER_LIMIT),
  );

  if (!Array.isArray(streams)) return mapped;

  streams.forEach((stream, streamIndex) => {
    if (!stream || typeof stream !== "object") return;

    const link = trimString(stream.link);
    if (!link) return;

    const type = trimString(stream.type).toLowerCase();
    if (type === "torrent" && !options.includeMagnets) return;

    const magnet = isMagnet(link);
    if (magnet) {
      if (!options.includeMagnets) return;
    } else {
      const url = parseHttpUrl(link);
      if (!url) return;
      if (isPlaceholderHost(url.hostname)) return;
    }

    if (seenUrls.has(link)) return;
    seenUrls.add(link);

    const server = trimString(stream.server);
    const quality = trimString(stream.quality);
    const tags = collectTags(stream);
    const titleParts = [server, quality, tags.join(", ")].filter(Boolean);
    const title = titleParts.length > 0 ? titleParts.join(" \u2022 ") : undefined;

    const subtitles = normalizeSubtitles(
      stream.subtitles,
      options.providerValue,
      streamIndex,
    );

    const requestHeaders = filterHeaders(stream.headers);
    const behaviorHints: NonNullable<StremioStream["behaviorHints"]> = {
      bingeGroup: `${options.providerValue}-${quality || "auto"}`,
    };
    if (Object.keys(requestHeaders).length > 0) {
      behaviorHints.proxyHeaders = { request: requestHeaders };
    }

    mapped.push({
      name: providerName,
      ...(title ? { title } : {}),
      url: link,
      behaviorHints,
      ...(subtitles.length > 0 ? { subtitles } : {}),
    });
  });

  return sortStreams(mapped).slice(0, limit);
}

const QUALITY_LABELS: Array<[RegExp, number]> = [
  [/(?<![\p{L}\p{N}])8k(?![\p{L}\p{N}])/u, 4320],
  [/(?<![\p{L}\p{N}])4k(?![\p{L}\p{N}])/u, 2160],
  [/(?<![\p{L}\p{N}])uhd(?![\p{L}\p{N}])/u, 2160],
  [/(?<![\p{L}\p{N}])qhd(?![\p{L}\p{N}])/u, 1440],
  [/(?<![\p{L}\p{N}])fhd(?![\p{L}\p{N}])/u, 1080],
];

function qualityValue(value: string): number {
  const lower = value.toLowerCase();
  const pMatch = /(?<!\d)(\d{3,4})p(?:\d{1,3})?(?:fps)?(?![\p{L}\p{N}])/u.exec(lower);
  if (pMatch) return Number(pMatch[1]);
  const bare = /(?<!\d)(4320|2160|1440|1080|720|576|480|360|240)(?![\d\p{L}])/u.exec(
    lower,
  );
  if (bare) return Number(bare[1]);
  for (const [pattern, resolution] of QUALITY_LABELS) {
    if (pattern.test(lower)) return resolution;
  }
  return 0;
}

export function inferQuality(stream: StremioStream): number {
  const sources: string[] = [];
  if (typeof stream.title === "string") {
    sources.push(...stream.title.split("\u2022"));
  }
  if (stream.behaviorHints?.bingeGroup) sources.push(stream.behaviorHints.bingeGroup);
  if (typeof stream.url === "string") sources.push(stream.url);

  let best = 0;
  for (const source of sources) {
    best = Math.max(best, qualityValue(source));
  }
  return best;
}

function formatRank(url: string): number {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return 1;
  }
  if (/\.(?:mp4|mkv|m4v|webm|avi|mov|flv)$/.test(pathname)) return 0;
  if (/\.(?:m3u8|mpd)$/.test(pathname)) return 2;
  return 1;
}

export function sortStreams(streams: StremioStream[]): StremioStream[] {
  if (!Array.isArray(streams)) return [];
  const seen = new Set<string>();
  const unique: Array<{ stream: StremioStream; index: number }> = [];

  streams.forEach((stream, index) => {
    if (!stream || typeof stream.url !== "string" || !stream.url) return;
    if (seen.has(stream.url)) return;
    seen.add(stream.url);
    unique.push({ stream, index });
  });

  unique.sort((a, b) => {
    const qualityDiff = inferQuality(b.stream) - inferQuality(a.stream);
    if (qualityDiff !== 0) return qualityDiff;
    const formatDiff = formatRank(a.stream.url) - formatRank(b.stream.url);
    if (formatDiff !== 0) return formatDiff;
    return a.index - b.index;
  });

  return unique.map((entry) => entry.stream);
}
