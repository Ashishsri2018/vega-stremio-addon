import { describe, expect, it, vi } from "vitest";
import type { LoggerLike } from "../src/types.js";
import { TmdbClient } from "../src/tmdb/client.js";

function testLogger(): { logger: LoggerLike; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const logger: LoggerLike = {
    debug: () => {},
    info: () => {},
    warn,
    error: () => {},
    child: () => logger,
  };
  return { logger, warn };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("TmdbClient", () => {
  it("maps movie details to Cinemeta metadata", async () => {
    const calls: URL[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(new URL(String(input)));
      return jsonResponse({
        id: 550,
        title: "Fight Club",
        original_title: "Fight Club",
        release_date: "1999-10-15",
        imdb_id: "tt0137523",
      });
    }) as typeof fetch;
    const { logger } = testLogger();
    const client = new TmdbClient({
      apiKey: "test-key",
      baseUrl: "https://tmdb.test/3/",
      logger,
      fetchImpl,
    });

    const meta = await client.getMeta("movie", 550);

    expect(meta).toEqual({
      id: "tt0137523",
      type: "movie",
      name: "Fight Club",
      year: "1999",
      releaseInfo: "1999",
    });
    expect(calls[0]?.pathname).toBe("/3/movie/550");
    expect(calls[0]?.searchParams.get("api_key")).toBe("test-key");
    expect(calls[0]?.searchParams.get("language")).toBe("en-US");
  });

  it("builds series episode lists and fills names for the requested season", async () => {
    const calls: URL[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.pathname === "/3/tv/1396") {
        return jsonResponse({
          id: 1396,
          name: "Breaking Bad",
          original_name: "Breaking Bad",
          first_air_date: "2008-01-20",
          external_ids: { imdb_id: "tt0903747" },
          seasons: [
            { season_number: 0, episode_count: 2 },
            { season_number: 1, episode_count: 2 },
          ],
        });
      }
      if (url.pathname === "/3/tv/1396/season/1") {
        return jsonResponse({
          episodes: [
            { episode_number: 1, name: "Pilot" },
            { episode_number: 2, name: "Cat's in the Bag..." },
          ],
        });
      }
      return jsonResponse({}, 404);
    }) as typeof fetch;
    const { logger } = testLogger();
    const client = new TmdbClient({
      apiKey: "test-key",
      baseUrl: "https://tmdb.test/3",
      logger,
      fetchImpl,
    });

    const meta = await client.getMeta("series", 1396, 1);
    const again = await client.getMeta("series", 1396, 1);

    expect(meta?.id).toBe("tt0903747");
    expect(meta?.type).toBe("series");
    expect(meta?.videos).toEqual([
      { season: 0, episode: 1 },
      { season: 0, episode: 2 },
      { season: 1, episode: 1, name: "Pilot" },
      { season: 1, episode: 2, name: "Cat's in the Bag..." },
    ]);
    expect(again?.videos).toEqual(meta?.videos);
    expect(calls.map((url) => url.pathname)).toEqual([
      "/3/tv/1396",
      "/3/tv/1396/season/1",
    ]);
    expect(calls[0]?.searchParams.get("append_to_response")).toBe("external_ids");
  });

  it("falls back to a tmdb id when TMDB has no IMDb id", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        id: 1399,
        name: "Game of Thrones",
        first_air_date: "2011-04-17",
        seasons: [],
      })) as typeof fetch;
    const { logger } = testLogger();
    const client = new TmdbClient({
      apiKey: "test-key",
      baseUrl: "https://tmdb.test/3",
      logger,
      fetchImpl,
    });

    const meta = await client.getMeta("series", 1399);
    expect(meta?.id).toBe("tmdb:1399");
    expect(meta?.name).toBe("Game of Thrones");
  });

  it("returns null and logs without the API key when TMDB fails", async () => {
    const fetchImpl = (async () => jsonResponse({}, 404)) as typeof fetch;
    const { logger, warn } = testLogger();
    const client = new TmdbClient({
      apiKey: "super-secret-key",
      baseUrl: "https://tmdb.test/3",
      logger,
      fetchImpl,
    });

    await expect(client.getMeta("movie", 404404)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith("tmdb.fetch_failed", expect.any(Object));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("super-secret-key");
  });
});
