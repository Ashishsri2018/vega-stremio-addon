import type { MediaType, Post } from "../types.js";

const ROMAN_NUMERALS: Array<[string, string]> = [
  ["viii", "8"],
  ["vii", "7"],
  ["iii", "3"],
  ["vi", "6"],
  ["iv", "4"],
  ["ix", "9"],
  ["ii", "2"],
  ["v", "5"],
  ["x", "10"],
];

const QUALITY_TAGS =
  /(?<![\p{L}\p{N}])(?:480p|720p|1080p|2160p|4k|hdrip|webrip|web[- ]?dl|hdcam|bluray|dvdrip|x264|x265|hevc|av1|hdr|10bit)(?![\p{L}\p{N}])/gu;

const LANGUAGE_TAGS =
  /(?<![\p{L}\p{N}])(?:hindi|english|tamil|telugu|malayalam|kannada|bengali|punjabi|marathi|urdu|dual[ -]?audio|multi[ -]?audio|dubbed|dub|esubsub|esubs|esub|subbed|subtitles)(?![\p{L}\p{N}])/gu;

const FILLER_PHRASES =
  /(?<![\p{L}\p{N}])(?:watch\s+online|free\s+download|full\s+movie|full\s+series|full\s+season|download\s+now|download\s+link|online\s+free)(?![\p{L}\p{N}])/gu;

const FILLER_WORDS =
  /(?<![\p{L}\p{N}])(?:downloads?|watch(?:ing)?|online|free)(?![\p{L}\p{N}])/gu;

function normalizeRomanNumerals(value: string): string {
  let result = value;
  for (const [roman, digit] of ROMAN_NUMERALS) {
    result = result.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${roman}(?![\\p{L}\\p{N}])`, "gu"),
      digit,
    );
  }
  return result;
}

export function normalizeTitle(title: string): string {
  if (typeof title !== "string") return "";
  let value = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  value = value.replace(/['’`]/g, "");
  value = value.replace(/&/g, " and ");
  value = normalizeRomanNumerals(value);
  value = value.replace(QUALITY_TAGS, " ");
  value = value.replace(LANGUAGE_TAGS, " ");
  value = value.replace(FILLER_PHRASES, " ");
  value = value.replace(FILLER_WORDS, " ");
  value = value.replace(/[^\p{L}\p{N}]+/gu, " ");
  return value.replace(/\s+/g, " ").trim();
}

export function extractYear(text: string): number | null {
  if (typeof text !== "string") return null;
  const match = /(?<!\d)((?:18|19|20)\d{2})(?!\d)/.exec(text);
  if (!match) return null;
  return Number(match[1]);
}

function parseRequestYear(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1800 && value <= 2200 ? value : null;
  }
  return extractYear(value);
}

function tokenize(value: string): string[] {
  return value.split(" ").filter((token) => token.length > 0);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface MatchRequest {
  title: string;
  year?: number | string | null;
  type: MediaType;
}

export function scoreCandidate(post: Post, request: MatchRequest): number {
  const rawTitle = typeof post?.title === "string" ? post.title : "";
  const normalizedPost = normalizeTitle(rawTitle);
  const normalizedTitle = normalizeTitle(request.title);
  let score = 0;

  if (normalizedTitle && normalizedPost) {
    if (normalizedPost === normalizedTitle) {
      score += 100;
    } else if (normalizedPost.startsWith(normalizedTitle)) {
      score += 60;
    } else if (normalizedPost.includes(normalizedTitle)) {
      score += 45;
    }
    score += Math.round(
      jaccard(new Set(tokenize(normalizedTitle)), new Set(tokenize(normalizedPost))) * 35,
    );
  }

  const requestedYear = parseRequestYear(request.year);
  const candidateYear = extractYear(rawTitle);
  if (requestedYear !== null && candidateYear !== null) {
    score += candidateYear === requestedYear ? 20 : -40;
  }

  const lower = rawTitle.toLowerCase();
  const seriesHint =
    /\b(?:series|season|complete|episodes?)\b|\bs\d{1,2}(?:e\d{1,3})?\b/i.test(lower);
  const movieHint = /\b(?:movie|film)\b/i.test(lower);

  if (request.type === "series") {
    if (seriesHint) score += 15;
    if (movieHint && !seriesHint) score -= 30;
  } else {
    if (movieHint) score += 10;
    if (seriesHint && !movieHint) score -= 30;
  }

  if (typeof post?.image === "string" && post.image.trim()) score += 5;

  return Math.max(0, Math.round(score));
}

export function rankCandidates(
  posts: Post[],
  request: MatchRequest,
  limit = 3,
): Array<{ post: Post; score: number }> {
  const max = Math.max(0, Math.floor(limit));
  return (Array.isArray(posts) ? posts : [])
    .map((post) => ({ post, score: scoreCandidate(post, request) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}
