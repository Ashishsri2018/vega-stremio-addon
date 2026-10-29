import { describe, expect, it, vi } from "vitest";
import { loadConfig, type AppConfig } from "../src/config.js";
import type {
  CinemetaApi,
  CinemetaMeta,
  LoggerLike,
  Post,
  ProviderBundle,
  ProviderContextLike,
  ProviderModules,
  ProviderRegistryApi,
  ProviderSnapshot,
  ProviderStream,
  StreamRequest,
} from "../src/types.js";
import { StreamPipeline } from "../src/pipeline/streamHandler.js";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({ DATA_DIR: "/tmp/vega-pipeline-test" }),
    searchTimeoutMs: 80,
    metaTimeoutMs: 80,
    streamTimeoutMs: 80,
    globalDeadlineMs: 1500,
    searchConcurrency: 4,
    includeMagnets: false,
    streamCacheTtlMs: 60000,
    ...overrides,
  };
}

function testLogger(): LoggerLike {
  const noop = (): void => undefined;
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => testLogger(),
  };
}

function makeBundle(
  value: string,
  displayName: string,
  overrides: Partial<ProviderModules> = {},
): ProviderBundle {
  const modules: ProviderModules = {
    posts: overrides.posts ?? { getSearchPosts: () => [] },
    meta: overrides.meta ?? { getMeta: () => ({}) },
    stream: overrides.stream ?? { getStream: () => [] },
    ...(overrides.episodes ? { episodes: overrides.episodes } : {}),
  };
  return {
    entry: { display_name: displayName, value, version: "1.0.0", disabled: false },
    dir: `/tmp/${value}`,
    modules,
  };
}

function makeRegistry(bundles: ProviderBundle[]): {
  registry: ProviderRegistryApi;
  release: ReturnType<typeof vi.fn>;
  activate: () => void;
} {
  const snapshot: ProviderSnapshot = {
    sha: "test-sha",
    rootDir: "/tmp/providers",
    urls: {},
    bundles: new Map(bundles.map((bundle) => [bundle.entry.value, bundle])),
    createdAt: Date.now(),
  };
  let listener: ((snapshot: ProviderSnapshot) => void) | undefined;
  const release = vi.fn();
  const registry: ProviderRegistryApi = {
    context: {} as ProviderContextLike,
    listProviders: () => bundles,
    getActiveSnapshot: () => snapshot,
    acquire: () => ({ snapshot, release }),
    onActivate: (next) => {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    },
  };
  return { registry, release, activate: () => listener?.(snapshot) };
}

function makeCinemeta(meta: CinemetaMeta | null): CinemetaApi {
  return { getMeta: async () => meta };
}

function movieProvider(options: {
  value: string;
  display?: string;
  url: string;
  quality?: string;
  server?: string;
  linkType?: string;
  stream?: ProviderModules["stream"];
}): ProviderBundle {
  const post: Post = {
    title: "The Shawshank Redemption 1994",
    link: `https://${options.value}.test/post`,
  };
  return makeBundle(options.value, options.display ?? options.value, {
    posts: { getSearchPosts: async () => [post] },
    meta: {
      getMeta: async () => ({
        title: "The Shawshank Redemption",
        imdbId: "tt0111161",
        type: "movie",
        linkList: [
          {
            title: "Download",
            quality: options.quality,
            directLinks: [
              { title: "Direct", link: options.url, type: options.linkType ?? "movie" },
            ],
          },
        ],
      }),
    },
    stream: options.stream ?? {
      getStream: async ({ link }) => [
        {
          server: options.server ?? "Server",
          link,
          quality: options.quality ?? "1080p",
        },
      ],
    },
  });
}

const movieMeta: CinemetaMeta = {
  id: "tt0111161",
  type: "movie",
  name: "The Shawshank Redemption",
  year: "1994",
};

const seriesMeta: CinemetaMeta = {
  id: "tt0903747",
  type: "series",
  name: "Breaking Bad",
  year: "2008",
  videos: [{ season: 1, episode: 1, name: "Pilot" }],
};

const seriesPost: Post = {
  title: "Breaking Bad 2008",
  link: "https://series.test/post",
};

function seriesBundle(overrides: {
  meta: ReturnType<NonNullable<ProviderModules["meta"]>["getMeta"]> | object;
  episodes?: ProviderModules["episodes"];
  stream: ProviderModules["stream"];
}): ProviderBundle {
  return makeBundle("seriesprov", "Series Provider", {
    posts: { getSearchPosts: async () => [seriesPost] },
    meta: { getMeta: async () => overrides.meta },
    stream: overrides.stream,
    ...(overrides.episodes ? { episodes: overrides.episodes } : {}),
  });
}

describe("StreamPipeline movie flow", () => {
  it("merges multiple providers, maps and sorts streams", async () => {
    const alpha = movieProvider({
      value: "alpha",
      display: "Alpha",
      url: "https://alpha.test/720.mp4",
      quality: "720p",
      server: "AlphaServer",
    });
    const beta = movieProvider({
      value: "beta",
      display: "Beta",
      url: "https://beta.test/1080.m3u8",
      quality: "1080p",
      server: "BetaServer",
    });
    const { registry } = makeRegistry([alpha, beta]);
    const pipeline = new StreamPipeline({
      config: testConfig(),
      logger: testLogger(),
      registry,
      cinemeta: makeCinemeta(movieMeta),
    });

    const streams = await pipeline.handle({ type: "movie", imdbId: "tt0111161" });
    expect(streams).toHaveLength(2);
    expect(streams[0].url).toBe("https://beta.test/1080.m3u8");
    expect(streams[0].name).toBe("Beta");
    expect(streams[0].behaviorHints?.bingeGroup).toBe("beta-1080p");
    expect(streams[1].url).toBe("https://alpha.test/720.mp4");
    expect(streams[1].name).toBe("Alpha");
  });

  it("passes debrid-style direct http links", async () => {
    const provider = movieProvider({
      value: "debrid",
      display: "Debrid",
      url: "https://debrid.test/second-hop",
      quality: "1080p",
      linkType: undefined,
      stream: {
        getStream: async () => [
          {
            server: "Debrid Server",
            link: "https://cdn.test/debrid.mkv",
            type: "direct",
            quality: "1080p",
          },
        ],
      },
    });
    const { registry } = makeRegistry([provider]);
    const pipeline = new StreamPipeline({
      config: testConfig(),
      logger: testLogger(),
      registry,
      cinemeta: makeCinemeta(movieMeta),
    });

    const streams = await pipeline.handle({ type: "movie", imdbId: "tt0111161" });
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toBe("https://cdn.test/debrid.mkv");
  });
});

describe("StreamPipeline series flow", () => {
  it("resolves episodes links, direct links and Cinemeta episode names", async () => {
    const getEpisodes = vi.fn(async () => [
      { title: "Pilot", link: "https://series.test/pilot" },
      { title: "Episode 2", link: "https://series.test/episode-2" },
    ]);
    const getStream = vi.fn(async ({ link }: { link: string }): Promise<ProviderStream[]> => [
      { server: "Series Server", link, quality: "1080p" },
    ]);
    const bundle = seriesBundle({
      meta: {
        title: "Breaking Bad",
        imdbId: "tt0903747",
        type: "series",
        linkList: [
          { title: "Season 1", episodesLink: "https://series.test/episodes" },
          {
            title: "S01E01",
            directLinks: [{ title: "Direct", link: "https://series.test/direct" }],
          },
        ],
      },
      episodes: { getEpisodes },
      stream: { getStream },
    });
    const { registry } = makeRegistry([bundle]);
    const pipeline = new StreamPipeline({
      config: testConfig(),
      logger: testLogger(),
      registry,
      cinemeta: makeCinemeta(seriesMeta),
    });

    const streams = await pipeline.handle({
      type: "series",
      imdbId: "tt0903747",
      season: 1,
      episode: 1,
    });
    const urls = streams.map((stream) => stream.url).sort();
    expect(urls).toEqual(["https://series.test/direct", "https://series.test/pilot"]);
    expect(getEpisodes).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://series.test/episodes" }),
    );
  });

  it("handles season pack requests and excludes other seasons", async () => {
    const getEpisodes = vi.fn(async () => [
      { title: "Show S01E01", link: "https://series.test/s1e1" },
      { title: "Show S01E02", link: "https://series.test/s1e2" },
      { title: "Show S02E01", link: "https://series.test/s2e1" },
    ]);
    const bundle = seriesBundle({
      meta: {
        title: "Breaking Bad",
        imdbId: "tt0903747",
        type: "series",
        linkList: [
          {
            title: "Season 1 Complete",
            directLinks: [{ link: "https://series.test/s1pack" }],
          },
          { title: "Season 1 Episodes", episodesLink: "https://series.test/episodes" },
          {
            title: "Season 2 Complete",
            directLinks: [{ link: "https://series.test/s2pack" }],
          },
        ],
      },
      episodes: { getEpisodes },
      stream: {
        getStream: async ({ link }) => [
          { server: "Series Server", link, quality: "720p" },
        ],
      },
    });
    const { registry } = makeRegistry([bundle]);
    const pipeline = new StreamPipeline({
      config: testConfig(),
      logger: testLogger(),
      registry,
      cinemeta: makeCinemeta(seriesMeta),
    });

    const streams = await pipeline.handle({
      type: "series",
      imdbId: "tt0903747",
      season: 1,
    });
    expect(streams.map((stream) => stream.url).sort()).toEqual([
      "https://series.test/s1e1",
      "https://series.test/s1e2",
      "https://series.test/s1pack",
    ]);
  });
});

describe("StreamPipeline magnets and failures", () => {
  it("filters magnet-only providers unless magnets are enabled", async () => {
    const magnetStream: ProviderModules["stream"] = {
      getStream: async () => [
        {
          server: "Torrent Server",
          link: "magnet:?xt=urn:btih:deadbeef",
          type: "torrent",
          quality: "1080p",
        },
      ],
    };
    const provider = movieProvider({
      value: "torrentio",
      display: "Torrentio",
      url: "https://torrentio.test/post",
      stream: magnetStream,
    });

    const without = makeRegistry([provider]);
    const filteredPipeline = new StreamPipeline({
      config: testConfig({ includeMagnets: false }),
      logger: testLogger(),
      registry: without.registry,
      cinemeta: makeCinemeta(movieMeta),
    });
    await expect(
      filteredPipeline.handle({ type: "movie", imdbId: "tt0111161" }),
    ).resolves.toEqual([]);

    const withMagnets = makeRegistry([provider]);
    const magnetPipeline = new StreamPipeline({
      config: testConfig({ includeMagnets: true }),
      logger: testLogger(),
      registry: withMagnets.registry,
      cinemeta: makeCinemeta(movieMeta),
    });
    const streams = await magnetPipeline.handle({ type: "movie", imdbId: "tt0111161" });
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toBe("magnet:?xt=urn:btih:deadbeef");
  });

  it("returns partial results when a provider times out", async () => {
    const slow = makeBundle("slow", "Slow", {
      posts: {
        getSearchPosts: () => new Promise<Post[]>(() => undefined),
      },
    });
    const fast = movieProvider({
      value: "fast",
      display: "Fast",
      url: "https://fast.test/1080.mp4",
      quality: "1080p",
    });
    const { registry } = makeRegistry([slow, fast]);
    const pipeline = new StreamPipeline({
      config: testConfig(),
      logger: testLogger(),
      registry,
      cinemeta: makeCinemeta(movieMeta),
    });

    const streams = await pipeline.handle({ type: "movie", imdbId: "tt0111161" });
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toBe("https://fast.test/1080.mp4");
  });

  it("skips providers that throw and providers with no results", async () => {
    const broken = makeBundle("broken", "Broken", {
      posts: {
        getSearchPosts: async () => {
          throw new Error("provider exploded");
        },
      },
    });
    const empty = makeBundle("empty", "Empty", {
      posts: { getSearchPosts: async () => [] },
    });
    const fast = movieProvider({
      value: "fast",
      url: "https://fast.test/opening.mp4",
      quality: "720p",
    });
    const { registry } = makeRegistry([broken, empty, fast]);
    const pipeline = new StreamPipeline({
      config: testConfig(),
      logger: testLogger(),
      registry,
      cinemeta: makeCinemeta(movieMeta),
    });

    const streams = await pipeline.handle({ type: "movie", imdbId: "tt0111161" });
    expect(streams.map((stream) => stream.url)).toEqual([
      "https://fast.test/opening.mp4",
    ]);
  });

  it("returns an empty list when no providers are active", async () => {
    const { registry, release } = makeRegistry([]);
    const pipeline = new StreamPipeline({
      config: testConfig(),
      logger: testLogger(),
      registry,
      cinemeta: makeCinemeta(movieMeta),
    });
    await expect(
      pipeline.handle({ type: "movie", imdbId: "tt0111161" }),
    ).resolves.toEqual([]);
    expect(release).toHaveBeenCalled();
  });
});

describe("StreamPipeline latency guards", () => {
  function hangingProvider(): ProviderBundle {
    return makeBundle("hang", "Hang", {
      posts: {
        getSearchPosts: () => new Promise<Post[]>(() => undefined),
      },
    });
  }

  it("finishes once collected streams settle", async () => {
    const fast = movieProvider({
      value: "fast",
      display: "Fast",
      url: "https://fast.test/1080.mp4",
      quality: "1080p",
    });
    const { registry } = makeRegistry([hangingProvider(), fast]);
    const pipeline = new StreamPipeline({
      config: testConfig({
        settleMs: 100,
        emptyFenceMs: 0,
        searchTimeoutMs: 5000,
        globalDeadlineMs: 5000,
      }),
      logger: testLogger(),
      registry,
      cinemeta: makeCinemeta(movieMeta),
    });

    const startedAt = Date.now();
    const streams = await pipeline.handle({ type: "movie", imdbId: "tt0111161" });
    expect(streams.map((stream) => stream.url)).toEqual(["https://fast.test/1080.mp4"]);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it("returns an empty list at the empty fence when nothing was collected", async () => {
    const { registry } = makeRegistry([hangingProvider()]);
    const pipeline = new StreamPipeline({
      config: testConfig({
        settleMs: 0,
        emptyFenceMs: 100,
        searchTimeoutMs: 5000,
        globalDeadlineMs: 5000,
      }),
      logger: testLogger(),
      registry,
      cinemeta: makeCinemeta(movieMeta),
    });

    const startedAt = Date.now();
    await expect(
      pipeline.handle({ type: "movie", imdbId: "tt0111161" }),
    ).resolves.toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it("falls back to the global deadline when both guards are disabled", async () => {
    const { registry } = makeRegistry([hangingProvider()]);
    const pipeline = new StreamPipeline({
      config: testConfig({
        settleMs: 0,
        emptyFenceMs: 0,
        searchTimeoutMs: 5000,
        globalDeadlineMs: 400,
      }),
      logger: testLogger(),
      registry,
      cinemeta: makeCinemeta(movieMeta),
    });

    const startedAt = Date.now();
    await expect(
      pipeline.handle({ type: "movie", imdbId: "tt0111161" }),
    ).resolves.toEqual([]);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("StreamPipeline limits, cache and validation", () => {
  it("caps per-provider streams and the total stream list", async () => {
    const single = movieProvider({
      value: "cap",
      url: "https://api.test/cap",
      stream: {
        getStream: async () =>
          Array.from({ length: 30 }, (_, index) => ({
            server: `Server ${index}`,
            link: `https://cap.test/${index}.mp4`,
            quality: "1080p",
          })),
      },
    });
    const singleRegistry = makeRegistry([single]);
    const singlePipeline = new StreamPipeline({
      config: testConfig(),
      logger: testLogger(),
      registry: singleRegistry.registry,
      cinemeta: makeCinemeta(movieMeta),
    });
    await expect(
      singlePipeline.handle({ type: "movie", imdbId: "tt0111161" }),
    ).resolves.toHaveLength(20);

    const providers = Array.from({ length: 11 }, (_, index) =>
      movieProvider({
        value: `p${index}`,
        url: `https://api.test/p${index}`,
        stream: {
          getStream: async () =>
            Array.from({ length: 25 }, (_, streamIndex) => ({
              server: `Server ${streamIndex}`,
              link: `https://p${index}.test/${streamIndex}.mp4`,
              quality: "1080p",
            })),
        },
      }),
    );
    const allRegistry = makeRegistry(providers);
    const allPipeline = new StreamPipeline({
      config: testConfig({ searchConcurrency: 8 }),
      logger: testLogger(),
      registry: allRegistry.registry,
      cinemeta: makeCinemeta(movieMeta),
    });
    await expect(
      allPipeline.handle({ type: "movie", imdbId: "tt0111161" }),
    ).resolves.toHaveLength(200);
  });

  it("caches streams until provider activation clears caches", async () => {
    const getSearchPosts = vi.fn(async () => [
      { title: "The Shawshank Redemption 1994", link: "https://cache.test/post" },
    ]);
    const getStream = vi.fn(async () => [
      { server: "Cache", link: "https://cache.test/1080.mp4", quality: "1080p" },
    ]);
    const bundle = movieProvider({
      value: "cache",
      url: "https://cache.test/page",
      stream: { getStream },
    });
    bundle.modules.posts = { getSearchPosts };
    const { registry, activate } = makeRegistry([bundle]);
    const pipeline = new StreamPipeline({
      config: testConfig(),
      logger: testLogger(),
      registry,
      cinemeta: makeCinemeta(movieMeta),
    });

    await pipeline.handle({ type: "movie", imdbId: "tt0111161" });
    await pipeline.handle({ type: "movie", imdbId: "tt0111161" });
    expect(getSearchPosts).toHaveBeenCalledTimes(1);

    activate();
    await pipeline.handle({ type: "movie", imdbId: "tt0111161" });
    expect(getSearchPosts).toHaveBeenCalledTimes(2);
    pipeline.dispose();
  });

  it("rejects malformed requests without touching the registry", async () => {
    const provider = movieProvider({
      value: "valid",
      url: "https://valid.test/1080.mp4",
    });
    const { registry } = makeRegistry([provider]);
    const acquire = vi.spyOn(registry, "acquire");
    const pipeline = new StreamPipeline({
      config: testConfig(),
      logger: testLogger(),
      registry,
      cinemeta: makeCinemeta(movieMeta),
    });

    const invalid: StreamRequest[] = [
      { type: "channel" as StreamRequest["type"], imdbId: "tt0111161" },
      { type: "movie", imdbId: "not-an-imdb-id" },
      { type: "movie", imdbId: "tt0111161", season: 1 },
      { type: "series", imdbId: "tt0903747", season: -1 },
      { type: "series", imdbId: "tt0903747", season: 1, episode: 1.5 },
    ];
    for (const request of invalid) {
      await expect(pipeline.handle(request)).resolves.toEqual([]);
    }
    expect(acquire).not.toHaveBeenCalled();
  });
});
