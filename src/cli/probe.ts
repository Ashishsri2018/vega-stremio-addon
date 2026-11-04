import { loadConfig } from "../config.js";
import { Logger } from "../logger.js";
import { isSeasonPack, matchesEpisode } from "../pipeline/episodes.js";
import { rankCandidates } from "../pipeline/match.js";
import { createRuntime } from "../runtime.js";
import type {
  LinkListEntry,
  MediaType,
  Post,
  ProviderBundle,
  ProviderContextLike,
  ProviderMeta,
} from "../types.js";
import { mapLimit, withTimeout } from "../util/concurrency.js";

const MAX_CANDIDATES = 3;
const MAX_LINKS = 10;
const STREAM_CONCURRENCY = 3;

const USAGE = `Usage: npm run probe -- [options] <search query...>

Calls each provider's getSearchPosts(), then resolves metadata and stream
links (unless --search-only) and reports the outcome per provider.

Options:
  --search-only        stop after getSearchPosts()
  --type movie|series  stream type used for probing (default movie)
  --season N           season for series probing (default 1)
  --episode N          episode for series probing
  --json               print machine-readable JSON instead of a table
  --help               show this help

Environment:
  DATA_DIR             state directory (default /data)
  SEARCH_CONCURRENCY   parallel providers (default 16)
  SEARCH_TIMEOUT_MS    per-provider search timeout (default 10000)
  META_TIMEOUT_MS      per-provider meta/episodes timeout (default 15000)
  STREAM_TIMEOUT_MS    per-provider stream timeout (default 20000)
  LOG_LEVEL            provider/runtime log level (default info)

Examples:
  npm run probe -- Inception
  npm run probe -- --search-only Inception
  npm run probe -- --type series --season 1 --episode 2 "Breaking Bad"
  npm run --silent probe -- --json "The Last of Us"`;

interface CliArgs {
  query: string | null;
  json: boolean;
  help: boolean;
  searchOnly: boolean;
  type: MediaType;
  season: number;
  episode?: number;
}

type ProbeStage = "search" | "meta" | "episodes" | "stream";

interface ProbeResult {
  provider: string;
  displayName: string;
  disabled: boolean;
  status: "ok" | "empty" | "no-streams" | "error";
  posts: number;
  links: number;
  streams: number;
  stage: ProbeStage | null;
  durationMs: number;
  error?: string;
}

interface Summary {
  total: number;
  ok: number;
  empty: number;
  noStreams: number;
  error: number;
}

interface ProbeOptions {
  query: string;
  type: MediaType;
  season: number;
  episode?: number;
  searchOnly: boolean;
  searchTimeoutMs: number;
  metaTimeoutMs: number;
  streamTimeoutMs: number;
}

interface ResolvedLink {
  link: string;
}

interface LinkResolution {
  links: ResolvedLink[];
  episodeError: string | null;
}

const SERIES_LINK_TYPES = ["series", "episode", "tv", "show"];

function parseNonNegativeInt(
  value: string | undefined,
  flag: string,
  max: number,
): number {
  if (value === undefined) throw new Error(`${flag} requires a value`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`${flag} must be an integer between 0 and ${max}`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let json = false;
  let help = false;
  let searchOnly = false;
  let type: MediaType = "movie";
  let season = 1;
  let episode: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--search-only") {
      searchOnly = true;
    } else if (arg === "--type") {
      index += 1;
      const value = argv[index];
      if (value !== "movie" && value !== "series") {
        throw new Error("--type must be movie or series");
      }
      type = value;
    } else if (arg === "--season") {
      index += 1;
      season = parseNonNegativeInt(argv[index], "--season", 1000);
    } else if (arg === "--episode") {
      index += 1;
      episode = parseNonNegativeInt(argv[index], "--episode", 10000);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return {
    query: positional.join(" ").trim() || null,
    json,
    help,
    searchOnly,
    type,
    season,
    episode,
  };
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isValidPost(value: unknown): value is Post {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Post).title === "string" &&
    typeof (value as Post).link === "string" &&
    (value as Post).link.trim().length > 0
  );
}

function isValidStream(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const link = (value as Record<string, unknown>).link;
  return typeof link === "string" && link.trim().length > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redirectProviderConsole(): void {
  const toStderr = console.error.bind(console);
  console.log = (...args: unknown[]) => toStderr(...args);
  console.info = (...args: unknown[]) => toStderr(...args);
  console.debug = (...args: unknown[]) => toStderr(...args);
  console.dir = (...args: unknown[]) => toStderr(...args);
}

async function invokeProvider<T>(
  label: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T> | T,
): Promise<T> {
  const controller = new AbortController();
  try {
    return await withTimeout(
      Promise.resolve().then(() => fn(controller.signal)),
      timeoutMs,
      label,
    );
  } finally {
    controller.abort();
  }
}

function hasLinkList(meta: ProviderMeta): boolean {
  if (!Array.isArray(meta.linkList)) return false;
  return meta.linkList.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    if (trimString(entry.episodesLink)) return true;
    return (
      Array.isArray(entry.directLinks) &&
      entry.directLinks.some((direct) => trimString(direct?.link).length > 0)
    );
  });
}

function addDirectLinks(
  target: ResolvedLink[],
  seen: Set<string>,
  entry: LinkListEntry,
  allowedTypes: string[],
): void {
  for (const direct of Array.isArray(entry.directLinks) ? entry.directLinks : []) {
    if (!direct || typeof direct !== "object") continue;
    const link = trimString(direct.link);
    if (!link || seen.has(link)) continue;
    const linkType = trimString(direct.type).toLowerCase();
    if (linkType && !allowedTypes.includes(linkType)) continue;
    seen.add(link);
    target.push({ link });
  }
}

async function collectLinks(
  bundle: ProviderBundle,
  meta: ProviderMeta,
  options: ProbeOptions,
  providerContext: ProviderContextLike,
): Promise<LinkResolution> {
  const provider = bundle.entry.value;
  const entries = Array.isArray(meta.linkList) ? meta.linkList : [];

  if (options.type === "movie") {
    const links: ResolvedLink[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      addDirectLinks(links, seen, entry, ["movie"]);
    }
    return { links: links.slice(0, MAX_LINKS), episodeError: null };
  }

  const specific: ResolvedLink[] = [];
  const pack: ResolvedLink[] = [];
  const seenSpecific = new Set<string>();
  const seenPack = new Set<string>();
  const episodeJobs: string[] = [];
  const jobUrls = new Set<string>();
  let episodeError: string | null = null;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const title = trimString(entry.title);
    const unknownTitle = title.length === 0;
    const specificMatch = unknownTitle
      ? options.episode === undefined
      : matchesEpisode(title, options.season, options.episode, null);
    const packMatch = unknownTitle || isSeasonPack(title, options.season);

    if (specificMatch) {
      addDirectLinks(specific, seenSpecific, entry, SERIES_LINK_TYPES);
    } else if (packMatch) {
      addDirectLinks(pack, seenPack, entry, SERIES_LINK_TYPES);
    }

    const episodesLink = trimString(entry.episodesLink);
    if (
      episodesLink &&
      bundle.modules.episodes &&
      !jobUrls.has(episodesLink) &&
      (specificMatch || packMatch || options.episode === undefined)
    ) {
      jobUrls.add(episodesLink);
      episodeJobs.push(episodesLink);
    }
  }

  for (const url of episodeJobs) {
    try {
      const raw: unknown = await invokeProvider(
        `${provider} episodes`,
        options.metaTimeoutMs,
        () =>
          bundle.modules.episodes!.getEpisodes({
            url,
            providerContext,
          }),
      );
      if (!Array.isArray(raw)) continue;
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const title = trimString(item.title);
        const link = trimString(item.link);
        if (!title || !link || seenSpecific.has(link)) continue;
        if (!matchesEpisode(title, options.season, options.episode, null)) continue;
        seenSpecific.add(link);
        specific.push({ link });
      }
    } catch (error) {
      episodeError ??= errorMessage(error);
    }
  }

  let links = specific;
  if (options.episode === undefined) {
    const seen = new Set(specific.map((entry) => entry.link));
    links = [...specific];
    for (const entry of pack) {
      if (seen.has(entry.link)) continue;
      seen.add(entry.link);
      links.push(entry);
    }
  } else if (specific.length === 0) {
    links = pack;
  }

  return { links: links.slice(0, MAX_LINKS), episodeError };
}

function searchOnlyResult(
  bundle: ProviderBundle,
  disabled: boolean,
  posts: number,
  startedAt: number,
): ProbeResult {
  return {
    provider: bundle.entry.value,
    displayName: bundle.entry.display_name,
    disabled,
    status: posts > 0 ? "ok" : "empty",
    posts,
    links: 0,
    streams: 0,
    stage: null,
    durationMs: Date.now() - startedAt,
  };
}

async function probeProvider(
  bundle: ProviderBundle,
  options: ProbeOptions,
  providerContext: ProviderContextLike,
  disabled: boolean,
): Promise<ProbeResult> {
  const provider = bundle.entry.value;
  const startedAt = Date.now();
  const result = (
    status: ProbeResult["status"],
    fields: Partial<ProbeResult> = {},
  ): ProbeResult => ({
    provider,
    displayName: bundle.entry.display_name,
    disabled,
    status,
    posts: 0,
    links: 0,
    streams: 0,
    stage: null,
    durationMs: Date.now() - startedAt,
    ...fields,
  });

  try {
    const rawPosts: unknown = await invokeProvider(
      `${provider} search`,
      options.searchTimeoutMs,
      (signal) =>
        bundle.modules.posts.getSearchPosts({
          searchQuery: options.query,
          page: 1,
          providerValue: provider,
          signal,
          providerContext,
        }),
    );
    if (!Array.isArray(rawPosts)) {
      return result("error", {
        stage: "search",
        error: "getSearchPosts() did not return an array",
      });
    }

    const posts = rawPosts.filter(isValidPost);
    if (posts.length === 0) {
      return result("empty");
    }
    if (options.searchOnly) {
      return searchOnlyResult(bundle, disabled, posts.length, startedAt);
    }

    const ranked = rankCandidates(
      posts,
      { title: options.query, type: options.type },
      MAX_CANDIDATES,
    );
    if (ranked.length === 0) {
      return result("no-streams", {
        posts: posts.length,
        stage: "search",
        error: "no search result matched the query",
      });
    }

    let meta: ProviderMeta | null = null;
    let metaError: string | null = null;
    for (const candidate of ranked) {
      try {
        const candidateMeta = await invokeProvider(
          `${provider} meta`,
          options.metaTimeoutMs,
          () =>
            bundle.modules.meta.getMeta({
              link: candidate.post.link,
              providerContext,
            }),
        );
        if (!meta) meta = candidateMeta;
        if (hasLinkList(candidateMeta)) {
          meta = candidateMeta;
          break;
        }
      } catch (error) {
        metaError = errorMessage(error);
      }
    }

    if (!meta) {
      return result("error", {
        posts: posts.length,
        stage: "meta",
        error: metaError ?? "getMeta() returned no usable metadata",
      });
    }

    const resolution = await collectLinks(bundle, meta, options, providerContext);
    if (resolution.links.length === 0) {
      return result("no-streams", {
        posts: posts.length,
        stage: resolution.episodeError ? "episodes" : "meta",
        error:
          resolution.episodeError ??
          "metadata returned no matching links for the requested type/season",
      });
    }

    const streamErrors: string[] = [];
    const streamCounts = await mapLimit(
      resolution.links,
      STREAM_CONCURRENCY,
      async (item): Promise<number> => {
        try {
          const rawStreams: unknown = await invokeProvider(
            `${provider} stream`,
            options.streamTimeoutMs,
            (signal) =>
              bundle.modules.stream.getStream({
                link: item.link,
                type: options.type,
                signal,
                providerContext,
                isDownload: false,
              }),
          );
          return Array.isArray(rawStreams)
            ? rawStreams.filter(isValidStream).length
            : 0;
        } catch (error) {
          streamErrors.push(errorMessage(error));
          return 0;
        }
      },
    );
    const streams = streamCounts.reduce((total, count) => total + count, 0);

    if (streams === 0) {
      return result("no-streams", {
        posts: posts.length,
        links: resolution.links.length,
        stage: "stream",
        error:
          streamErrors[0] ??
          `no streams returned by ${resolution.links.length} link(s)`,
      });
    }

    return result("ok", {
      posts: posts.length,
      links: resolution.links.length,
      streams,
    });
  } catch (error) {
    return result("error", { stage: "search", error: errorMessage(error) });
  }
}

function summarize(results: ProbeResult[]): Summary {
  const summary: Summary = {
    total: results.length,
    ok: 0,
    empty: 0,
    noStreams: 0,
    error: 0,
  };
  for (const result of results) {
    if (result.status === "no-streams") summary.noStreams += 1;
    else summary[result.status] += 1;
  }
  return summary;
}

function printTable(
  results: ProbeResult[],
  args: CliArgs,
  sha: string,
  summary: Summary,
  durationMs: number,
): void {
  const widths = {
    provider: Math.max("Provider".length, ...results.map((r) => r.provider.length)),
    result: Math.max("Result".length, ...results.map((r) => r.status.length)),
    posts: "Posts".length,
    links: "Links".length,
    streams: "Streams".length,
    time: "Time".length,
  };
  const row = (
    provider: string,
    result: string,
    posts: string,
    links: string,
    streams: string,
    time: string,
    detail: string,
  ): string =>
    `${provider.padEnd(widths.provider)}  ${result.padEnd(widths.result)}  ${posts.padStart(widths.posts)}  ${links.padStart(widths.links)}  ${streams.padStart(widths.streams)}  ${time.padStart(widths.time)}  ${detail}`;

  const target =
    args.type === "series"
      ? `${args.query}" type=series season=${args.season}${args.episode !== undefined ? ` episode=${args.episode}` : ""}`
      : `${args.query}" type=movie`;
  process.stdout.write(`Query: "${target}  snapshot: ${sha.slice(0, 12)}\n`);
  process.stdout.write(
    `${row("Provider", "Result", "Posts", "Links", "Streams", "Time", "Detail")}\n`,
  );
  for (const result of results) {
    const detail =
      result.status === "error" || result.status === "no-streams"
        ? (result.error ?? "failed")
        : result.disabled
          ? "disabled at stream time"
          : result.status === "empty"
            ? "no matching posts"
            : args.searchOnly
              ? "search only"
              : "-";
    process.stdout.write(
      `${row(
        result.provider,
        result.status,
        String(result.posts),
        String(result.links),
        String(result.streams),
        `${(result.durationMs / 1000).toFixed(1)}s`,
        detail,
      )}\n`,
    );
  }
  process.stdout.write(
    `Summary: ${summary.total} providers — ${summary.ok} ok, ${summary.empty} empty, ${summary.noStreams} no-streams, ${summary.error} error(s) in ${(durationMs / 1000).toFixed(1)}s\n`,
  );
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (!args.query) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const query = args.query;

  redirectProviderConsole();

  const config = loadConfig();
  const logger = new Logger({
    level: config.logLevel,
    write: (line) => process.stderr.write(`${line}\n`),
  });
  const runtime = await createRuntime(config, logger);

  try {
    const preloaded = await runtime.updater.preloadFromDisk();
    if (!preloaded) {
      logger.info("probe_no_local_snapshot", { dataDir: config.dataDir });
      await runtime.updater.runOnce("probe");
    }

    const snapshot = runtime.registry.getActiveSnapshot();
    if (!snapshot) {
      throw new Error(
        "no provider snapshot is available; run `npm run update` or `npm run probe` with network access",
      );
    }

    await runtime.settings
      .applySchemaDefaults(runtime.registry.listProviders(), runtime.context)
      .catch((error: unknown) => {
        logger.warn("provider_settings_seed_failed", {
          error: errorMessage(error),
        });
      });

    const options: ProbeOptions = {
      query,
      type: args.type,
      season: args.season,
      episode: args.episode,
      searchOnly: args.searchOnly,
      searchTimeoutMs: config.searchTimeoutMs,
      metaTimeoutMs: config.metaTimeoutMs,
      streamTimeoutMs: config.streamTimeoutMs,
    };
    const disabled = new Set(
      config.disabledProviders.map((value) => value.toLowerCase()),
    );
    const bundles = Array.from(snapshot.bundles.values());
    const startedAt = Date.now();
    const results = await mapLimit(
      bundles,
      config.searchConcurrency,
      (bundle) =>
        probeProvider(
          bundle,
          options,
          runtime.context,
          disabled.has(bundle.entry.value.toLowerCase()),
        ),
    );
    results.sort((a, b) => a.provider.localeCompare(b.provider));

    const durationMs = Date.now() - startedAt;
    const summary = summarize(results);

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            query,
            type: args.type,
            season: args.season,
            episode: args.episode ?? null,
            searchOnly: args.searchOnly,
            sha: snapshot.sha,
            timeouts: {
              searchMs: config.searchTimeoutMs,
              metaMs: config.metaTimeoutMs,
              streamMs: config.streamTimeoutMs,
            },
            summary,
            results,
            durationMs,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      printTable(results, args, snapshot.sha, summary, durationMs);
    }

    process.exitCode =
      summary.error > 0 || summary.noStreams > 0 ? 1 : 0;
  } finally {
    await runtime.dispose();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`probe failed: ${errorMessage(error)}\n`);
  process.exit(1);
});
