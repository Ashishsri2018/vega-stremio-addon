import { describe, expect, it } from "vitest";
import type { Post } from "../src/types.js";
import {
  extractYear,
  normalizeTitle,
  rankCandidates,
  scoreCandidate,
} from "../src/pipeline/match.js";

function post(title: string, extra: Partial<Post> = {}): Post {
  return { title, link: `https://provider.test/${encodeURIComponent(title)}`, ...extra };
}

describe("normalizeTitle", () => {
  it("strips provider filler, quality, language and punctuation", () => {
    expect(normalizeTitle("Download The Godfather (1972) Full Movie Free 1080p")).toBe(
      "the godfather 1972",
    );
    expect(normalizeTitle("The.Matrix.1999.WEB-DL.x265.Hindi.Dubbed")).toBe(
      "the matrix 1999",
    );
    expect(normalizeTitle("Watch Online Inception 2010 4K HDR")).toBe("inception 2010");
    expect(normalizeTitle("Spider-Man: No Way Home")).toBe("spider man no way home");
    expect(normalizeTitle("Schindler's List")).toBe("schindlers list");
  });

  it("normalizes ampersands and safe Roman numerals", () => {
    expect(normalizeTitle("Fast & Furious Presents: Hobbs & Shaw")).toBe(
      "fast and furious presents hobbs and shaw",
    );
    expect(normalizeTitle("Rocky II")).toBe("rocky 2");
    expect(normalizeTitle("Rocky IV")).toBe("rocky 4");
    expect(normalizeTitle("Star Wars: Episode V - The Empire Strikes Back")).toBe(
      "star wars episode 5 the empire strikes back",
    );
    expect(normalizeTitle("I Am Legend")).toBe("i am legend");
    expect(normalizeTitle("Mission: Impossible - Dead Reckoning")).toBe(
      "mission impossible dead reckoning",
    );
  });

  it("handles empty and non-string input safely", () => {
    expect(normalizeTitle("")).toBe("");
    expect(normalizeTitle(undefined as unknown as string)).toBe("");
    expect(normalizeTitle("---")).toBe("");
  });
});

describe("extractYear", () => {
  it("extracts four-digit release years", () => {
    expect(extractYear("The Godfather (1972)")).toBe(1972);
    expect(extractYear("Blade Runner 2049 2017 1080p")).toBe(2049);
    expect(extractYear("No year here")).toBeNull();
  });

  it("does not mistake resolutions for years", () => {
    expect(extractYear("Movie 1080p 2160p 4K")).toBeNull();
  });
});

describe("scoreCandidate", () => {
  const movieRequest = { title: "Inception", year: 2010, type: "movie" as const };
  const seriesRequest = { title: "Breaking Bad", type: "series" as const };

  it("rewards exact, prefix, containment and token overlap", () => {
    const exact = scoreCandidate(post("Inception"), movieRequest);
    const prefix = scoreCandidate(post("Inception 2010"), movieRequest);
    const contains = scoreCandidate(post("Watch Inception Online"), movieRequest);
    const overlap = scoreCandidate(post("Inception Dream Machine"), movieRequest);

    expect(exact).toBeGreaterThanOrEqual(100);
    expect(prefix).toBeGreaterThan(overlap);
    expect(contains).toBeGreaterThan(overlap);
    expect(Number.isInteger(exact)).toBe(true);
  });

  it("rewards matching years and penalizes explicit conflicts", () => {
    const matching = scoreCandidate(post("The Thing 1982"), {
      title: "The Thing",
      year: 1982,
      type: "movie",
    });
    const conflicting = scoreCandidate(post("The Thing 2011"), {
      title: "The Thing",
      year: 1982,
      type: "movie",
    });
    expect(matching).toBeGreaterThan(conflicting);
    expect(conflicting).toBeGreaterThanOrEqual(0);
  });

  it("applies series and movie medium hints", () => {
    const asSeries = scoreCandidate(post("Breaking Bad Complete Series"), seriesRequest);
    const asMovie = scoreCandidate(post("Breaking Bad Complete Series"), {
      title: "Breaking Bad",
      type: "movie",
    });
    expect(asSeries).toBeGreaterThan(asMovie);

    const moviePostAsMovie = scoreCandidate(post("Inception Movie"), {
      title: "Inception",
      type: "movie",
    });
    const moviePostAsSeries = scoreCandidate(post("Inception Movie"), {
      title: "Inception",
      type: "series",
    });
    expect(moviePostAsMovie).toBeGreaterThan(moviePostAsSeries);
  });

  it("adds a small bonus for an image", () => {
    const plain = scoreCandidate(post("Inception"), movieRequest);
    const illustrated = scoreCandidate(
      post("Inception", { image: "https://img.test/poster.jpg" }),
      movieRequest,
    );
    expect(illustrated - plain).toBe(5);
  });

  it("keeps scores non-negative for clearly wrong candidates", () => {
    const score = scoreCandidate(post("Alien Season 2 Complete"), {
      title: "Inception",
      year: 2010,
      type: "movie",
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(score)).toBe(true);
  });
});

describe("rankCandidates", () => {
  it("filters zero scores, sorts descending and caps the list", () => {
    const posts = [
      post("Unrelated Title"),
      post("Inception 2010", { image: "https://img.test/a.jpg" }),
      post("Inception"),
      post("Inception Dream"),
      post("Watch Inception Online"),
    ];
    const ranked = rankCandidates(posts, { title: "Inception", year: 2010, type: "movie" });
    expect(ranked).toHaveLength(3);
    expect(ranked[0].post.title).toBe("Inception");
    expect(ranked.map((entry) => entry.post.title)).toContain("Inception 2010");
    expect(ranked.every((entry) => entry.score > 0)).toBe(true);
    expect(ranked.map((entry) => entry.post.title)).not.toContain("Unrelated Title");
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
  });

  it("honors an explicit limit and defaults safely", () => {
    const posts = [post("Inception"), post("Inception 2010")];
    expect(rankCandidates(posts, { title: "Inception", type: "movie" }, 1)).toHaveLength(1);
    expect(rankCandidates([], { title: "Inception", type: "movie" })).toEqual([]);
  });
});
