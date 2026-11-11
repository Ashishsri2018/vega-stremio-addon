import { describe, expect, it } from "vitest";
import {
  DEFAULT_USER_CONFIG,
  encodeUserConfig,
  filterStreams,
  filterSubtitleTracks,
  parseUserConfig,
} from "../src/addon/userConfig.js";
import type { StremioStream } from "../src/types.js";

function segmentOf(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function stream(title: string | undefined): StremioStream {
  return {
    name: "Provider",
    ...(title ? { title } : {}),
    url: `https://cdn.example.com/${title ?? "unlabeled"}.mp4`,
  };
}

describe("encodeUserConfig", () => {
  it("encodes defaults compactly", () => {
    expect(encodeUserConfig(DEFAULT_USER_CONFIG)).toBe("eyJ2IjoxfQ");
  });

  it("omits unset fields and round-trips through parseUserConfig", () => {
    const config = {
      maxRes: 1080,
      minRes: 720,
      includeUnknown: false,
      maxSizeMB: 4096,
      includeUnknownSize: false,
      subtitleLangs: ["en", "pt-br"],
      providers: [],
      disabledProviders: [],
    };
    expect(parseUserConfig(encodeUserConfig(config))).toEqual(config);

    const onlyMax = {
      maxRes: 720,
      minRes: null,
      includeUnknown: true,
      maxSizeMB: null,
      includeUnknownSize: true,
      subtitleLangs: [],
      providers: [],
      disabledProviders: [],
    };
    expect(parseUserConfig(encodeUserConfig(onlyMax))).toEqual(onlyMax);

    const noUnknown = {
      maxRes: null,
      minRes: null,
      includeUnknown: false,
      maxSizeMB: null,
      includeUnknownSize: false,
      subtitleLangs: [],
      providers: [],
      disabledProviders: [],
    };
    expect(parseUserConfig(encodeUserConfig(noUnknown))).toEqual(noUnknown);
  });

  it("round-trips provider include and exclude filters", () => {
    const config = {
      ...DEFAULT_USER_CONFIG,
      providers: ["NetMirror", "showbox"],
      disabledProviders: ["vidsrc"],
    };
    expect(parseUserConfig(encodeUserConfig(config))).toEqual({
      ...config,
      providers: ["netmirror", "showbox"],
      disabledProviders: ["vidsrc"],
    });
  });
});

describe("parseUserConfig", () => {
  it("returns defaults for a missing or empty segment", () => {
    expect(parseUserConfig(undefined)).toEqual(DEFAULT_USER_CONFIG);
    expect(parseUserConfig("")).toEqual(DEFAULT_USER_CONFIG);
  });

  it("returns defaults for undecodable segments", () => {
    for (const segment of ["!!!", "bm90LWpzb24"]) {
      expect(parseUserConfig(segment)).toEqual(DEFAULT_USER_CONFIG);
    }
  });

  it("returns defaults for unsupported versions and invalid shapes", () => {
    const invalid = [
      { v: 2, maxRes: 720 },
      { v: 1, maxRes: "720p" },
      { v: 1, maxRes: 100 },
      { v: 1, minRes: 1080, maxRes: 720 },
      { v: 1, includeUnknown: "no" },
      { v: 1, maxSizeMB: "2GB" },
      { v: 1, maxSizeMB: 0 },
      { v: 1, includeUnknownSize: "no" },
      { v: 1, subtitleLangs: "en" },
      { v: 1, subtitleLangs: ["not a language"] },
      { v: 1, providers: "netmirror" },
      { v: 1, providers: ["bad provider"] },
      { v: 1, disabledProviders: ["bad/value"] },
      { v: 1, providers: Array.from({ length: 51 }, (_, index) => `p${index}`) },
      "not an object",
    ];
    for (const value of invalid) {
      expect(parseUserConfig(segmentOf(value))).toEqual(DEFAULT_USER_CONFIG);
    }
  });

  it("accepts partial configs", () => {
    expect(parseUserConfig(segmentOf({ v: 1, maxRes: 720 }))).toEqual({
      maxRes: 720,
      minRes: null,
      includeUnknown: true,
      maxSizeMB: null,
      includeUnknownSize: true,
      subtitleLangs: [],
      providers: [],
      disabledProviders: [],
    });
    expect(parseUserConfig(segmentOf({} as Record<string, unknown>))).toEqual(
      DEFAULT_USER_CONFIG,
    );
  });
});

describe("filterStreams", () => {
  const streams = [
    stream("2160p"),
    stream("1080p"),
    stream("720p"),
    stream("480p"),
    stream("HD"),
    stream(undefined),
  ];

  it("returns the input untouched with the default config", () => {
    expect(filterStreams(streams, DEFAULT_USER_CONFIG)).toBe(streams);
  });

  it("drops streams above the maximum resolution but keeps unknown ones", () => {
    const filtered = filterStreams(streams, {
      maxRes: 720,
      minRes: null,
      includeUnknown: true,
      maxSizeMB: null,
      includeUnknownSize: true,
      subtitleLangs: [],
    });
    expect(filtered.map((entry) => entry.title ?? "unlabeled")).toEqual([
      "720p",
      "480p",
      "HD",
      "unlabeled",
    ]);
  });

  it("drops unknown-resolution streams when the toggle is off", () => {
    const filtered = filterStreams(streams, {
      maxRes: 720,
      minRes: null,
      includeUnknown: false,
      maxSizeMB: null,
      includeUnknownSize: true,
      subtitleLangs: [],
    });
    expect(filtered.map((entry) => entry.title)).toEqual(["720p", "480p"]);
  });

  it("enforces a minimum resolution", () => {
    const filtered = filterStreams(streams, {
      maxRes: null,
      minRes: 1080,
      includeUnknown: true,
      maxSizeMB: null,
      includeUnknownSize: true,
      subtitleLangs: [],
    });
    expect(filtered.map((entry) => entry.title ?? "unlabeled")).toEqual([
      "2160p",
      "1080p",
      "HD",
      "unlabeled",
    ]);
  });

  it("combines minimum and maximum bounds", () => {
    const filtered = filterStreams(streams, {
      maxRes: 1080,
      minRes: 480,
      includeUnknown: false,
      maxSizeMB: null,
      includeUnknownSize: true,
      subtitleLangs: [],
    });
    expect(filtered.map((entry) => entry.title)).toEqual(["1080p", "720p", "480p"]);
  });

  it("filters bare resolution tags without the p suffix", () => {
    const list = [stream("1080"), stream("720"), stream("HD")];
    const filtered = filterStreams(list, {
      maxRes: 720,
      minRes: null,
      includeUnknown: false,
      maxSizeMB: null,
      includeUnknownSize: true,
      subtitleLangs: [],
    });
    expect(filtered.map((entry) => entry.title)).toEqual(["720"]);
  });

  it("can drop every stream with no usable quality", () => {
    const filtered = filterStreams(streams, {
      maxRes: null,
      minRes: null,
      includeUnknown: false,
      maxSizeMB: null,
      includeUnknownSize: true,
      subtitleLangs: [],
    });
    expect(filtered.map((entry) => entry.title)).toEqual([
      "2160p",
      "1080p",
      "720p",
      "480p",
    ]);
  });
});

describe("subtitle language filtering", () => {
  function tracks(langs: string[]): StremioStream["subtitles"] {
    return langs.map((lang, index) => ({
      id: `sub-${index}`,
      url: `https://subs.example/${lang}.vtt`,
      lang,
    }));
  }

  it("normalizes language codes when encoding", () => {
    const segment = encodeUserConfig({
      maxRes: null,
      minRes: null,
      includeUnknown: true,
      subtitleLangs: ["EN", "en", "Pt_BR", ""],
    });
    expect(parseUserConfig(segment).subtitleLangs).toEqual(["en", "pt-br"]);
  });

  it("keeps only subtitle tracks matching the configured languages", () => {
    const list = tracks(["en", "en-US", "es", "pt-BR"]);
    const filtered = filterSubtitleTracks(list ?? [], {
      maxRes: null,
      minRes: null,
      includeUnknown: true,
      subtitleLangs: ["en", "pt"],
    });

    expect(filtered.map((track) => track.lang)).toEqual(["en", "en-US", "pt-BR"]);
    expect(list).toHaveLength(4);
  });

  it("returns no tracks when nothing matches", () => {
    const list = tracks(["es"]);
    expect(
      filterSubtitleTracks(list ?? [], {
        maxRes: null,
        minRes: null,
        includeUnknown: true,
        subtitleLangs: ["en"],
      }),
    ).toEqual([]);
  });

  it("never drops streams or inline subtitle tracks for language preferences", () => {
    const input: StremioStream = {
      name: "Provider",
      title: "1080p",
      url: "https://cdn.example.com/movie.mp4",
      subtitles: tracks(["es"]),
    };
    const plain: StremioStream = {
      name: "Provider",
      url: "https://cdn.example.com/plain.mp4",
    };
    const filtered = filterStreams([input, plain], {
      maxRes: null,
      minRes: null,
      includeUnknown: true,
      subtitleLangs: ["en"],
    });

    expect(filtered).toEqual([input, plain]);
    expect(filtered[0]?.subtitles).toHaveLength(1);
  });
});

describe("file size filtering", () => {
  it("drops streams above the maximum size and keeps unknown sizes", () => {
    const list = [
      stream("720p - 656 MB"),
      stream("1080p - 1.29 GB"),
      stream("4K - 3.57 GB"),
      stream("Auto"),
    ];
    const filtered = filterStreams(list, {
      maxRes: null,
      minRes: null,
      includeUnknown: true,
      maxSizeMB: 2048,
      includeUnknownSize: true,
      subtitleLangs: [],
    });

    expect(filtered.map((entry) => entry.title)).toEqual([
      "720p - 656 MB",
      "1080p - 1.29 GB",
      "Auto",
    ]);
  });

  it("drops unknown sizes when disabled", () => {
    const list = [stream("720p - 656 MB"), stream("Auto"), stream("720p - 1.5 MB/s")];
    const filtered = filterStreams(list, {
      maxRes: null,
      minRes: null,
      includeUnknown: true,
      maxSizeMB: 2048,
      includeUnknownSize: false,
      subtitleLangs: [],
    });

    expect(filtered.map((entry) => entry.title)).toEqual(["720p - 656 MB"]);
  });

  it("combines resolution and size filters", () => {
    const list = [
      stream("2160p - 1 GB"),
      stream("1080p - 5 GB"),
      stream("720p - 700 MB"),
    ];
    const filtered = filterStreams(list, {
      maxRes: 1080,
      minRes: null,
      includeUnknown: true,
      maxSizeMB: 2048,
      includeUnknownSize: true,
      subtitleLangs: [],
    });

    expect(filtered.map((entry) => entry.title)).toEqual(["720p - 700 MB"]);
  });
});
