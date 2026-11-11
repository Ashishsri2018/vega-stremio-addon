import { describe, expect, it } from "vitest";
import type { ProviderStream, StremioStream } from "../src/types.js";
import {
  inferFileSizeBytes,
  inferQuality,
  mapProviderStreams,
  sortStreams,
  type MapStreamsOptions,
} from "../src/pipeline/mapStreams.js";
import {
  isWebPage,
  BLOCKER_URL_PATTERN,
  normalizeStreamKey,
} from "../src/pipeline/urlClassifier.js";

const baseOptions: MapStreamsOptions = {
  providerValue: "provider",
  providerName: "Provider Name",
  includeMagnets: false,
};

function stream(overrides: Partial<ProviderStream> = {}): ProviderStream {
  return {
    server: "Server",
    link: "https://cdn.test/file.mp4",
    quality: "1080p",
    ...overrides,
  };
}

describe("mapProviderStreams filtering", () => {
  it("keeps only http(s), non-placeholder, unique links", () => {
    const mapped = mapProviderStreams(
      [
        stream({ link: "https://cdn.test/good.mp4" }),
        stream({ link: "https://example.com/bad.mp4", server: "Example" }),
        stream({ link: "http://localhost:8080/bad.mp4", server: "Local" }),
        stream({ link: "ftp://cdn.test/file.mp4", server: "FTP" }),
        stream({ link: "   ", server: "Empty" }),
        stream({ link: "https://cdn.test/good.mp4", server: "Duplicate" }),
      ],
      baseOptions,
    );
    expect(mapped).toHaveLength(1);
    expect(mapped[0].url).toBe("https://cdn.test/good.mp4");
    expect(mapped[0].title).toContain("Server");
  });

  it("filters torrents and magnets unless enabled", () => {
    const streams = [
      stream({ server: "Magnet", link: "magnet:?xt=urn:btih:abc", type: "torrent" }),
      stream({ server: "TorrentUrl", link: "https://cdn.test/torrent.mp4", type: "torrent" }),
      stream({ server: "Direct", link: "https://cdn.test/direct.mp4", type: "direct" }),
    ];

    const filtered = mapProviderStreams(streams, baseOptions);
    expect(filtered.map((item) => item.url)).toEqual(["https://cdn.test/direct.mp4"]);

    const withMagnets = mapProviderStreams(streams, {
      ...baseOptions,
      includeMagnets: true,
    });
    expect(withMagnets.map((item) => item.url)).toContain("magnet:?xt=urn:btih:abc");
    expect(withMagnets.map((item) => item.url)).toContain("https://cdn.test/torrent.mp4");
    expect(withMagnets).toHaveLength(3);
  });
});

describe("mapProviderStreams output", () => {
  it("maps names, titles, quality tags and binge groups", () => {
    const [mapped] = mapProviderStreams(
      [
        stream({
          server: "Vega",
          quality: "1080p",
          tags: ["HDR", "HEVC", "HDR"],
          tag: "HEVC",
        }),
      ],
      baseOptions,
    );
    expect(mapped.name).toBe("Provider Name");
    expect(mapped.title).toBe("Vega \u2022 1080p \u2022 HDR, HEVC");
    expect(mapped.behaviorHints?.bingeGroup).toBe("provider-1080p");

    const [auto] = mapProviderStreams([stream({ quality: undefined })], baseOptions);
    expect(auto.behaviorHints?.bingeGroup).toBe("provider-auto");
  });

  it("filters hop-by-hop headers and keeps provider headers", () => {
    const [mapped] = mapProviderStreams(
      [
        stream({
          headers: {
            Referer: "https://site.test/",
            Origin: "https://site.test",
            "User-Agent": "Mozilla/5.0",
            Cookie: "a=b",
            Authorization: "Bearer token",
            "X-Requested-With": "XMLHttpRequest",
            "Sec-Fetch-Site": "same-origin",
            Connection: "keep-alive",
            "Keep-Alive": "timeout=5",
            "Proxy-Authorization": "Basic abc",
            TE: "trailers",
            Trailer: "Expires",
            "Transfer-Encoding": "chunked",
            Upgrade: "h2c",
            Host: "evil.test",
            "Content-Length": "12",
            "Content-Type": "application/json",
            "Accept-Encoding": "gzip",
            "X-Empty": "   ",
          },
        }),
      ],
      baseOptions,
    );

    expect(mapped.behaviorHints?.proxyHeaders?.request).toEqual({
      Referer: "https://site.test/",
      Origin: "https://site.test",
      "User-Agent": "Mozilla/5.0",
      Cookie: "a=b",
      Authorization: "Bearer token",
      "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Site": "same-origin",
    });
  });

  it("omits proxyHeaders when no safe headers remain", () => {
    const [mapped] = mapProviderStreams(
      [stream({ headers: { Connection: "keep-alive", Host: "x.test" } })],
      baseOptions,
    );
    expect(mapped.behaviorHints?.proxyHeaders).toBeUndefined();
    expect(mapped.behaviorHints?.bingeGroup).toBe("provider-1080p");
  });

  it("normalizes subtitles and filters non-http uris", () => {
    const [mapped, second] = mapProviderStreams(
      [
        stream({
          link: "https://cdn.test/one.mp4",
          subtitles: [
            { uri: "https://subs.test/en.vtt", language: "en" },
            { uri: "https://subs.test/es.vtt" },
            { uri: "ftp://subs.test/bad.vtt", language: "fr" },
            { uri: "https://subs.test/de.vtt", language: "de" },
          ],
        }),
        stream({
          link: "https://cdn.test/two.mp4",
          subtitles: [{ uri: "https://subs.test/pt.vtt", language: "pt" }],
        }),
      ],
      baseOptions,
    );

    expect(mapped.subtitles).toEqual([
      { id: "provider-0", url: "https://subs.test/en.vtt", lang: "en" },
      { id: "provider-0-1", url: "https://subs.test/es.vtt", lang: "en" },
      { id: "provider-0-2", url: "https://subs.test/de.vtt", lang: "de" },
    ]);
    expect(second.subtitles).toEqual([
      { id: "provider-1", url: "https://subs.test/pt.vtt", lang: "pt" },
    ]);
  });

  it("does not expose skip data", () => {
    const [mapped] = mapProviderStreams(
      [stream({ skip: [{ from: 1, to: 2, title: "intro" }] })],
      baseOptions,
    );
    expect(mapped).not.toHaveProperty("skip");
  });
});

describe("quality ordering", () => {
  it("sorts quality descending and direct files before HLS at equal quality", () => {
    const mapped = mapProviderStreams(
      [
        stream({ server: "A", quality: "720p", link: "https://cdn.test/a.mp4" }),
        stream({ server: "B", quality: "1080p", link: "https://cdn.test/b/index.m3u8" }),
        stream({ server: "C", quality: "1080p", link: "https://cdn.test/c.mp4" }),
        stream({ server: "D", quality: "auto", link: "https://cdn.test/d/index.m3u8" }),
        stream({ server: "E", quality: "2160p", link: "https://cdn.test/e.mkv" }),
      ],
      baseOptions,
    );
    expect(mapped.map((item) => item.url)).toEqual([
      "https://cdn.test/e.mkv",
      "https://cdn.test/c.mp4",
      "https://cdn.test/b/index.m3u8",
      "https://cdn.test/a.mp4",
      "https://cdn.test/d/index.m3u8",
    ]);
  });

  it("sorts combined streams and preserves stable order for ties", () => {
    const streams: StremioStream[] = [
      { name: "P", title: "A \u2022 720p", url: "https://cdn.test/a.mp4" },
      { name: "P", title: "B \u2022 1080p", url: "https://cdn.test/b.m3u8" },
      { name: "P", title: "C \u2022 1080p", url: "https://cdn.test/c.mp4" },
      { name: "P", title: "D", url: "https://cdn.test/d" },
      { name: "P", title: "A duplicate", url: "https://cdn.test/a.mp4" },
    ];
    expect(sortStreams(streams).map((item) => item.url)).toEqual([
      "https://cdn.test/c.mp4",
      "https://cdn.test/b.m3u8",
      "https://cdn.test/a.mp4",
      "https://cdn.test/d",
    ]);
  });

  it("caps per-provider results after sorting", () => {
    const streams = Array.from({ length: 120 }, (_, index) =>
      stream({
        server: `Server ${index}`,
        link: `https://cdn.test/${index}.mp4`,
        quality: index === 119 ? "2160p" : "1080p",
      }),
    );
    expect(mapProviderStreams(streams, baseOptions)).toHaveLength(100);
    const limited = mapProviderStreams(streams, { ...baseOptions, perProviderLimit: 5 });
    expect(limited).toHaveLength(5);
    expect(limited[0].url).toBe("https://cdn.test/119.mp4");
  });
});

describe("web page and archive classification", () => {
  it("detects web pages, HTML embeds, and compressed archives", () => {
    expect(isWebPage("https://moviesapi.to/movie/123")).toBe(true);
    expect(isWebPage("https://screenscape.me/embed?tmdb=1")).toBe(true);
    expect(isWebPage("https://site.test/movie.html")).toBe(true);
    expect(isWebPage("https://site.test/movie.zip")).toBe(true);
    expect(isWebPage("https://site.test/movie.rar")).toBe(true);
    expect(isWebPage("https://t.me/bot?start=123")).toBe(true);

    expect(isWebPage("https://cdn.test/movie.mp4")).toBe(false);
    expect(isWebPage("https://cdn.test/movie.mkv")).toBe(false);
    expect(isWebPage("https://cdn.test/master.m3u8")).toBe(false);
    expect(isWebPage("https://bucket.r2.cloudflarestorage.com/video")).toBe(false);
  });

  it("maps web pages and archives to externalUrl and omits url and proxyHeaders", () => {
    const mapped = mapProviderStreams(
      [
        stream({
          link: "https://screenscape.me/embed?tmdb=1",
          headers: { Referer: "https://site.test" },
          subtitles: [{ uri: "https://subs.test/en.vtt", language: "en" }],
        }),
        stream({
          link: "https://cdn.test/archive.zip",
        }),
        stream({
          link: "https://cdn.test/movie.mp4",
          headers: { Referer: "https://site.test" },
        }),
      ],
      baseOptions,
    );

    expect(mapped[0].url).toBe("https://cdn.test/movie.mp4");
    expect(mapped[0].externalUrl).toBeUndefined();
    expect(mapped[0].behaviorHints?.proxyHeaders).toBeDefined();

    const embed = mapped.find((s) => s.externalUrl === "https://screenscape.me/embed?tmdb=1");
    expect(embed).toBeDefined();
    expect(embed?.url).toBeUndefined();
    expect(embed?.behaviorHints?.proxyHeaders).toBeUndefined();
    expect(embed?.subtitles).toBeUndefined();

    const zip = mapped.find((s) => s.externalUrl === "https://cdn.test/archive.zip");
    expect(zip).toBeDefined();
    expect(zip?.url).toBeUndefined();
  });

  it("drops blocker and slowdown links at ingestion", () => {
    const mapped = mapProviderStreams(
      [
        stream({ link: "https://st.111477.xyz/slowdown?auth=1" }),
        stream({ link: "https://cdn.test/good.mp4" }),
      ],
      baseOptions,
    );
    expect(mapped).toHaveLength(1);
    expect(mapped[0].url).toBe("https://cdn.test/good.mp4");
  });

  it("canonicalizes URLs and removes duplicates of the same file", () => {
    expect(normalizeStreamKey("https://EXAMPLE.COM:443/file.mp4#t=10")).toBe("https://example.com/file.mp4");
    expect(normalizeStreamKey("https://cdn.test/file.mp4/")).toBe("https://cdn.test/file.mp4");
    expect(normalizeStreamKey("magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12&dn=test")).toBe(
      "magnet:abcdef1234567890abcdef1234567890abcdef12",
    );

    const streams: StremioStream[] = [
      { name: "P", title: "Video 1", url: "https://cdn.test/file.mp4" },
      { name: "P", title: "Video 1 Duplicate with hash", url: "https://CDN.TEST/file.mp4#t=5" },
      { name: "P", title: "Video 1 Duplicate with trailing slash", url: "https://cdn.test/file.mp4/" },
      { name: "P", title: "Video 2", url: "https://cdn.test/file2.mp4" },
    ];
    const deduped = sortStreams(streams);
    expect(deduped).toHaveLength(2);
    expect(deduped.map((s) => s.url)).toEqual(["https://cdn.test/file.mp4", "https://cdn.test/file2.mp4"]);
  });

  it("sorts direct streams before external links", () => {
    const streams: StremioStream[] = [
      { name: "P", title: "4K Web", externalUrl: "https://screenscape.me/embed?tmdb=1" },
      { name: "P", title: "1080p Direct", url: "https://cdn.test/1080.mp4" },
      { name: "P", title: "720p Direct", url: "https://cdn.test/720.mp4" },
    ];
    const sorted = sortStreams(streams);
    expect(sorted[0].url).toBe("https://cdn.test/1080.mp4");
    expect(sorted[1].url).toBe("https://cdn.test/720.mp4");
    expect(sorted[2].externalUrl).toBe("https://screenscape.me/embed?tmdb=1");
  });
});

describe("quality inference", () => {
  function inferred(
    title: string,
    bingeGroup?: string,
    url = "https://cdn.test/video.mp4",
  ): number {
    return inferQuality({
      name: "P",
      ...(title ? { title } : {}),
      url,
      ...(bingeGroup ? { behaviorHints: { bingeGroup } } : {}),
    });
  }

  it("parses resolution tags with and without the p suffix", () => {
    expect(inferred("Vega \u2022 1080p")).toBe(1080);
    expect(inferred("Vega \u2022 1080")).toBe(1080);
    expect(inferred("Vega \u2022 720")).toBe(720);
    expect(inferred("Vega \u2022 1080p60")).toBe(1080);
    expect(inferred("Vega \u2022 1080p60fps")).toBe(1080);
    expect(inferred("", "autoEmbed-1080")).toBe(1080);
    expect(inferred("", undefined, "https://cdn.test/1920x1080/file.m3u8")).toBe(1080);
  });

  it("parses quality labels", () => {
    expect(inferred("Vega \u2022 8K")).toBe(4320);
    expect(inferred("Vega \u2022 4K")).toBe(2160);
    expect(inferred("Vega \u2022 UHD")).toBe(2160);
    expect(inferred("Vega \u2022 QHD")).toBe(1440);
    expect(inferred("Vega \u2022 FHD")).toBe(1080);
  });

  it("does not treat codec names, years, or vague labels as resolutions", () => {
    expect(inferred("Vega \u2022 h264")).toBe(0);
    expect(inferred("Vega \u2022 x265")).toBe(0);
    expect(inferred("Movie 2024")).toBe(0);
    expect(inferred("HD")).toBe(0);
  });
});

describe("file size inference", () => {
  function size(title: string): number {
    return inferFileSizeBytes({ name: "P", title, url: "https://cdn.test/file.mp4" });
  }

  it("parses human-readable sizes", () => {
    expect(size("720p - 656 MB - 1.5 MB/s")).toBe(656 * 1024 ** 2);
    expect(size("1080p - 1.29 GB - 3 MB/s")).toBe(Math.round(1.29 * 1024 ** 3));
    expect(size("4K [3.57 GB]")).toBe(Math.round(3.57 * 1024 ** 3));
    expect(size("1,5 GB")).toBe(Math.round(1.5 * 1024 ** 3));
    expect(size("512 MiB")).toBe(512 * 1024 ** 2);
  });

  it("ignores speeds and text without a size", () => {
    expect(size("720p - 1.5 MB/s")).toBe(0);
    expect(size("ORG - 27 MB/S")).toBe(0);
    expect(size("360p - 490 KB/s")).toBe(0);
    expect(size("1080p")).toBe(0);
    expect(size("")).toBe(0);
  });
});
