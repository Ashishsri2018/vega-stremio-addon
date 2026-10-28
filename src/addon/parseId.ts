import type { StreamRequest } from "../types.js";

const STREAM_ID = /^(tt[0-9]+)(?::([0-9]+)(?::([0-9]+))?)?$/;

const MAX_SEASON = 1000;
const MAX_EPISODE = 10000;

export function parseStreamId(type: string, rawId: string): StreamRequest | null {
  if (type !== "movie" && type !== "series") return null;

  const id = rawId.endsWith(".json") ? rawId.slice(0, -".json".length) : rawId;
  const match = STREAM_ID.exec(id);
  if (!match) return null;

  const imdbId = match[1];
  if (!imdbId) return null;

  const seasonText = match[2];
  const episodeText = match[3];

  if (type === "movie") {
    if (seasonText !== undefined) return null;
    return { type, imdbId };
  }

  if (seasonText === undefined) return null;

  const season = Number(seasonText);
  if (!Number.isSafeInteger(season) || season < 1 || season > MAX_SEASON) return null;

  if (episodeText === undefined) {
    return { type, imdbId, season };
  }

  const episode = Number(episodeText);
  if (!Number.isSafeInteger(episode) || episode < 1 || episode > MAX_EPISODE) return null;

  return { type, imdbId, season, episode };
}
