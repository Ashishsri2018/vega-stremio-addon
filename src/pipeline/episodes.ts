import { normalizeTitle } from "./match.js";

export interface EpisodeRange {
  season?: number;
  from: number;
  to: number;
}

interface IndexedRange extends EpisodeRange {
  index: number;
}

interface Span {
  start: number;
  end: number;
}

function addRange(
  output: IndexedRange[],
  used: Span[],
  span: Span,
  season: number | null,
  from: number,
  to: number,
  index: number,
): void {
  if (used.some((existing) => span.start < existing.end && span.end > existing.start)) return;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return;
  if (from < 0 || to < 0) return;
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  if (output.some((range) => range.season === (season ?? undefined) && range.from === low && range.to === high)) {
    used.push(span);
    return;
  }
  used.push(span);
  output.push({ season: season ?? undefined, from: low, to: high, index });
}

function collectMatches(
  text: string,
  pattern: RegExp,
  output: IndexedRange[],
  used: Span[],
  build: (match: RegExpExecArray) => { season: number | null; from: number; to: number } | null,
): void {
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const value = build(match);
    if (!value) continue;
    addRange(
      output,
      used,
      { start: index, end: index + match[0].length },
      value.season,
      value.from,
      value.to,
      index,
    );
  }
}

export function parseEpisodeRanges(title: string): EpisodeRange[] {
  if (typeof title !== "string" || title.length === 0) return [];
  const text = title.replace(/[–—~]/g, "-");
  const found: IndexedRange[] = [];
  const used: Span[] = [];

  collectMatches(
    text,
    /\bs\s*(\d{1,2})\s*e\s*(\d{1,3})(?![\p{L}\p{N}])(?:\s*-\s*(?:e|ep|episode)?\s*\.?\s*(\d{1,3})(?![\p{L}\p{N}]))?/giu,
    found,
    used,
    (match) => ({
      season: Number(match[1]),
      from: Number(match[2]),
      to: match[3] === undefined ? Number(match[2]) : Number(match[3]),
    }),
  );

  collectMatches(
    text,
    /\bseason\s*(\d{1,2})\s*[,:-]?\s*(?:episodes?|eps?|ep)\s*\.?\s*(\d{1,3})(?![\p{L}\p{N}])(?:\s*-\s*(?:episodes?|eps?|ep)?\s*\.?\s*(\d{1,3})(?![\p{L}\p{N}]))?/giu,
    found,
    used,
    (match) => ({
      season: Number(match[1]),
      from: Number(match[2]),
      to: match[3] === undefined ? Number(match[2]) : Number(match[3]),
    }),
  );

  collectMatches(
    text,
    /(?<![\p{L}\p{N}])(\d{1,2})\s*x\s*(\d{1,3})(?![\p{L}\p{N}])(?:\s*-\s*(?:e|ep|episode)?\s*\.?\s*(\d{1,3})(?![\p{L}\p{N}]))?/giu,
    found,
    used,
    (match) => ({
      season: Number(match[1]),
      from: Number(match[2]),
      to: match[3] === undefined ? Number(match[2]) : Number(match[3]),
    }),
  );

  collectMatches(
    text,
    /(?<![\p{L}\p{N}])(?:episodes?|eps?|ep|e)\s*\.?\s*(\d{1,3})(?![\p{L}\p{N}])(?:\s*-\s*(?:episodes?|eps?|ep|e)?\s*\.?\s*(\d{1,3})(?![\p{L}\p{N}]))?/giu,
    found,
    used,
    (match) => ({
      season: null,
      from: Number(match[1]),
      to: match[2] === undefined ? Number(match[1]) : Number(match[2]),
    }),
  );

  return found
    .sort((a, b) => a.index - b.index)
    .map(({ season, from, to }) =>
      season === undefined ? { from, to } : { season, from, to },
    );
}

function extractSeasons(title: string): Set<number> {
  const seasons = new Set<number>();
  for (const range of parseEpisodeRanges(title)) {
    if (range.season !== undefined) seasons.add(range.season);
  }
  for (const match of title.matchAll(/\bseason\s*(\d{1,2})(?!\d)/gi)) {
    seasons.add(Number(match[1]));
  }
  for (const match of title.matchAll(/\bs(\d{1,2})(?!\d)/gi)) {
    seasons.add(Number(match[1]));
  }
  for (const match of title.matchAll(/(?<![\p{L}\p{N}])(\d{1,2})\s*x\s*(\d{1,3})(?![\p{L}\p{N}])/giu)) {
    seasons.add(Number(match[1]));
  }
  return seasons;
}

export function isSeasonPack(title: string, season: number): boolean {
  if (typeof title !== "string") return false;
  const seasons = extractSeasons(title);
  if (seasons.size > 0 && !seasons.has(season)) return false;

  const ranges = parseEpisodeRanges(title);
  if (
    ranges.some(
      (range) =>
        (range.season === undefined || range.season === season) && range.to > range.from,
    )
  ) {
    return true;
  }

  if (ranges.length === 0) {
    if (/\b(?:complete|full|whole)\b/i.test(title)) return true;
    if (/\b(?:full|whole)\s+season\b/i.test(title)) return true;
    if (/\bseason\s*\d+\b/i.test(title)) return true;
    if (/\bs\d{1,2}\b/i.test(title)) return true;
  }

  return false;
}

export function matchesEpisode(
  title: string,
  season: number,
  episode?: number,
  episodeName?: string | null,
): boolean {
  if (typeof title !== "string" || title.length === 0) return false;
  if (!Number.isInteger(season)) return false;

  const seasons = extractSeasons(title);
  if (seasons.size > 0 && !seasons.has(season)) return false;

  const ranges = parseEpisodeRanges(title);

  if (episode === undefined) {
    if (seasons.has(season)) return true;
    if (ranges.some((range) => range.season === undefined || range.season === season)) {
      return true;
    }
    return isSeasonPack(title, season);
  }

  if (!Number.isInteger(episode) || episode < 0) return false;

  for (const range of ranges) {
    if (range.season !== undefined && range.season !== season) continue;
    if (episode >= range.from && episode <= range.to) return true;
  }

  if (ranges.length > 0) return false;

  if (episodeName) {
    const normalizedName = normalizeTitle(episodeName);
    if (normalizedName.length >= 2 && normalizeTitle(title).includes(normalizedName)) {
      return true;
    }
  }

  return false;
}
