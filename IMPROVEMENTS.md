# Improvement Recommendations

Reviewed `src/`, `tests/`, deployment docs, and the live-config defaults. Ordered by
impact-to-effort. Items marked **P0** are correctness/security issues worth fixing first.

> **Verification status (2026-11-06):** every item below was re-checked against the current code
> and fixed where it still applied. Each heading carries a **Status** line describing what was
> implemented. `npm run typecheck && npm test && npm run build` pass.

## Top 5

1. **Fix unused cache/TTL config** (`PROVIDER_CACHE_TTL_MS` is documented but ignored). **Done.**
2. **Add request coalescing** so duplicate Stremio requests do not trigger duplicate provider work. **Done.**
3. **Bind the HTTP server before provider bootstrap** and gate stream requests on readiness. **Done.**
4. **Add gzip/brotli response compression**; stream JSON can be large (up to 200 entries). **Done.**
5. **Pin proxy DNS resolution** to prevent the SSRF check/fetch DNS-rebinding gap. **Done.**

---

## P0 - Correctness and security

### 1. `PROVIDER_CACHE_TTL_MS` is ignored

**Status: fixed.** `StreamPipeline` now builds its search and mapping caches from
`PROVIDER_CACHE_TTL_MS`, the stream cache from `STREAM_CACHE_TTL_MS`, and empty stream results use
a 30 s negative cache. Tests cover both TTLs in `tests/pipeline.test.ts`.

`src/config.ts:35` and `src/config.ts:201` read the value, but `src/pipeline/streamHandler.ts:29`
hardcodes `SEARCH_CACHE_TTL_MS = 10m` and `MAPPING_CACHE_TTL_MS = 6h`. Operators who set
`PROVIDER_CACHE_TTL_MS` get no effect.

- Use `this.config.providerCacheTtlMs` for the mapping cache and a sensible derived/separate value
  for search (or add `SEARCH_CACHE_TTL_MS`/`MAPPING_CACHE_TTL_MS` explicitly).
- Add a config test asserting the pipeline cache honors the setting.

### 2. `uncaughtException` keeps running in an undefined state

**Status: fixed.** `src/index.ts` logs the exception and triggers the graceful shutdown path
(stop updater, close the server, flush KV/cookies), then exits non-zero; `unhandledRejection` stays
non-fatal. `src/util/startupGuard.ts` records starts in `DATA_DIR/startup-history.json` and enters
safe mode (no automatic updater, preload from disk only) after 3 starts within 2 minutes.

`src/index.ts:21-23` logs and continues. Node's own guidance is that the process is unsafe to
continue after an uncaught exception. A provider library or timer can leave shared state corrupted.

- Log, flush KV/cookies, close the server, then exit non-zero so the orchestrator restarts cleanly.
- Keep `unhandledRejection` non-fatal (or exit only for repeated/unknown rejections).
- Add a restart-rate guard so a provider update cannot cause a crash loop.

### 3. Proxy DNS-rebinding / TOCTOU SSRF gap

**Status: fixed.** `assertUrlAllowed()` returns the validated addresses and the proxy fetches
through an undici `Agent` whose `connect.lookup` resolves only to those pinned addresses
(`createPinnedLookup` in `src/proxy/server.ts`). Redirects are re-checked and re-pinned. Tests
cover IPv4/IPv6, `all: true`, and lookup failures.

`assertUrlAllowed()` resolves DNS in `src/proxy/server.ts:183-194`, then `fetch()` in
`src/proxy/server.ts:359-364` performs a second independent resolution. A malicious host can
return a public IP for validation and a private IP for the actual request.

- Resolve once and connect to the validated IP, passing the original `Host` header (custom undici
  `Agent`/`connect` or an HTTP client with a pinned lookup).
- Alternatively require an allowlist/denylist maintenance model and document that the proxy trusts
  provider-supplied URLs.
- Keep the redirect re-check; also consider re-checking after connection.

### 4. No abuse/rate limits on public deployments

**Status: fixed.** `src/addon/rateLimit.ts` implements per-IP and global token buckets plus a
concurrency cap. `/stream` returns HTTP 200 `{"streams":[]}` with `Retry-After` when limited;
`/proxy` returns 429. All limits are env-tunable (`STREAM_*`, `PROXY_*`) and `0` disables them.

All addon routes are unauthenticated. On Beamup (1.2 CPU / 1 GB), one client can exhaust the
provider fan-out or the proxy.

- Add a small in-process token bucket for `/stream` and `/proxy` (per IP and global), returning
  `{"streams":[]}` for `/stream` rather than an error.
- Add a separate tighter limit for the media proxy.
- Cap concurrent stream/cache-miss work globally in addition to `SEARCH_CONCURRENCY`.

### 5. `curl-cffi` path ignores `AbortSignal`

**Status: fixed.** `curlRequest()` rejects before calling the helper when the signal is already
aborted, races the helper against the signal, forwards the signal to curl-cffi, checks again after
completion, and lets `HttpTransport` fall back to native fetch on abort.

`HttpTransport.curlRequest()` (`src/providers/sdk/http.ts:418-456`) never reads `options.signal`, so
timeout/cancellation aborts only stop the outer promise. Work continues in the native binding and
can hold sockets/CPU after the request is gone.

- Check `signal.aborted` before/after the helper call and use curl cancel support if exposed.
- Ensure the fallback native path is taken when a signal is already aborted.

### 6. `lastError` is cleared even when pending retries fail

**Status: fixed.** `retryPending()` sets `draft.lastError` from the failure summary, so `/health`
reports the error while providers remain pending. Covered by `tests/updater.test.ts`.

In `src/providers/updater.ts:622`, `draft.lastError = null` runs regardless of failures. `/health`
then reports no error while providers remain pending.

- Set `lastError` when every retry failed, or keep the previous error.

---

## P1 - Latency and reliability

### 7. Request coalescing (single-flight)

**Status: fixed.** `StreamPipeline` keeps a single-flight map keyed by cache key. Concurrent callers
await the same internal promise, which uses its own `AbortController` and a waiter count so one
client disconnecting does not cancel the others. Tests assert one provider invocation for two
concurrent requests.

`StreamPipeline.handle()` checks the cache and then starts provider work
(`src/pipeline/streamHandler.ts:236-238`). Two simultaneous requests for the same title on a cold
cache both run the full search/meta/stream pipeline.

- Keep a `Map<cacheKey, Promise<StremioStream[]>>` and have concurrent callers await the same
  promise.
- Apply the same idea to provider search/mapping keys.
- Ensure the shared promise never holds a request-specific `AbortSignal`; use an internal signal so
  one client disconnecting does not cancel other callers.
- Add a test with two concurrent `handle()` calls asserting one provider invocation.

### 8. Bind before bootstrap

**Status: fixed.** `src/index.ts` starts listening immediately and runs bootstrap in the
background. Until a snapshot is active, `/stream` returns `{"streams":[]}`, `/health` reports
`degraded` (provider count 0), and `/manifest.json`/`/configure` remain available.

`src/index.ts:25` awaits `bootstrap()` (up to 60 s) before `app.listen()` at line 53. Beamup health
checks and cold requests can fail during that window.

- Start the server immediately, return `{"streams":[]}` until a snapshot is active, and expose
  readiness (`/health` status `degraded`) while bootstrap runs.
- Keep `/manifest.json` and `/configure` available immediately so Beamup's linter and users can
  reach the addon.
- Consider `UPDATE_ON_START=false` plus a background first update for platforms with a short
  startup grace period.

### 9. Response compression

**Status: fixed.** `createApp()` installs the `compression` middleware (gzip/brotli, 1 KB
threshold) and excludes `/proxy/` streaming. `/stream` keeps `no-store`; tests verify gzip on large
stream payloads and no encoding on small responses.

`createApp()` (`src/addon/routes.ts:120`) does not compress. 200 streams with subtitles is
several hundred KB of JSON.

- Add `compression` middleware (gzip/br), excluding the proxy streaming route.
- Verify `Transfer-Encoding` and `Content-Length` behavior on `/stream` and keep `no-store`.

### 10. Bake a baseline provider snapshot

**Status: fixed (optional).** The `Dockerfile` gained a `providers` stage and
`PROVIDER_SHA`/`PROVIDER_SOURCE` build args. `scripts/fetch-provider-snapshot.mjs` downloads the
pinned tarball, validates module headers, and writes a snapshot plus `state.json`; the entrypoint
seeds it into an empty `DATA_DIR`. The default build arg is empty so CI needs no network. Covered
by `tests/providerSnapshot.test.ts`; README notes the licensing caveat.

The image ships with no providers (`PLAN.md` decision), so every fresh container re-downloads
~1.8 MB from GitHub and can bind late or start degraded. On Beamup this happens on every redeploy
because `/data` is ephemeral.

- Add an optional build stage/arg that downloads a pinned snapshot into the image.
- Load it from disk at boot, then let the normal updater refresh it.
- This also makes the addon usable when GitHub is unavailable at startup.
- Review upstream licensing before distributing a public image.

### 11. Cache quality

**Status: fixed.** `TtlCache.get()` refreshes recency, so hot keys survive one-off bursts. Empty
stream results use a 30 s negative cache. A disk-backed cache was intentionally not added; the
in-memory warm-up trade-off on ephemeral hosts is documented in the README.

- `TtlCache` is FIFO, not LRU (`src/util/cache.ts:28-31`); hot search keys can be evicted by a
  burst of one-off titles. Refresh recency on `get()` or use an LRU map.
- Stream results are only cached when non-empty (`src/pipeline/streamHandler.ts:303-310`). Add a
  short negative cache (e.g. 30-60 s) for empty results to avoid re-fanning out for unavailable
  titles.
- On ephemeral hosts, the warm cache is lost on every redeploy. Either accept this or add an
  optional disk-backed search/mapping cache with short TTLs.

### 12. Provider search fan-out can starve slow providers

**Status: fixed.** Providers are ordered by `avgLatencyMs + failures * penalty` from in-memory
stats maintained per provider and cleared on snapshot activation, so healthy fast providers get
concurrency slots first. With the deployed `SEARCH_CONCURRENCY=40` the two-wave model is
unnecessary.

`mapLimitSettled(bundles, searchConcurrency, ...)` means the 41st provider waits for a slot even
when earlier providers are already returning. With `SEARCH_CONCURRENCY=40` on Beamup this is
mostly fine, but local defaults are lower.

- Order providers by recent success/latency instead of manifest order.
- Persist per-provider success/latency counters in memory and reset on activation.
- Consider a two-wave model: fast providers first, then the remainder if the request is still open.

---

## P2 - Stream quality and matching

### 13. Use broader search query variants

**Status: fixed.** Variants now include the original/native title when Cinemeta exposes it, the
article-stripped title, the `movie`/`series` suffix, and `S01`/`season 1` forms for series. Covered
by `tests/pipeline.test.ts`.

`src/pipeline/streamHandler.ts:427-434` tries `title`, `title year`, and `title type`. Add:

- Original/native title when Cinemeta exposes it.
- Title without leading articles (`The`, `A`, `An`).
- Year-only and alternate transliterations for non-English content.
- For series: `title Sxx` / `title season x`.

### 14. Absolute episode numbers for anime

**Status: fixed.** `computeAbsoluteEpisode()` derives the absolute index from the Cinemeta episode
order and `matchesEpisode()` accepts it as an alternate match; `Special`/`OVA`/`OAD` titles and
`Season 0` are matched explicitly. Covered by `tests/episodes.test.ts`.

`src/pipeline/episodes.ts` matches `SxxExx`, `1x02`, ranges, and packs. Many anime providers use
absolute numbering (`Episode 37`) for a long-running series.

- When Cinemeta provides the full episode order, map `(season, episode)` to an absolute index and
  accept that as an alternate match.
- Also match `Special`/`OVA`/`Season 0` explicitly.

### 15. Provider quality is provider-dependent

**Status: partially fixed.** Per-user include/exclude provider filters are encoded in the config
URL and applied before provider fan-out, and `/configure` lists configured setting keys (never
values). Audio-language, codec, and cached/debrid-only filters were not added because provider
stream metadata does not expose them consistently; the existing resolution/size/subtitle filters
remain.

- Add per-user provider include/exclude filters (in the config URL) in addition to the global
  `DISABLED_PROVIDERS`.
- Add audio-language, codec (H.264/HEVC/AV1), and "cached/debrid only" filters if the stream
  metadata exposes them.
- Surface the filter reason in `/configure` so users understand why a stream disappeared.

### 16. HLS low-latency tags are not rewritten

**Status: fixed.** `URI_TAG` now covers `PART`, `PRELOAD-HINT`, `RENDITION-REPORT`, `SESSION-DATA`,
and `DATERANGE` in addition to the existing tags; a low-latency playlist fixture verifies the
rewrite.

`URI_TAG` in `src/proxy/server.ts:30` covers `KEY`, `MAP`, `MEDIA`, `I-FRAME-STREAM-INF`, and
`SESSION-KEY`. Add:

- `#EXT-X-PART`, `#EXT-X-PRELOAD-HINT`, `#EXT-X-RENDITION-REPORT`, `#EXT-X-SESSION-DATA`,
  `#EXT-X-DATERANGE`.
- Add a test fixture with a low-latency playlist.

### 17. Response shim compatibility

**Status: fixed.** `TransportResponse` now provides `bytes()`, `clone()`, `bodyUsed`, and a lazy
`body` `ReadableStream` alongside `text`/`json`/`buffer`/`arrayBuffer`. Covered by
`tests/sdk-http.test.ts`.

`TransportResponse` (`src/providers/sdk/context.ts:82-116`) implements `text`, `json`, `buffer`,
`arrayBuffer`, and headers. Add `bytes()`, `clone()`, `bodyUsed`, and a minimal `body` stream so
newer provider bundles using Web `Response` APIs keep working.

### 18. Subtitle quality

**Status: fixed.** Subtitle normalization keeps `track.title` on the Stremio subtitle object,
normalizes language codes, and deduplicates subtitle URLs per stream (`src/pipeline/mapStreams.ts`).

- Prefer language codes from `track.language`; normalize `pt-BR`/`pt_BR` consistently (already
  done for filters).
- Preserve `track.title` as the Stremio subtitle `title` when present, and `id` namespacing.
- Deduplicate subtitle URLs per stream.

---

## P3 - Observability, testing, and operations

### 19. Richer health and metrics

**Status: mostly fixed.** `/health` now includes `snapshotAgeMs` and a `pipeline` block with
request totals, empty/deadline/settle counters, provider failures, and cache hits/misses. The
pipeline also tracks per-provider circuit breakers internally (logged at debug). A separate
`/metrics` endpoint was not added: metrics are merged into `/health`, which is already `no-store`
and secret-free, avoiding a new unauthenticated surface.

`/health` currently exposes updater state only. Add (without secrets):

- Active snapshot age and last activation duration.
- Per-provider circuit-breaker state and recent failure counts.
- Request counters: total, empty, deadline-hit, settle-hit, provider failures.
- Cache hit/miss counters.
- Optional `/metrics` (Prometheus text) behind an env token or only on a private port.

### 20. Request IDs and slow-request logs

**Status: fixed.** Every request gets a validated or generated ID returned as `X-Request-Id`.
`/stream` logs `pipeline.request_summary` at info level for errors and requests >= 2 s (debug
otherwise) with duration, stream count, and outcome; error logs carry the request ID.

- Generate a request ID per `/stream` request, log it with provider-stage timings, and include it in
  client-visible errors only if safe.
- Log a `pipeline.request_summary` at info level for slow requests (duration, stream count,
  providers that returned, deadline/settle outcome).

### 21. CI and dependency hygiene

**Status: fixed.** `.github/dependabot.yml` covers npm (`dev-dependencies` grouped),
GitHub Actions, and Docker. The CI Docker job loads the built image and boots it with
`VEGA_ENV_FILE=/dev/null UPDATE_ON_START=false`, asserting `/health` and `/manifest.json` answer.
`npm audit` was not added as a gate (Dependabot is the chosen mechanism, avoiding failures on
transitive advisories); the repo still has no lint/format tooling by design, and the
`--experimental-permission` idea was dropped because provider code needs unrestricted network and
filesystem access.

- Add `npm audit --omit=dev` (or Dependabot) to CI.
- Add a format/lint check only if the team wants one; the repo currently has neither, so avoid
  introducing inconsistent tooling.
- Add a `docker build` smoke test that boots with `UPDATE_ON_START=false` and asserts `/health`
  binds, so startup/config regressions fail CI.
- Test with `node --test`/Vitest under `--experimental-permission` (Node 22) if feasible for a
  sandbox-lite runtime check.

### 22. Config validation edge cases

**Status: fixed.** zod now enforces `SETTLE_MS <= GLOBAL_DEADLINE_MS` and
`EMPTY_FENCE_MS <= GLOBAL_DEADLINE_MS`, `configWarnings()` warns when `GLOBAL_DEADLINE_MS` exceeds
the ~10 s Beamup cutoff, and `PROVIDER_SETTINGS_JSON` is parsed at startup so invalid JSON aborts
with a clear error. Covered by `tests/config.test.ts`.

- Validate `SEARCH_CONCURRENCY`, `SETTLE_MS`, and `EMPTY_FENCE_MS` combinations that make the
  request budget meaningless (e.g. `SETTLE_MS > GLOBAL_DEADLINE_MS`).
- Warn when `GLOBAL_DEADLINE_MS` is above the ~10 s Beamup proxy cutoff.
- Validate `PROVIDER_SETTINGS_JSON` shape at startup (it is currently parsed lazily and failures keep
  the last good config, which is good, but startup cannot tell you the env is invalid).

### 23. Provider settings UX

**Status: fixed.** `SettingsManager.listConfiguredKeys()` exposes the sorted explicit key names,
and `/configure` renders them read-only. Values are never returned and secrets are still
environment-only.

Provider secrets still require environment variables. A safe improvement:

- A read-only `/configure` section that lists which provider settings keys are currently set, never
  their values.
- Never accept secrets in the config URL or store them server-side.

---

## Suggested sequencing

1. **P0 fixes:** config TTL, uncaught exception, proxy DNS pinning, rate limits, curl abort, health
   error reporting. **Done.**
2. **P1 latency:** request coalescing, bind-before-bootstrap, compression, baseline snapshot. **Done.**
3. **P2 quality:** search variants, anime numbering, HLS tags, response shim. **Done.**
4. **P3 ops:** metrics, request IDs, CI hardening. **Done.**

## Non-goals / risks to avoid

- Do not add a general admin HTTP API; it would widen the trust boundary on a public addon.
- Do not move provider execution to a worker/QuickJS sandbox without measuring the compatibility
  cost; the current in-process model is an accepted design decision.
- Do not add multi-account or ban-evasion behavior; it is explicitly out of scope per `AGENTS.md`.
- Do not cache full media bytes in the addon; keep the proxy streaming-only.
