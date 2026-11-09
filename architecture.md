# Architecture

## Overview

Single-process Node 22/TypeScript service exposing a Stremio stream addon. Express handles the
HTTP surface; providers from `Zenda-Cross/vega-providers` are downloaded from GitHub, validated, and
executed in-process through a reimplemented provider SDK. There is no admin API and no sandbox.

```
Stremio client
   |  /, /manifest.json, /stream/:type/:id.json, /subtitles/:type/:id.json, /health, /proxy/:token
   v
Express app (src/addon/routes.ts)
   |-- StreamPipeline (src/pipeline/streamHandler.ts)
   |     |-- CinemetaClient (title/year/episodes, 6h cache)
   |     |-- TmdbClient (optional, TMDB ID -> Cinemeta-shaped meta, 6h cache)
   |     |-- provider search -> candidate scoring -> meta verification
   |     |-- link resolution (movies, episodes, ranges, packs)
   |     `-- getStream -> Stremio mapping/sorting/filtering
   |-- ProviderRegistry (src/providers/registry.ts)
   |     `-- immutable ProviderSnapshot { sha, urls, bundles } + refcounted leases
   |-- Updater (src/providers/updater.ts)
   |     |-- SourceClient (GitHub HEAD/ETag + immutable raw downloads)
   |     |-- staging/download/header validation -> atomic rename
   |     |-- pending retry, lock file, schedule/backoff, state.json
   |     `-- SettingsManager (provider-settings.json, schema seeding, SIGHUP)
   |-- Provider SDK (src/providers/sdk/*)
   |     |-- HttpTransport (curl-cffi-node or native fetch fallback)
   |     |-- axios adapter + global fetch shim + urls.json snapshot interception
   |     |-- KvStore (/data/kv.json)
   |     `-- CookieJar (/data/cookies.json)
   `-- Optional signed media proxy (src/proxy/*)
```

## Runtime assembly

`src/runtime.ts` constructs the SDK, registry, settings, state, source, and updater. `src/index.ts`
adds Cinemeta, the pipeline, and the Express app; it also creates `TmdbClient` when `TMDB_API_KEY` is
set and passes it to the pipeline. `src/cli/update.ts` reuses the same runtime and updater code path
for manual updates. The global fetch override is installed before any provider module executes;
internal HTTP (GitHub, Cinemeta, TMDB, proxy) uses `nativeFetch` captured at module load to avoid
recursion.

## Provider snapshots and updates

- `state.json` is the restart source of truth. A complete on-disk snapshot is loaded without network.
- HEAD is resolved via the GitHub API with ETag; `PROVIDER_SHA` bypasses the API and pins a snapshot.
- If the API fails, the updater downloads branch content, derives a deterministic content hash, and
  validates headers; failures keep the current snapshot.
- Providers are downloaded into a staging directory, validated (size, header stamps, required
  modules, exports), fsynced, and renamed into `<sha>/`. Activation swaps one immutable snapshot
  pointer. Failed providers keep their previous bundle and are marked `pending` for retry.
- Each request holds a registry lease. Retired snapshots stay loaded until leases drain or a
  10-minute grace period ends; then their `require.cache` entries are purged. Disk keeps only the
  active and previous snapshot directories.

## Provider SDK

Provider bundles expect a `providerContext` with axios, cheerio, browser headers, KV, cookies, and
`openWebView`. Upstream's bundled context is unusable, so the addon reimplements it:

- One shared transport with Chrome impersonation when available, timeouts, size caps, per-host
  concurrency, decompression, redirects, cookie merge/capture, and native fetch fallback.
- axios custom adapter and a Response-compatible global fetch shim backed by that transport.
- Any fetch of upstream `urls.json` is served from the active snapshot (merging keys missing from a
  new snapshot) so provider base URLs cannot drift from installed code. The activation listener
  clears `globalThis.__vegaProviderBaseUrlCache__`.
- KV and cookies persist atomically with debounced writes and are flushed on shutdown.

## Stream pipeline

1. Parse the request ID: `tt<digits>` (IMDb) or, when TMDB is configured, `tmdb:<id>`, with optional
   season/episode for series. Bad IDs return an empty stream list.
2. Fetch metadata (6h cache): Cinemeta by IMDb ID, or TMDB movie/TV details (plus `external_ids`) for
   TMDB IDs. TMDB metadata is converted to the Cinemeta shape; the IMDb ID from TMDB is used for
   provider meta matching when present. TMDB requests without a configured client return empty
   without searching providers. Derive search query variants from the metadata.
3. Search providers concurrently with per-provider timeouts and a circuit breaker (3 failures in
   10 minutes opens it for 10 minutes).
4. Rank candidates by normalized title/year/type; verify up to 3 candidates per provider via
   `getMeta` (IMDb ID when present, otherwise strong title/year/type match).
5. Resolve direct links or episode links (`episodesLink` + episode range/pack matching with Cinemeta
   episode-name fallback).
6. Resolve streams with per-provider timeouts, 3 concurrent calls per provider, 40 calls per request.
7. Map to Stremio streams: safe headers only, normalized subtitles, deduplicated URLs, magnet and
   placeholder filtering, quality/direct-first sorting, 20 per provider and 200 total.
8. A global deadline returns partial results; abandoned provider promises are aborted and cannot
   hold the response open.

Caches (search 10m, mapping 6h, complete streams 60s, truncated/empty streams 30s) are
in-memory and cleared on activation. Stream and mapping cache keys use a `contentId`
(`tt...` or `tmdb:...`), so IMDb and TMDB requests for the same title do not collide; provider meta
matching prefers IMDb IDs and falls back to title/year/type when TMDB has no IMDb ID.

## User filters

Per-user filters are encoded as a base64url JSON segment in the URL (`/<config>/...`) and parsed in
`src/addon/userConfig.ts`; invalid segments fall back to unfiltered defaults. Filtering runs after
the pipeline returns, so cached stream lists stay shared across configs.

- `maxRes` / `minRes`: resolution inferred from quality tags, titles, binge groups, and URLs.
- `maxSizeMB`: file size parsed heuristically from human-readable values in stream titles
  (`656 MB`, `1.29 GB`); speeds such as `1.5 MB/s` are ignored. No per-stream HEAD requests.
- `subtitleLangs`: keeps only matching subtitle tracks; region variants such as `pt-BR` match `pt`.
  Streams are retained without subtitles when nothing matches.
- `includeUnknown` / `includeUnknownSize`: unknown-resolution and unknown-size streams are kept by
  default and can be excluded explicitly.

The `/configure` page builds these URLs in the browser; no filter state is stored server-side.

## HTTP surface

`src/addon/routes.ts` adds permissive CORS, a root info JSON, manifest, stream routes, subtitle
routes, health, optional proxy, JSON 404s, and the HTML `/configure` page. The manifest advertises
`idPrefixes: ["tt", "tmdb:"]` only when `TMDB_API_KEY` is configured; otherwise it stays `["tt"]`.
Express answers `HEAD` on every GET route without a body. Root/stream/subtitle/health responses are
`no-store`; errors never leak stack traces or secrets. Health is built from persisted state plus the
active registry, with no settings values or URLs.

Subtitle routes: `GET /subtitles/:type/:path*` and `GET /:config/subtitles/:type/:path*`. The
`path*` capture holds `<id>.json` plus Stremio's optional extras segment, which `parseStreamId`
ignores. The handler shares the stream rate limiter, `HEAD`, and always-200 semantics, calls
`StreamPipeline.collectSubtitles()` (which reuses `handle()`, so it hits the stream cache or joins the
in-flight fan-out), and applies only the config segment's `subtitleLangs`. Track URLs are returned
directly; the media proxy is not applied to subtitle routes. `StreamHandlerApi.collectSubtitles` is
optional so test doubles and alternate pipelines degrade to `{"subtitles":[]}`.

## Proxy

Tokens are base64url JSON (`u` target, `h` headers, `e` expiry) plus an HMAC-SHA256 signature.
The handler validates tokens, enforces HTTP(S) and DNS-based SSRF checks on every redirect, streams
range responses, rewrites HLS playlist URIs with per-segment tokens, and logs only host/path/status.

## Deployment

The `Dockerfile` and entrypoint run on Beamup (the active deployment) and rely on the entrypoint
briefly starting as root to fix `/data` ownership before dropping to `node`. The production app
name and URL are private and intentionally not recorded here; they live only in the
`BEAMUP_REMOTE` repository secret.

- **Beamup (active):** Stremio's Dokku/swarm PaaS. `beamup-cli` creates an SSH remote
  `dokku@a.baby-beamup.club:<hash>/<project>` and deploys via a force-push to `master`. For a
  Dockerfile app the project name must contain `docker`; Beamup selects the swarm service command
  from that name. Without it, the service runs `/start web` and the container exits with
  `exec: "/start": stat /start: no such file or directory`. Pre-flight `beamup-lint` validates the
  new container; an app that exits at startup (for example, env values outside the zod bounds in
  `src/config.ts`) is rejected as "not a valid Stremio addon" and the old container keeps serving.
- **Deployment automation:** Pushes to `main` run the GitHub Actions workflow; after `verify` and
  `docker` succeed, the `deploy-beamup` job force-pushes to Beamup using the required
  `BEAMUP_REMOTE` secret and `BEAMUP_SSH_PRIVATE_KEY` (plus optional `BEAMUP_KNOWN_HOSTS`). The job
  masks the remote and app name in logs. Non-secret settings are committed in `deploy/beamup.env`,
  copied into the image, and sourced at container start, so they survive app deletion and recreation.
  CI then applies `BEAMUP_EXTRA_ENV` secrets with `scripts/apply-beamup-env.sh`, one changed key at a
  time because Beamup accepts only one `KEY=value` per `config:set`.
- **Beamup runtime:** 1.2 CPU / 1 GB RAM per service, restart at most 10 times per 5 minutes with a
  60 s delay, 400 apps per swarm, and 20 addons per GitHub user. No persistent volume is mounted,
  so `/data` is container-local and is lost when the container is recreated (redeploy). The server
  binds only after bootstrap (snapshot download, capped at 60 s), so cold requests may be sparse or
  504.
- **Edge proxy:** Beamup's nginx is configured to cache `200`/`302` for 2 h (subject to response
  cache headers), enables `proxy_cache_lock`, and serves stale responses on upstream errors.
  `/stream` and `/health` are `no-store`; cached responses mostly affect manifest and configure
  routes. Warm stream responses are still larger because the addon's in-memory caches and upstream
  providers have warmed up. The gateway also cuts long upstream requests: 504s were observed at
  17-19 s wall time with a 20 s global deadline, so `deploy/beamup.env` keeps
  `GLOBAL_DEADLINE_MS=10000`; per-provider budgets above that are clamped to the remaining budget.
- **Updates:** the 4-6 h schedule uses 0-120 s jitter. `UPDATE_ON_START=true` causes a fresh Beamup
  container to bootstrap immediately because there is no snapshot on disk.
- **Policy:** Beamup publishes no AUP. Enforcement is manual and report-driven via a ban list keyed
  to the hashed GitHub username; the SSH key is removed and further deploy/config/log/delete
  commands are blocked. This addon aggregates third-party streaming links, so Beamup carries
  copyright/platform risk.

## Persistence

All JSON writes use temp file + fsync + rename. Provider modules are versioned by SHA path, so
updates never mutate code used by in-flight requests.
