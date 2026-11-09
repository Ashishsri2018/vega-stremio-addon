import type { StreamRequest } from "../types.js";

const STREAM_ID = /^(tt[0-9]+|tmdb:[0-9]+)(?::([0-9]+)(?::([0-9]+))?)?$/;

const MAX_SEASON = 1000;
const MAX_EPISODE = 10000;

export function parseStreamId(type: string, rawId: string): StreamRequest | null {
  if (type !== "movie" && type !== "series") return null;

  const id = rawId.endsWith(".json") ? rawId.slice(0, -".json".length) : rawId;
  const match = STREAM_ID.exec(id);
  if (!match) return null;

  const contentId = match[1];
  if (!contentId) return null;

  const seasonText = match[2];
  const episodeText = match[3];

  if (type === "movie" && seasonText !== undefined) return null;
  if (type === "series" && seasonText === undefined) return null;

  let request: StreamRequest;
  if (contentId.startsWith("tmdb:")) {
    const tmdbId = Number(contentId.slice("tmdb:".length));
    if (!Number.isSafeInteger(tmdbId) || tmdbId < 1) return null;
    request = { type, tmdbId };
  } else {
    request = { type, imdbId: contentId };
  }

  if (seasonText !== undefined) {
    const season = Number(seasonText);
    if (!Number.isSafeInteger(season) || season < 1 || season > MAX_SEASON) return null;
    request.season = season;
  }

  if (episodeText !== undefined) {
    const episode = Number(episodeText);
    if (!Number.isSafeInteger(episode) || episode < 1 || episode > MAX_EPISODE) {
      return null;
    }
    request.episode = episode;
  }

  return request;
}

export function contentIdOf(request: StreamRequest): string {
  return "imdbId" in request ? request.imdbId : `tmdb:${request.tmdbId}`;
}

export function requestLogFields(request: StreamRequest): {
  contentId: string;
  imdbId: string | null;
} {
  return "imdbId" in request
    ? { contentId: request.imdbId, imdbId: request.imdbId }
    : { contentId: `tmdb:${request.tmdbId}`, imdbId: null };
}
