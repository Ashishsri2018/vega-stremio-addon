# Vega Providers to Stremio Addon - Detailed Implementation Plan

Status: implemented (see memory.md for verification log)
Target: `/root/iptv/vega-stremio-addon`
Upstream provider source: `Zenda-Cross/vega-providers`
Last updated: 2026-10-28

## 1. Goal

Build a self-hosted Node.js/Docker Stremio addon that:

- Uses all 39 enabled providers from `Zenda-Cross/vega-providers`.
- Serves streams only (`movie` and `series`), keyed by IMDb IDs (`tt...`).
- Runs the upstream provider JavaScript in the container.
- Checks upstream every 4-6 hours and hot-swaps provider code without a restart.
- Returns direct links with required HTTP headers, plus an optional signed proxy.
- Starts with no bundled provider snapshot; the first start downloads from GitHub.
- Has no HTTP admin API. Only the addon routes and `/health` are exposed.

## 2. Locked Decisions

| Decision | Choice |
|---|---|
| Hosting | Self-hosted Node 22 + Docker |
| Provider scope | All 39 enabled providers |
| Addon scope | Streams only, IMDb IDs only |
| Provider updates | Check upstream SHA every 4-6h; on change, re-download all enabled providers |
| Provider execution | In-process (no worker/QuickJS sandbox) |
| First start | Fetch-only (no baseline snapshot in image) |
| Admin HTTP API | None |
| Provider settings | Mounted `/data/provider-settings.json` |
| Torrent magnets | Filtered by default; `INCLUDE_MAGNETS=true` re-enables |
| Skip timings | Disabled by default (`*_skipTimings=false`) |
| Stable addon | Addon manifest version stays stable across provider updates |
| Runtime | Node.js 22, TypeScript |
| HTTP server | Express |
| Tests | Vitest |

## 3. Upstream Research Findings

### 3.1 Repository layout

- `manifest.json` - 63 provider entries, 39 with `disabled: false`.
- `urls.json` - provider base URLs, fetched at runtime by provider bundles.
- `providers/` - TypeScript source.
- `dist/` - committed, bundled CommonJS provider modules. Upstream does not rebuild `dist/` in CI; source and dist are committed together.
- `tests/` - upstream test harness and provider tests.

Immutable snapshot URLs to use:

```
https://raw.githubusercontent.com/Zenda-Cross/vega-providers/<sha>/manifest.json
https://raw.githubusercontent.com/Zenda-Cross/vega-providers/<sha>/urls.json
https://raw.githubusercontent.com/Zenda-Cross/vega-providers/<sha>/dist/<provider>/<module>.js
```

Do not use `refs/heads/main` as the source of truth for installation. Resolve the HEAD SHA through the GitHub API, then download from that SHA. Fall back to `refs/heads/main` with cache-busting only if the API is unavailable.

### 3.2 Provider manifest

Observed manifest fields:

```
display_name, value, version, icon, type, disabled, hasSettings
```

There is no `path` field in the current manifest. Support an optional `path` anyway for future compatibility.

### 3.3 Enabled providers (39)

```
vega, autoEmbed, drive, 4khdhub, 1cinevood, world4u, katmovies, mod, uhd,
movieBoxWeb, gokuHD, dramacool, eonMovies, movies4u, kmMovies, zeefliz,
netflixMirror, primeMirror, disneyMirror, hdhub4u, moviezwap, showbox, kissKh,
luxMovies, topmovies, torrentio, anikoto, kickAssAnime, animesub, everything,
castle, animesalt, animeworld, movielinkdb, mxplayer, youtube, kartoons,
1flex, internetArchive
```

### 3.4 Provider module contract

All 62 dist providers export `posts`, `meta`, `stream`. Optional modules:

- `episodes.js` for 36 providers.
- `settings.js` for 32 providers.
- `catalog.js` and `genres.js` exist but are not needed for a stream-only addon.

Actual exported runtime functions (not the newer `Get*` TypeScript interface names):

```js
getSearchPosts({ searchQuery, page, providerValue, signal, providerContext })
getPosts({ filter, page, providerValue, signal, providerContext })
getMeta({ link, providerContext })
getEpisodes({ url, providerContext })          // optional
getStream({ link, type, signal, providerContext, isDownload })
getSettingsSchema({ providerContext })          // optional
```

`getMeta` returns:

```js
{
  title, image, poster, logo, synopsis, imdbId, type,
  linkList: [
    { title, quality, episodesLink },
    { title, directLinks: [{ title, link, type, description, image }] }
  ],
  ...
}
```

### 3.5 Module headers

Every enabled module file starts with:

```js
// @vega-provider <value>
// @vega-version <version>
```

All 207 enabled module files were observed to be stamped. Validate both headers against the manifest and reject mismatches or unstamped files.

### 3.6 External requirements of provider modules

- Provider bundles are CommonJS.
- They do not import npm packages directly.
- They use Node globals: `fetch`, `atob`, `btoa`, `Buffer`, `URL`, `URLSearchParams`, `TextDecoder`, `TextEncoder`, `crypto`, `process`.
- `autoEmbed/stream.js` is the only module that calls `require("crypto")` directly.
- Node 22 supplies all required globals, so in-process execution needs no shims beyond `providerContext`.

### 3.7 Provider context

Required fields:

```ts
{
  axios,             // adapter with TLS impersonation
  commonHeaders,     // default browser headers
  cheerio,
  openWebView,       // throws WAF_REQUIRED in the container
  kvStore,           // persistent provider settings/tokens
  getCookies         // existing cookie jar, optional
}
```

Observed usage across dist:

```
kvStore          220 references
axios            152 references
openWebView       61 references
commonHeaders     40 references
cheerio           32 references
getBaseUrl         9 references (in the root providerContext bundle, not provider modules)
```

### 3.8 Upstream `dist/providerContext.js` is not reusable

It bundles `curl-cffi-node` and resolves it with:

```js
var import_meta = {};
var require2 = createRequire(import_meta.url);
var cjsModule = require2("./index.js");
```

`import_meta.url` is undefined in the bundle, so the loader throws. Do not import this file. Reimplement a small provider context with the same transport behavior:

- `curl-cffi-node` with `impersonate: "chrome120"`, `verify: false`
- axios adapter
- global `fetch` override returning a Response-compatible object
- gzip/br/deflate decompression
- redirect support

### 3.9 Provider URL configuration

Provider bundles fetch:

```
https://raw.githubusercontent.com/Zenda-Cross/vega-providers/refs/heads/main/urls.json
```

They cache it on `globalThis.__vegaProviderBaseUrlCache__` for 1 hour. The addon must intercept that URL and return the active snapshot's `urls.json`, otherwise provider base URLs can drift from the installed code. Clear the cache on every provider activation.

### 3.10 Settings defaults and network cost

Most providers declare `*_skipTimings` with `defaultValue: true`. `getMeta` then calls TheIntroDB to enrich episodes with intro/outro timings. These calls are unnecessary for this addon and add latency. The container will seed all skip-timing keys to `false` unless the settings file explicitly enables them.

### 3.11 Torrentio

Without a debrid key, Torrentio returns magnet links:

```js
{ type: "torrent", link: "magnet:?xt=urn:btih:..." }
```

A direct-link addon cannot play those. Filter `magnet:` links and `type === "torrent"` unless `INCLUDE_MAGNETS=true`. With a debrid service/API key configured, Torrentio returns direct HTTP links that pass through normally.

### 3.12 Licensing

The upstream provider repository has no `LICENSE` file. `package.json` says `ISC`. `vega-org` repositories have inconsistent licensing. Self-hosting is fine; public image redistribution should be reviewed separately.

## 4. Addon Protocol Behavior

Manifest (`GET /manifest.json`):

```json
{
  "id": "community.vega.stremio",
  "version": "1.0.0",
  "name": "Vega Streams",
  "description": "Streams from Vega providers",
  "types": ["movie", "series"],
  "resources": ["stream"],
  "idPrefixes": ["tt"],
  "catalogs": [],
  "behaviorHints": { "configurable": false }
}
```

Routes:

```
GET /manifest.json
GET /stream/movie/tt0111161.json
GET /stream/series/tt0944947:1:1.json
GET /health
```

Behavior:

- Return `{ "streams": [] }` for unknown types, malformed IDs, or no results.
- Always return HTTP 200 with a valid JSON body on addon routes; errors are logged, not exposed as stack traces.
- Set permissive CORS for web-based Stremio clients.
- `Cache-Control: no-store` on `/stream`; `/health` also no-store.
- The addon manifest version does not change when providers update.

## 5. Architecture

```
Stremio / CloudStream
        |
        v
  Express addon (Node 22)
   |-- /manifest.json, /stream/..., /health
   |-- Provider registry (active bundles, hot swap)
   |-- Update manager (GitHub SHA, 4-6h)
   |-- In-process provider runtime
   |     |-- providerContext (axios/fetch/cheerio/kv/cookies)
   |     |-- loaded dist modules from /data/providers/<sha>/
   |     `-- URL snapshot interception
   |-- Stream pipeline
   |     |-- Cinemeta metadata
   |     |-- provider search/match/meta/episodes/stream
   |     `-- Stremio stream mapping
   `-- Optional signed media proxy
        |
        v
  /data/providers/...   /data/kv.json   /data/cookies.json
  /data/provider-settings.json (mounted)
```

## 6. Runtime Provider Updater

### 6.1 Source resolution

Every cycle:

1. `GET https://api.github.com/repos/Zenda-Cross/vega-providers/commits/main`
2. Send `If-None-Match` with the stored ETag.
3. Use optional `GITHUB_TOKEN` for higher rate limits.
4. If API/network fails, fall back to raw `refs/heads/main` plus cache-busting and header validation. Keep the current snapshot on failure.
5. If the HEAD SHA equals `activeSha`, do not re-download. Still retry any provider whose installed SHA differs from `activeSha`.

### 6.2 Download set

For each enabled provider, download only what the addon uses:

Required:

```
dist/<value>/posts.js
dist/<value>/meta.js
dist/<value>/stream.js
```

Optional (download if present in the manifest/source, tolerate 404):

```
dist/<value>/episodes.js
dist/<value>/settings.js
```

Do not download `catalog.js`, `genres.js`, assets, or provider source. Approximate size for the enabled set is 1.4 MB.

Also download:

```
manifest.json
urls.json
```

### 6.3 Validation

For every module file:

- Non-empty and smaller than 2 MB.
- Starts with `// @vega-provider <value>` matching the manifest `value`.
- Starts with `// @vega-version <version>` matching the manifest `version`.
- The provider's required module set is complete.
- Optional modules that return 404 are absent; any other HTTP failure is an error.
- After writing, `require()` the module once in a validation pass and check the expected exports:
  - `posts.js` -> `getSearchPosts`
  - `meta.js` -> `getMeta`
  - `stream.js` -> `getStream`
  - `episodes.js` -> `getEpisodes`
  - `settings.js` -> `getSettingsSchema`
- If validation fails, discard the staged provider set and keep the previous one.

### 6.4 Download mechanics

- Use the native `fetch` captured before the provider `fetch` override.
- Concurrency: 8.
- Per-file timeout: 15 seconds.
- One retry per file.
- Do not send cookies to raw.githubusercontent.com.
- Write into `/data/providers/<author>/<sha>.tmp/`.
- `fsync` files and directories, then atomic rename to `/data/providers/<author>/<sha>/`.
- Only after the whole provider set is staged, activate it.

### 6.5 Activation

1. Build a new in-memory bundle map for successful providers.
2. Swap the registry pointer atomically.
3. Clear:
   - search cache
   - mapping cache
   - stream cache
   - `globalThis.__vegaProviderBaseUrlCache__`
4. Keep the old registry alive for in-flight requests. Release it when its reference count reaches zero, or after a 10-minute grace period.
5. Delete `require.cache` entries for snapshots older than the previous SHA.
6. Keep the active and previous SHA directories. Delete older snapshots on the next successful update.

If a provider fails:

- Keep its previous bundle active.
- Record `status: "pending"` with the target SHA and error.
- Retry it on later cycles even if the upstream SHA is unchanged.
- Do not fail the whole update because one provider failed.

If the whole manifest/urls download fails:

- Keep the current snapshot active.
- Record the error and back off 15m, 30m, 1h, then return to the normal 4-6h cadence.

### 6.6 Schedule

- Check on startup, after the server starts, unless a valid snapshot is already loaded.
- Then every random 4-6 hours, with a few minutes of jitter.
- Never overlap runs. A run takes a lock.
- Before each run, compute and persist `nextCheck`.
- Manual update: `node dist/cli/update.js` inside the container. It uses the same lock and code path.

### 6.7 First start

- No provider snapshot is baked into the image.
- On empty `/data`, run the updater before serving `/stream`, with a 60-second cap.
- If the initial download fails, still bind the server:
  - `/manifest.json` and `/health` work.
  - `/stream` returns `{ "streams": [] }`.
  - The updater retries in the background.
- If `PROVIDER_SHA` is set, install that SHA (from disk if present, otherwise from GitHub) instead of HEAD.

### 6.8 Pinning and rollback without an admin API

- `PROVIDER_SHA=<sha>` pins the active snapshot across restarts.
- The previous SHA is kept on disk.
- Rollback = set `PROVIDER_SHA` to the previous SHA and restart, or run the CLI with `PROVIDER_SHA=<sha>`.
- No runtime rollback HTTP endpoint.

## 7. In-Process Provider Runtime

### 7.1 Loading

- Installed module paths include the SHA, so a new version is a new `require` path.
- Load modules lazily per provider, or eagerly at activation for the validation pass. The loaded module objects are kept in the registry.
- A top-level throw during `require` marks the provider update failed and keeps the old bundle.
- A runtime throw inside a provider function is caught by the pipeline and logged. It does not crash the process.
- Install `process.on("unhandledRejection")` and `process.on("uncaughtException")` handlers that log and keep serving. Treat repeated crashes as a provider failure via the circuit breaker.

### 7.2 Provider context construction

Construct once at startup and reuse:

```ts
{
  axios,            // configured instance
  commonHeaders: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  },
  cheerio,
  kvStore,
  getCookies: async (url) => cookieJar.getCookieHeader(url) split into a map,
  openWebView: async () => { throw new Error("WAF_REQUIRED: browser solver unavailable"); }
}
```

Additional behavior:

- Define `globalThis.providerGlobal = globalThis` for compatibility, but provider bundles fall back to `globalThis` anyway.
- The provider context is not recreated on provider updates; only module objects and the URL snapshot change.

### 7.3 HTTP transport

Global `fetch` override and axios adapter share one transport:

- `curl-cffi-node` when it loads successfully.
- Fallback to native fetch/axios with browser headers if the native module fails to load or throws.
- `impersonate: "chrome120"`, `verify: false` (matching upstream).
- Skip caller `accept-encoding`; decompress gzip/br/deflate with `zlib`.
- Follow redirects by default; expose final `url` in the Response shim.
- Response shim supports: `ok`, `status`, `statusText`, `url`, `headers.get/has`, `text()`, `json()`, `buffer()`, `arrayBuffer()`.
- Request timeout: default 15 seconds, overridable per call.
- Response size cap: 32 MB.
- Per-host concurrency cap: 6, to avoid hammering a single site.
- Honor `AbortSignal` on a best-effort basis; the hard timeout is the final guarantee.
- Do not forward cookies across unrelated domains. Use a per-domain jar.

### 7.4 URL snapshot interception

Intercept any request to:

```
https://raw.githubusercontent.com/Zenda-Cross/vega-providers/*/urls.json
```

Return the active snapshot's `urls.json` with `Content-Type: application/json`.

- If the new `urls.json` lacks a key present in the previous snapshot, merge the previous value as fallback.
- If the active snapshot has no `urls.json`, fall back to a live fetch.
- Clear `globalThis.__vegaProviderBaseUrlCache__` on activation so provider code re-reads the snapshot.

### 7.5 KV store

- In-memory `Map` loaded from `/data/kv.json` at startup.
- API: `get`, `set`, `delete`, `keys`, `clear`.
- `get` returns `undefined` for missing keys (matching the provider type).
- Debounced atomic writes (500 ms), temp file + rename.
- Flush on `SIGTERM`/`SIGINT`.
- Values are JSON-serializable. Reject non-serializable values with a clear error.
- Do not log values; some contain debrid API keys and tokens.

### 7.6 Cookie jar

- File-backed, JSON, in-memory cache.
- Keyed by domain and path where practical; at minimum by registrable domain.
- Capture `set-cookie` from curl-cffi/axios responses.
- Merge jar cookies into outgoing requests only when the provider did not set an explicit `Cookie` header. If it did, keep the provider's value and append jar cookies that are not already present.
- Cap per-domain cookies and total size; evict oldest.
- Persist debounced, flush on shutdown.
- `getCookies(url)` returns the current cookie map for the domain.

### 7.7 WAF / openWebView

- There is no browser in the container.
- `openWebView` throws `WAF_REQUIRED`.
- Providers that check for it will fail gracefully or propagate the error; the pipeline logs it and moves on.
- Optional: if the settings file supplies a `cf_clearance` cookie for a domain, the cookie jar will send it, which may unblock some sites.

## 8. Provider Settings

### 8.1 Mounted file

Optional file: `/data/provider-settings.json`.

```json
{
  "skipTimings": false,
  "kv": {
    "torrentio_debridService": "realdebrid",
    "torrentio_debridApiKey": "REPLACE_ME",
    "torrentio_customInstanceUrl": "https://torrentio.strem.fun",
    "febboxCookie": "REPLACE_ME",
    "netflixMirror_t_hash_t": "REPLACE_ME",
    "hdhub4u_skipTimings": false
  }
}
```

Rules:

- Loaded at startup.
- Reloaded on `SIGHUP` (no HTTP endpoint).
- `kv` keys are exact provider KV keys.
- `skipTimings: false` seeds all `*_skipTimings` keys and `autoEmbed_skipTimings` to `false`.
- A key explicitly present in `kv` wins over `skipTimings`.
- Unknown keys are logged as warnings; they are still stored so future providers can use them.
- Provider-written values (for example `gofile_account_token`) are preserved unless the file explicitly overrides them.
- If the file is malformed, keep the last good configuration and log an error.

### 8.2 Default settings seeding

On startup and after provider activation:

- For each provider with `settings.js`, call `getSettingsSchema({ providerContext })` in-process, wrapped in try/catch and a short timeout.
- Seed missing keys from `defaultValue`.
- Then apply the skip-timing override.
- Then apply `provider-settings.json`.
- Never overwrite an existing KV value with a schema default.

### 8.3 Useful settings

- Torrentio: debrid service/API key, custom instance URL, quality filter.
- Showbox: `febboxCookie`.
- Netflix/Prime/Disney mirrors: `t_hash_t`, `baseUrlOverride`.
- Animesub: manifest URL, debrid service/API key.
- Per-provider skip timings, when enabled intentionally.

## 9. Stream Pipeline

### 9.1 Request parsing

Accept:

```
/stream/movie/tt0111161.json
/stream/series/tt0944947:1:1.json
/stream/series/tt0944947:1.json     -> season pack, optional
```

Reject non-`tt` IDs, unsupported types, and malformed season/episode values with an empty stream list.

### 9.2 Cinemeta metadata

- Movie: `https://v3-cinemeta.strem.io/meta/movie/<id>.json`
- Series: `https://v3-cinemeta.strem.io/meta/series/<id>.json`

Use the response for title, year, type, episode list, and episode names.

- Cache in memory for 6 hours.
- Retry once on failure.
- If Cinemeta fails, still attempt provider searches using the IMDb ID and any available title from the request; if no title at all, return empty for most providers.
- Do not use provider-supplied `imdbId` values to override the requested ID.

### 9.3 Provider search

For each active provider:

```js
getSearchPosts({
  searchQuery,
  page: 1,
  providerValue: providerManifest.value,
  signal,
  providerContext
})
```

- Concurrency: 8.
- Per-provider timeout: 10 seconds.
- Search query candidates:
  1. `title`
  2. `title + " " + year`
  3. `title + " " + type`
- Stop trying variants once a provider returns results.
- Cache search results for 10 minutes per `(provider, query, type)`.
- Do not call `getPosts` as a fallback; every provider exports `getSearchPosts`.

### 9.4 Candidate matching

Score each post:

- Exact normalized title match: high.
- Title contains year: medium.
- Type hints in title (`series`, `season`, `S01`, `complete`): adjust by request type.
- Poster/image presence: small bonus.
- Reject candidates whose title clearly refers to a different year or a different medium when confidence is low.
- Take the top N (default 3) per provider.

Title normalization:

- Lowercase.
- Strip provider prefixes/suffixes like "Download", "Watch", quality tags, language tags.
- Collapse whitespace and punctuation.
- Normalize `&`/`and`, Roman numerals where safe.
- Keep the original title for display.

### 9.5 Metadata resolution

For each candidate:

```js
getMeta({ link: post.link, providerContext })
```

- Timeout: 15 seconds.
- Verify:
  - `imdbId` equals the requested ID when present, OR
  - normalized title and year match and the provider's `type` matches the request.
- Accept providers that cannot return an IMDb ID when title+year+type are strong.
- Cache `(provider, imdbId, type) -> { post, meta }` for 6 hours.
- On mismatch, try the next candidate.
- Cap attempts per provider: 3.

### 9.6 Link resolution

Movie:

- Flatten `meta.linkList[].directLinks[]`.
- Keep links whose `type` is missing or `movie`.
- Filter empty links.

Series:

- Prefer `linkList` entries matching the requested season/episode.
- For `episodesLink`, call:

```js
getEpisodes({ url: episodesLink, providerContext })
```

- Match episode titles containing `SxxExx`, `Season x Episode y`, or explicit episode numbers.
- Support ranges and packs:
  - `S01`, `Season 1`
  - `S01E01-E05`
  - `E01-E05`
  - `Complete`
- Use Cinemeta episode names as a fallback match signal.
- If only a season pack is available, include it with a title noting the pack.
- Timeout: 15 seconds.
- Cap resolved episode links per provider: 10.

### 9.7 Stream resolution

For each resolved link:

```js
getStream({
  link,
  type: "movie" | "series",
  signal,
  providerContext,
  isDownload: false
})
```

- Per-provider timeout: 20 seconds.
- Concurrency inside a provider is controlled by the provider; do not add more than 3 simultaneous stream calls for one provider.
- Cap total stream calls: 40 per request.
- A provider returning `[]` or throwing is skipped.
- If a provider fails 3 requests within 10 minutes, open a circuit breaker for that provider for 10 minutes. Reset on provider update.

### 9.8 Global deadline

- Overall request budget: 45 seconds.
- Return partial results when the deadline is reached.
- The HTTP server must not wait for abandoned provider promises; use `Promise.race`/`AbortController` and log late results at debug level only.
- Never let one provider's unresolved promise keep the response open.

### 9.9 Caching and invalidation

In-memory only:

- Cinemeta meta: 6h.
- Provider search: 10 min.
- Candidate/meta mapping: 6h.
- Resolved streams: 60s.
- All provider-derived caches are cleared on provider activation.

Do not cache media bytes in v1.

## 10. Stremio Stream Mapping

For each provider stream:

```js
{
  server, link, type, quality, tags, tag, subtitles, headers, skip
}
```

Map to Stremio:

```js
{
  name: providerDisplayName,
  title: [server, quality, size/tags].filter(Boolean).join(" \u2022 "),
  url: link,
  behaviorHints: {
    proxyHeaders: { request: headers }
  },
  subtitles: [
    { id, url, lang }
  ],
  bingeGroup: `${providerValue}-${quality || "auto"}`
}
```

Rules:

- Include `behaviorHints.proxyHeaders.request` only when headers exist.
- Copy only safe headers: `Referer`, `Origin`, `User-Agent`, `Cookie`, `Authorization`, and other provider-specific headers. Never forward hop-by-hop headers.
- Normalize subtitles:
  - `id`: `${provider}-${index}`
  - `url`: `uri`
  - `lang`: language code; if missing, `en`
- Filter:
  - empty or non-http(s) links
  - `magnet:` and `type === "torrent"` unless `INCLUDE_MAGNETS=true`
  - duplicate URLs
  - known placeholder hosts (`example.com`, `localhost`) unless configured
- Sort:
  1. Quality descending (2160, 1080, 720, 480, 360).
  2. Direct MP4/MKV before HLS/DASH when quality is equal.
  3. Server preference (configured order, optional).
- Per-provider cap: 20 streams.
- Total cap: 200 streams.
- Include `skip`? Stremio does not support it. Drop it.

## 11. Optional Media Proxy

Default: disabled (`PROXY_ENABLED=false`).

When enabled:

- `GET /proxy/<token>` where token is a base64url JSON payload plus HMAC-SHA256 signature.
- Payload: target URL, request headers, expiry (default 6 hours), optional response headers.
- `PROXY_SECRET` is required. Refuse to start the proxy without it.
- Stream URLs in the addon response become proxy URLs only when the stream has headers or the URL is known to require CORS bypass.
- Forward `Range`, `If-Range`, and return `206`/`Content-Range` correctly.
- HLS:
  - Detect `.m3u8` by URL or content type.
  - Rewrite segment, key, and variant URIs through the proxy.
  - Preserve absolute URLs and query strings.
- SSRF guard:
  - Allow only `http`/`https`.
  - Resolve DNS and reject private, loopback, link-local, and multicast ranges.
  - Re-check after redirects; cap redirects.
- Response size streaming; do not buffer entire media files.
- Do not log full URLs if they contain tokens; redact query strings.

## 12. Data Layout and Persistence

```
/data/
  providers/
    Zenda-Cross/
      state.json
      <sha>/
        manifest.json
        urls.json
        <provider>/
          posts.js
          meta.js
          stream.js
          episodes.js      (optional)
          settings.js      (optional)
  kv.json
  cookies.json
  provider-settings.json   (mounted, optional)
  update.lock
```

`state.json`:

```json
{
  "activeSha": "f6dcb...",
  "previousSha": "8ced9...",
  "lastCheck": "2026-10-27T13:00:00Z",
  "lastSuccess": "2026-10-27T13:00:05Z",
  "nextCheck": "2026-10-27T18:10:00Z",
  "providers": {
    "hdhub4u": {
      "sha": "f6dcb...",
      "version": "2.27",
      "installedAt": "2026-10-27T13:00:02Z",
      "status": "active",
      "error": null
    }
  }
}
```

Rules:

- All state writes are atomic (`write temp`, `fsync`, `rename`).
- `state.json` is the source of truth for the active snapshot on restart.
- If `activeSha` is set but files are missing/incomplete, re-bootstrap.
- If `PROVIDER_SHA` is set, it wins over `activeSha`.
- An incomplete temp directory is removed on startup.
- The previous SHA is retained for in-flight requests and manual rollback.

## 13. Configuration

Environment variables:

| Name | Default | Purpose |
|---|---|---|
| `PORT` | `7000` | HTTP port |
| `DATA_DIR` | `/data` | Persistent data |
| `PROVIDER_SOURCE` | `Zenda-Cross/vega-providers` | GitHub repo |
| `PROVIDER_BRANCH` | `main` | Branch used for HEAD resolution |
| `PROVIDER_SHA` | empty | Pin a snapshot |
| `GITHUB_TOKEN` | empty | Higher GitHub API limits |
| `UPDATE_ON_START` | `true` | Run updater after boot |
| `UPDATE_INTERVAL_MIN_HOURS` | `4` | Minimum interval |
| `UPDATE_INTERVAL_MAX_HOURS` | `6` | Maximum interval |
| `UPDATE_CONCURRENCY` | `8` | Provider download parallelism |
| `HTTP_TIMEOUT_MS` | `15000` | Default HTTP timeout |
| `SEARCH_CONCURRENCY` | `8` | Provider search parallelism |
| `SEARCH_TIMEOUT_MS` | `10000` | Per-provider search timeout |
| `META_TIMEOUT_MS` | `15000` | Per-provider meta/episodes timeout |
| `STREAM_TIMEOUT_MS` | `20000` | Per-provider stream timeout |
| `GLOBAL_DEADLINE_MS` | `45000` | Overall request budget |
| `INCLUDE_MAGNETS` | `false` | Return torrent magnets |
| `PROXY_ENABLED` | `false` | Enable media proxy |
| `PROXY_SECRET` | empty | HMAC secret for proxy |
| `PUBLIC_BASE_URL` | empty | Absolute URL for proxy links |
| `SETTINGS_FILE` | `/data/provider-settings.json` | Provider settings |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `CINEMETA_URL` | `https://v3-cinemeta.strem.io` | Metadata base |
| `KV_FLUSH_MS` | `500` | KV/cookie write debounce |
| `PROVIDER_CACHE_TTL_MS` | `21600000` | Search/mapping cache TTL |
| `STREAM_CACHE_TTL_MS` | `60000` | Stream cache TTL |

Notes:

- Validate configuration with `zod` at startup; fail fast on invalid values.
- Never log `PROXY_SECRET`, `GITHUB_TOKEN`, debrid keys, or cookies.
- `PUBLIC_BASE_URL` is required when the proxy is enabled and the addon is behind a reverse proxy.

## 14. Container and Operations

### 14.1 Dockerfile

- Base: `node:22-bookworm-slim` (glibc, for `curl-cffi-node` native binaries).
- Multi-stage:
  - build stage: `npm ci`, TypeScript build
  - runtime stage: production dependencies only, compiled `dist/`, non-root user
- `NODE_ENV=production`.
- `dumb-init` or `tini` as PID 1 for signal handling.
- `USER node`.
- Read-only root FS compatible:
  - `TMPDIR=/tmp` (tmpfs)
  - only `/data` writable
- `HEALTHCHECK` uses a small Node script hitting `http://127.0.0.1:${PORT}/health`.
- No provider snapshot and no upstream clone in the image.

### 14.2 docker-compose

```yaml
services:
  vega-addon:
    build: .
    ports:
      - "7000:7000"
    volumes:
      - ./data:/data
    environment:
      - PROVIDER_SOURCE=Zenda-Cross/vega-providers
      - UPDATE_INTERVAL_MIN_HOURS=4
      - UPDATE_INTERVAL_MAX_HOURS=6
      - INCLUDE_MAGNETS=false
      - PROXY_ENABLED=false
      - LOG_LEVEL=info
    restart: unless-stopped
    read_only: true
    tmpfs:
      - /tmp
    init: true
```

### 14.3 `/health`

Return:

```json
{
  "status": "ok",
  "activeSha": "f6dcb...",
  "providerCount": 39,
  "providers": {
    "hdhub4u": { "version": "2.27", "status": "active" }
  },
  "lastCheck": "...",
  "lastSuccess": "...",
  "nextCheck": "...",
  "pending": [],
  "lastError": null
}
```

- `status`: `ok`, `degraded` (some providers pending or no providers), or `error`.
- No secrets, cookies, URLs with tokens, or provider settings values.
- Publicly accessible; keep it minimal.

### 14.4 Logging

- Structured JSON lines by default, or compact text when `LOG_LEVEL=info`.
- Include: timestamp, level, event, provider, sha, duration.
- Exclude: settings values, cookies, API keys, full stream URLs with sensitive query strings.
- Log update summaries: providers updated, skipped, pending, deleted; bytes downloaded; duration.

## 15. Testing

### 15.1 Unit tests

- Config validation, interval jitter, ID parsing.
- Title normalization and candidate scoring.
- Episode matching (S/E, ranges, packs).
- Stream mapping, magnet filtering, header/subtitle mapping.
- Proxy token signing/verification and SSRF checks.

### 15.2 Fixture update tests

Create a local fixture source server with two SHAs:

- Initial install with a subset of providers.
- No-op when the SHA is unchanged.
- SHA change re-downloads all enabled providers.
- Version header mismatch rejected.
- Missing required module rejected.
- Partial provider failure keeps the old version and marks pending.
- Pending provider retried on the next cycle even with an unchanged SHA.
- New provider installed; removed provider retired.
- Pinned `PROVIDER_SHA` installs the requested snapshot.
- `urls.json` merge for missing keys.
- Atomic activation: no request ever sees a partial module set.

### 15.3 In-process runtime tests

- Versioned `require` paths.
- Hot swap while an in-flight request uses the old bundle.
- Top-level throw falls back to the old bundle.
- `require.cache` cleanup after the grace period.
- Global fetch URL interception.
- Cookie jar merge and persistence.
- KV store persistence and atomic writes.
- `skipTimings` seeding and settings precedence.
- SIGHUP settings reload.

### 15.4 Pipeline tests

Using fixture provider modules:

- Movie `tt0111161`.
- Series `tt0944947:1:1`.
- Season pack `tt0944947:1`.
- Provider timeout and partial results.
- No providers available.
- Malformed ID.
- Magnet-only provider filtered.
- Debrid-configured provider passes direct links.

### 15.5 Live tests

- First start with empty `/data` installs all 39 enabled providers.
- `/health` reports the active SHA and 39 providers.
- `/stream/movie/tt0111161.json` and `/stream/series/tt0944947:1:1.json` return streams.
- After an upstream commit, the next cycle updates the SHA/versions without a restart.
- Requests during a hot swap complete successfully.
- GitHub outage keeps the current snapshot serving.
- Restart reuses `/data` and does not re-download an unchanged SHA.

### 15.6 Commands

```
npm test
npm run typecheck
npm run build
docker build -t vega-stremio-addon .
docker run --rm -p 7000:7000 -v "$PWD/data:/data" vega-stremio-addon
```

## 16. Implementation Phases

### Phase 0 - Scaffold

- Initialize `package.json`, TypeScript, ESLint (optional), Vitest.
- Config loader with `zod`.
- Logger with redaction.
- Express app, `/manifest.json`, `/health`, empty `/stream`.
- Dockerfile and compose skeleton.
- `PLAN.md`, `README.md`.

### Phase 1 - Persistence and provider SDK

- Atomic JSON file helper.
- KV store.
- Cookie jar.
- HTTP transport with curl-cffi and fallback.
- Global fetch override and URL snapshot interception.
- Provider context construction.
- Unit tests for each.

### Phase 2 - Updater and registry

- GitHub SHA resolution with ETag and token.
- Snapshot download, header validation, staging, atomic rename.
- Provider registry and hot swap.
- Pending-provider retry.
- CLI update command.
- State persistence.
- Fixture update tests.

### Phase 3 - Movie pipeline

- Cinemeta client and cache.
- Provider search with concurrency/timeouts.
- Candidate scoring and meta verification.
- Direct-link resolution.
- Stream resolution and Stremio mapping.
- Movie integration tests.

### Phase 4 - Series pipeline

- Episode matching/ranges/packs.
- `getEpisodes` support.
- Cinemeta episode name fallback.
- Series integration tests.

### Phase 5 - Settings and efficiency

- `provider-settings.json`.
- Schema default seeding.
- Skip-timing disable and override.
- SIGHUP reload.
- Circuit breaker and cache tuning.
- Magnet filtering.

### Phase 6 - Optional proxy

- Token signing/verification.
- Range/206 streaming.
- HLS rewriting.
- SSRF guards.
- Tests.

### Phase 7 - Hardening and live validation

- Docker build/run.
- Live probe all 39 providers with known titles.
- Measure request latency and provider success rates.
- Fix provider-specific adapter issues.
- Update README with configuration and operations.
- Record findings in a project log.

## 17. Risks and Limitations

- **Trust boundary**: upstream code is auto-fetched and executed in-process with full Node privileges. The container is non-root and read-only, but that is not a security sandbox. This is an accepted decision.
- **Native module**: `curl-cffi-node` requires a matching prebuilt binary; Debian slim is recommended. If it fails to load, Cloudflare-protected providers will be less reliable.
- **WAF**: providers that require Turnstile/Cloudflare interactive solving will fail because there is no browser. Supplying `cf_clearance` cookies may help some.
- **Torrentio**: direct playback requires a debrid key; magnets are filtered by default.
- **Site volatility**: upstream provider sites change frequently. Provider failures are isolated and logged.
- **First start**: requires GitHub access; no offline baseline by design.
- **Licensing**: upstream has no explicit license file; review before publishing a public image.
- **In-process hangs**: a synchronous infinite loop in provider code can block the event loop. Mitigation is limited to code review, circuit breakers, and upstream trust. Move to a worker/QuickJS runtime later if this becomes a problem.

## 18. File Layout

```
/root/iptv/vega-stremio-addon/
  PLAN.md
  README.md
  package.json
  package-lock.json
  tsconfig.json
  Dockerfile
  docker-compose.yml
  src/
    index.ts
    config.ts
    logger.ts
    addon/
      manifest.ts
      routes.ts
      parseId.ts
    cinemeta/
      client.ts
    providers/
      source.ts
      updater.ts
      registry.ts
      loader.ts
      state.ts
      settings.ts
      sdk/
        context.ts
        http.ts
        cookieJar.ts
        kvStore.ts
    pipeline/
      streamHandler.ts
      match.ts
      episodes.ts
      mapStreams.ts
    proxy/
      sign.ts
      server.ts
    cli/
      update.ts
  tests/
    fixtures/
      source/
    updater.test.ts
    runtime.test.ts
    pipeline.test.ts
    mapping.test.ts
    proxy.test.ts
```

## 19. Acceptance Criteria

- On a clean start with empty `/data`, all 39 enabled providers are downloaded and loaded within 2 minutes on a normal connection.
- `/health` reports the active SHA, 39 providers, and update timestamps.
- A movie and a series request both return valid Stremio streams from multiple providers.
- Provider updates happen on the 4-6h schedule without a restart and without breaking in-flight requests.
- If GitHub is unreachable, the current snapshot continues serving.
- A provider with a bad/missing version header is never activated.
- No partial provider module set is ever served.
- Magnet links are absent unless `INCLUDE_MAGNETS=true` or a debrid key produces direct links.
- `/data` survives restarts; an unchanged SHA is not re-downloaded.
- No admin endpoints exist; only `/manifest.json`, `/stream/...`, and `/health` are exposed.

## 20. References

- Providers: `https://github.com/Zenda-Cross/vega-providers`
- Vega app: `https://github.com/vega-org/vega-app`
- Vega desktop: `https://github.com/vega-org/vega-desktop`
- Stremio addon SDK (protocol reference): `https://github.com/Stremio/stremio-addon-sdk`
- CloudStream Stremio plugin (client compatibility reference): `/root/iptv/cs3addon/StreamioLink`
