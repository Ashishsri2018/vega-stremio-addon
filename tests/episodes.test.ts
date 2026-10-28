import { describe, expect, it } from "vitest";
import {
  isSeasonPack,
  matchesEpisode,
  parseEpisodeRanges,
} from "../src/pipeline/episodes.js";

describe("parseEpisodeRanges", () => {
  it("parses compact S/E forms", () => {
    expect(parseEpisodeRanges("Show.S01E02.1080p")).toEqual([
      { season: 1, from: 2, to: 2 },
    ]);
    expect(parseEpisodeRanges("Show S1E2")).toEqual([{ season: 1, from: 2, to: 2 }]);
  });

  it("parses S/E ranges", () => {
    expect(parseEpisodeRanges("S01E01-E05")).toEqual([{ season: 1, from: 1, to: 5 }]);
    expect(parseEpisodeRanges("S01E01-05")).toEqual([{ season: 1, from: 1, to: 5 }]);
    expect(parseEpisodeRanges("Show S02E10-E12 Complete")).toEqual([
      { season: 2, from: 10, to: 12 },
    ]);
  });

  it("parses long-form season and episode forms", () => {
    expect(parseEpisodeRanges("Season 1 Episode 2")).toEqual([
      { season: 1, from: 2, to: 2 },
    ]);
    expect(parseEpisodeRanges("Season 1 Ep 2")).toEqual([{ season: 1, from: 2, to: 2 }]);
    expect(parseEpisodeRanges("Season 1 Episodes 1-5")).toEqual([
      { season: 1, from: 1, to: 5 },
    ]);
  });

  it("parses 1x02 and standalone episode ranges", () => {
    expect(parseEpisodeRanges("Show 1x02")).toEqual([{ season: 1, from: 2, to: 2 }]);
    expect(parseEpisodeRanges("E01-E05")).toEqual([{ from: 1, to: 5 }]);
    expect(parseEpisodeRanges("EP01-05")).toEqual([{ from: 1, to: 5 }]);
    expect(parseEpisodeRanges("Episode 3")).toEqual([{ from: 3, to: 3 }]);
  });

  it("extracts multiple ranges in textual order", () => {
    expect(parseEpisodeRanges("S01E01-E03 S01E07 E01-E02")).toEqual([
      { season: 1, from: 1, to: 3 },
      { season: 1, from: 7, to: 7 },
      { from: 1, to: 2 },
    ]);
  });

  it("ignores titles without episode ranges", () => {
    expect(parseEpisodeRanges("The Complete First Season")).toEqual([]);
    expect(parseEpisodeRanges("")).toEqual([]);
  });
});

describe("isSeasonPack", () => {
  it("recognizes packs and multi-episode ranges", () => {
    expect(isSeasonPack("Show Season 1 Complete", 1)).toBe(true);
    expect(isSeasonPack("Show: Complete Season 1", 1)).toBe(true);
    expect(isSeasonPack("Show Full Season 1", 1)).toBe(true);
    expect(isSeasonPack("Show Season 1", 1)).toBe(true);
    expect(isSeasonPack("Show S01", 1)).toBe(true);
    expect(isSeasonPack("Show Complete", 1)).toBe(true);
    expect(isSeasonPack("Show S01E01-E05", 1)).toBe(true);
    expect(isSeasonPack("Show E01-E05", 1)).toBe(true);
  });

  it("rejects individual episodes and other seasons", () => {
    expect(isSeasonPack("Show S01E01", 1)).toBe(false);
    expect(isSeasonPack("Show Season 1 Episode 2", 1)).toBe(false);
    expect(isSeasonPack("Show Season 2 Complete", 1)).toBe(false);
    expect(isSeasonPack("Show S02E01-E05", 1)).toBe(false);
  });
});

describe("matchesEpisode", () => {
  it("matches explicit season and episode forms", () => {
    expect(matchesEpisode("Show S01E02 1080p", 1, 2)).toBe(true);
    expect(matchesEpisode("Show S1E2", 1, 2)).toBe(true);
    expect(matchesEpisode("Show Season 1 Episode 2", 1, 2)).toBe(true);
    expect(matchesEpisode("Show Season 1 Ep 2", 1, 2)).toBe(true);
    expect(matchesEpisode("Show 1x02", 1, 2)).toBe(true);
    expect(matchesEpisode("Show E02", 1, 2)).toBe(true);
  });

  it("matches episodes inside ranges", () => {
    expect(matchesEpisode("Show S01E01-E05", 1, 3)).toBe(true);
    expect(matchesEpisode("Show S01E01-05", 1, 1)).toBe(true);
    expect(matchesEpisode("Show E01-E05", 1, 4)).toBe(true);
    expect(matchesEpisode("Show S01E01-E05", 1, 6)).toBe(false);
  });

  it("rejects wrong seasons and non-matching episodes", () => {
    expect(matchesEpisode("Show S02E01", 1, 1)).toBe(false);
    expect(matchesEpisode("Show Season 2 Episode 1", 1, 1)).toBe(false);
    expect(matchesEpisode("Show S01E02", 1, 1)).toBe(false);
    expect(matchesEpisode("Show 1x05", 1, 2)).toBe(false);
    expect(matchesEpisode("A Movie Title", 1, 1)).toBe(false);
  });

  it("supports Cinemeta episode-name fallback", () => {
    expect(matchesEpisode("Show - The Pilot 1080p", 1, 1, "The Pilot")).toBe(true);
    expect(matchesEpisode("The Pilot", 1, 1, "Pilot")).toBe(true);
    expect(matchesEpisode("Show - Ozymandias", 1, 1, "Pilot")).toBe(false);
    expect(matchesEpisode("Show S01E02 Pilot", 1, 1, "Pilot")).toBe(false);
  });

  it("matches any link belonging to a season for pack requests", () => {
    expect(matchesEpisode("Show S01E01", 1)).toBe(true);
    expect(matchesEpisode("Show S01E01-E05", 1)).toBe(true);
    expect(matchesEpisode("Show Season 1 Complete", 1)).toBe(true);
    expect(matchesEpisode("Show S01", 1)).toBe(true);
    expect(matchesEpisode("Show Complete", 1)).toBe(true);
    expect(matchesEpisode("Show S02E01", 1)).toBe(false);
    expect(matchesEpisode("Show Season 2", 1)).toBe(false);
  });

  it("treats a season pack title as not matching a specific episode", () => {
    expect(matchesEpisode("Show Season 1 Complete", 1, 1)).toBe(false);
  });
});
