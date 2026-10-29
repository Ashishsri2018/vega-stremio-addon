import { describe, expect, it } from "vitest";
import {
  DEFAULT_USER_CONFIG,
  encodeUserConfig,
  filterStreams,
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
    const config = { maxRes: 1080, minRes: 720, includeUnknown: false };
    expect(parseUserConfig(encodeUserConfig(config))).toEqual(config);

    const onlyMax = { maxRes: 720, minRes: null, includeUnknown: true };
    expect(parseUserConfig(encodeUserConfig(onlyMax))).toEqual(onlyMax);

    const noUnknown = { maxRes: null, minRes: null, includeUnknown: false };
    expect(parseUserConfig(encodeUserConfig(noUnknown))).toEqual(noUnknown);
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
    });
    expect(filtered.map((entry) => entry.title)).toEqual(["720p", "480p"]);
  });

  it("enforces a minimum resolution", () => {
    const filtered = filterStreams(streams, {
      maxRes: null,
      minRes: 1080,
      includeUnknown: true,
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
    });
    expect(filtered.map((entry) => entry.title)).toEqual(["1080p", "720p", "480p"]);
  });

  it("filters bare resolution tags without the p suffix", () => {
    const list = [stream("1080"), stream("720"), stream("HD")];
    const filtered = filterStreams(list, {
      maxRes: 720,
      minRes: null,
      includeUnknown: false,
    });
    expect(filtered.map((entry) => entry.title)).toEqual(["720"]);
  });

  it("can drop every stream with no usable quality", () => {
    const filtered = filterStreams(streams, {
      maxRes: null,
      minRes: null,
      includeUnknown: false,
    });
    expect(filtered.map((entry) => entry.title)).toEqual([
      "2160p",
      "1080p",
      "720p",
      "480p",
    ]);
  });
});
