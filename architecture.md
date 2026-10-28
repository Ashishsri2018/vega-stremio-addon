# Architecture

## Overview

Single-process Node 22/TypeScript service exposing a Stremio stream addon. Express handles the
HTTP surface; providers from `Zenda-Cross/vega-providers` are downloaded from GitHub, validated, and
executed in-process through a reimplemented provider SDK. There is no admin API and no sandbox.

```
Stremio client
   |  /manifest.json, /stream/:type/:id.json, /health, /proxy/:token
   v
Express app (src/addon/routes.ts)
   |-- StreamPipeline (src/pipeline/streamHandler.ts)
   |     |-- CinemetaClient (title/year/episodes, 6h cache)
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
adds Cinemeta, the pipeline, and the Express app; `src/cli/update.ts` reuses the same runtime and
updater code path for manual updates. The global fetch override is installed before any provider
module executes; internal HTTP (GitHub, Cinemeta, proxy) uses `nativeFetch` captured at module load
to avoid recursion.

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

1. Parse `tt` ID, type, and optional season/episode. Bad IDs return an empty stream list.
2. Fetch Cinemeta metadata (6h cache); derive search query variants.
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

Caches (search 10m, mapping 6h, streams 60s) are in-memory and cleared on activation.

## HTTP surface

`src/addon/routes.ts` adds permissive CORS, manifest, stream routes, health, optional proxy, JSON
404s. Stream/health responses are `no-store`; errors never leak stack traces or secrets. Health is
built from persisted state plus the active registry, with no settings values or URLs.

## Proxy

Tokens are base64url JSON (`u` target, `h` headers, `e` expiry) plus an HMAC-SHA256 signature.
The handler validates tokens, enforces HTTP(S) and DNS-based SSRF checks on every redirect, streams
range responses, rewrites HLS playlist URIs with per-segment tokens, and logs only host/path/status.

## Persistence

All JSON writes use temp file + fsync + rename. Provider modules are versioned by SHA path, so
updates never mutate code used by in-flight requests.
