# Project Memory

## 2026-10-28 - Initial implementation from PLAN.md

Implemented the complete addon described in `PLAN.md` using four parallel agents with fixed file
ownership plus an integration pass.

### Delivered

- Scaffold: Node 22 ESM TypeScript, Express, Vitest, zod config, structured redacting logger,
  atomic JSON/fs helpers, concurrency/cache utilities.
- Provider SDK: native/curl-cffi HTTP transport with fallback, axios adapter, global fetch shim,
  `urls.json` snapshot interception, KV store, cookie jar, provider context.
- Updater: GitHub HEAD/ETag and pinned SHA resolution, raw branch fallback, immutable downloads,
  header/export validation, atomic staging/activation, pending retries, lock file, scheduling with
  backoff, state persistence, snapshot cleanup, settings schema seeding/SIGHUP reload.
- Registry: immutable snapshots, refcounted leases, hot swap, grace-period require-cache purge.
- Pipeline: Cinemeta, candidate matching, episode/range/pack resolution, stream mapping, circuit
  breaker, caches, global deadline with partial results, magnet filtering.
- Addon: exact manifest, ID parser, stream/health routes, CORS, signed media proxy with Range
  streaming, HLS rewriting, token expiry, and SSRF guards.
- Ops: Dockerfile (non-root, read-only FS compatible, dumb-init, healthcheck), compose file,
  README, architecture doc, CLI update command.

### Verification

- `npm test`: 219 Vitest tests green (unit, fixture update, runtime, pipeline, proxy, routes).
- `npm run typecheck`: clean.
- `npm run build`: clean.
- GitHub Actions: typecheck, 219 tests, build, and Docker image build passed on Node 22.
- Live first start against GitHub: 39/39 providers installed, 1,779,983 bytes, ~30 s, `/health` ok.
- Live movie `tt0111161`: 83 streams from 6 providers, no magnets.
- Live series `tt0944947:1:1`: 54 streams from 6 providers; season pack `tt0944947:1`: 45 streams.
- CLI update with unchanged SHA: 0 bytes, 39 skipped; restart reused disk snapshot without network.
- Settings seeding produced `*_skipTimings=false` for all provider keys.
- `PROVIDER_SETTINGS_JSON` overrides the settings file; malformed inline JSON keeps the last good config.

## 2026-10-28 - Legacy Render deployment

The public repository is `https://github.com/Ashishsri2018/vega-stremio-addon`. A legacy Render free
Docker service in Oregon was used for early testing and was deleted on 2026-11-07. Its service ID
and URL are intentionally not recorded here. GitHub Actions runs CI on commits to `main`; Render's
GitHub app auto-deploy was configured at the time.

Deployed checks:

- `/manifest.json`: HTTP 200 with the expected manifest.
- `/health`: `ok`, 39/39 providers active, no pending updates.
- Movie `tt0111161` warm: 38 streams, 0 magnets, 8 streams with proxy headers, ~6 s.
- Series `tt0944947:1:1` warm: 32 streams, ~6 s; first uncached request took 42-52 s on free CPU.
- Invalid IMDb IDs return `{"streams":[]}`; `HEAD` returns immediately.

The free plan stored data in `/tmp/data` and spun down when idle, so provider snapshots and runtime
KV/cookies were re-created after a restart. Use `PROVIDER_SETTINGS_JSON` for persistent settings, or
the disk-enabled `render.yaml` blueprint for optional self-hosting.

### Known issues / notes

- `curl-cffi-node` 0.1.8 fails to load its native binding in this linux-arm64 PRoot environment;
  the addon correctly falls back to native fetch. Curl-specific impersonation is untested here.
- Provider-side WAF/site volatility remains the main live failure source; failures are isolated.
- Uncached series requests on the free Render plan can approach the 45 s global deadline.
- Upstream code executes in-process with Node privileges; this is an accepted trust boundary per PLAN.

## 2026-11-02 - Beamup deployment

Deployed the same Docker image to Stremio's Beamup PaaS. The app name and URL are private and not
recorded here; the remote is held in the owner's environment and in the `BEAMUP_REMOTE` repository
secret. Global CLI config is `/root/beamup-config.json` (host `a.baby-beamup.club`, GitHub user
`Ashishsri2018`); `beamup.json` is untracked local state.

### Setup

- Added an account-level GitHub SSH key (`~/.ssh/id_ed25519`, comment
  `beamup-vega-stremio-addon`) via `gh api user/keys`; Beamup syncs account keys, not repo deploy
  keys.
- Used `beamup-cli` 1.3.2 through `npx`; `beamup init` added a local remote with the per-user hash
  path. Never commit that remote or the project name.
- First deployment used a project name without `docker` and failed: Beamup ran the Herokuish
  `command: /start web`, producing `exec: "/start": stat /start: no such file or directory` and a
  504. Deleted that app and redeployed with a `docker`-suffixed name; the Dockerfile path then
  worked without a `command`.
- Deploy command: `git push "$BEAMUP_REMOTE" HEAD:master --force`.

### Configuration

Applied via `ssh dokku@a.baby-beamup.club config:set <app-path> ...`:
`LOG_LEVEL=info INCLUDE_MAGNETS=false PROXY_ENABLED=false UPDATE_INTERVAL_MIN_HOURS=4
UPDATE_INTERVAL_MAX_HOURS=6 SETTLE_MS=4000 EMPTY_FENCE_MS=0 SEARCH_CONCURRENCY=16
SEARCH_TIMEOUT_MS=4000 STREAM_TIMEOUT_MS=6000 GLOBAL_DEADLINE_MS=8000`.

### Verification

- `/health`: `ok`, 39/39 providers active, `pending: []`, snapshot SHA
  `260cac86a528e8e162ce9e0c75743296efdc6f44`; last success `2026-11-02T14:11:47.657Z`, next check
  `2026-11-02T18:56:02.981Z` (~4h44m).
- `/manifest.json`: HTTP 200; cold response took ~7.5 s.
- Filters: `{"v":1,"maxRes":720}` returned 56 streams with none above 720p (14 unknown-resolution
  streams kept by default); strict `{"v":1,"maxRes":720,"includeUnknown":false}` returned 50 with a
  720p maximum; `{"v":1,"minRes":1080}` worked; invalid config segments fell back to unfiltered.
- Warm movie/series requests returned 60-79 streams; Beamup's cold proxy path is less reliable and
  may return fewer streams or 504.

### Platform findings

- Beamup is Stremio's Dokku/swarm PaaS. Swarm services get 1.2 CPU and 1 GB RAM, restart at most 10
  times per 5 min with a 60 s delay, and each GitHub user can have at most 20 addons.
- No persistent volume is mounted for this app: `/data` is container-local, so provider snapshots,
  KV, cookies, and file settings are lost when the container is recreated (redeploy). Use
  `PROVIDER_SETTINGS_JSON`. The server binds only after bootstrap, capped at 60 s
  (`BOOTSTRAP_TIMEOUT_MS`).
- Beamup's nginx proxy is configured to cache `200`/`302` for 2 h (subject to response cache
  headers), uses `proxy_cache_lock`, and serves stale on upstream errors. `/stream` and `/health`
  are `no-store`.
- No published AUP/terms page. Enforcement is manual via abuse reports; `beamup-ban-user` removes
  the user's key from the host's `authorized_keys` and adds the hashed GitHub username to
  `/etc/beamup/ban_list.txt`, blocking further deploy/config/logs/delete. The addon linter only
  validates the Stremio manifest. Hosting this addon on Beamup carries copyright/platform risk.
- An earlier app created without `docker` in the name was deleted with `delete-addon`.

No source changes were needed for the Beamup deployment.

## 2026-11-03 - Beamup is the active deployment

- Beamup became the active deployment. Its app name and URL are private and intentionally not
  recorded here. The Render blueprint remains in the repo only as an optional/legacy self-hosting
  path; the old Render service was deleted on 2026-11-07.
- Pushes to GitHub `main` run CI but do not update the Beamup app. Beamup deploys stay manual via
  `git push "$BEAMUP_REMOTE" HEAD:master --force`; config changes use `ssh dokku@a.baby-beamup.club
  config:set <app-path> KEY=...`.
- Configured ShowBox by setting `PROVIDER_SETTINGS_JSON` with `kv.febboxCookie` as
  `ui=<Febbox JWT>`. The raw JWT alone is rejected by Febbox; the `ui=` prefix is required and was
  verified against `video_quality_list` (authenticated response instead of `Please login`).
- A GramCinema bearer token was provided, but no active provider in `Zenda-Cross/vega-providers` or
  this addon requires it, so it was not stored.
- Updated README, AGENTS.md, and architecture.md to reflect Beamup as active and Render as an
  optional legacy self-hosting path. Pushed the docs update to GitHub; no Beamup redeploy was
  performed.

## 2026-11-04 - Subtitle language and file size filters

Added two per-user filters beyond resolution, kept in the same base64url URL segment and applied
after the shared stream cache:

- `subtitleLangs`: keeps only matching subtitle tracks. Language matching is case-insensitive,
  accepts `_`/`-` separators, and treats region variants as their base language (`pt-BR` matches
  `pt`). Streams with no matching tracks are returned without subtitles.
- `maxSizeMB`: filters on human-readable sizes parsed from stream titles (`656 MB`, `1.29 GB`,
  `512 MiB`). Speeds such as `1.5 MB/s`, `27 MB/S`, and `490 KB/s` are ignored. Size metadata is
  provider-dependent, so `includeUnknownSize` defaults to true; `includeUnknown` still controls
  unknown resolution.
- `/configure` now exposes "Maximum file size", "Include streams with unknown file size", and
  "Subtitle languages" (comma-separated codes). `/configure` and README were updated.

Verification:

- `npm run typecheck && npm test && npm run build`: 256 tests green.
- Deployed commit `b267bbb` to Beamup with `git push "$BEAMUP_REMOTE" HEAD:master --force`; live
  `/configure` shows the new controls.
- Live size filter `{"v":1,"maxSizeMB":2048}` on `tt0944947:1:1`: 0 streams above 2 GB, 6 sized
  streams, unknown-size streams retained.
- Live subtitle filter `{"v":1,"subtitleLangs":["en"]}` on `tt4574334:1:1`: 3 tracks, all English.
- GitHub `main` pushed to `b267bbb`. Docs-only follow-up will be pushed with `[skip ci]`.

Size coverage is sparse: GoT had sizes on 9/26 streams; Stranger Things had 0/47. The filter only
removes streams when a size is parseable, so most providers' unknown-size streams remain unless the
toggle is cleared.

## 2026-11-06 - Stream cache TTL set to 3 minutes on Beamup

- `deploy/beamup.env` now sets `STREAM_CACHE_TTL_MS=180000` (was unset, so the `60000` default
  applied). The stream cache is keyed by `type:imdbId:season:episode` and shared across per-user
  config segments, so repeat requests within 3 minutes reuse provider results.
- The value is baked into the image and sourced by `docker-entrypoint.sh` at container start;
  it takes effect on the next Beamup deploy.
- Source default in `src/config.ts` is unchanged (`60000`); only the Beamup deployment overrides it.

## 2026-11-07 - Private Beamup deployment

- Created a replacement Beamup app with a private random name, copied only
  `PROVIDER_SETTINGS_JSON` from the old app, and verified the value by canonical JSON hash without
  printing it. Retired the old Beamup app and the legacy Render service.
- The new app verifies `ok` with 39 providers, `pending: []`; movie `tt0111161` and series
  `tt0944947:1:1` return non-empty streams.
- The app name, URL, and remote are not recorded in the repository. CI requires `BEAMUP_REMOTE` and
  masks the remote and app name; install the manifest URL directly in Stremio, not through
  AIOStreams or a shared configuration URL.
- Fixed `scripts/apply-beamup-env.sh`: Beamup's `config:set` wrapper passes values literally, so the
  script no longer shell-quotes them; quoting added literal backslashes to JSON values.

## 2026-11-07 - Partial stream cache and disabled settle guards on Beamup

- Repeat movie/series requests could return more streams than the first because deadline/settle
  truncation was never cached while search, mapping, latency, and breaker state persisted.
- `StreamPipeline` now caches every non-aborted response: complete results use
  `STREAM_CACHE_TTL_MS`, while deadline/settle-truncated and empty results use
  `STREAM_PARTIAL_CACHE_TTL_MS` (default 30 s).
- `deploy/beamup.env` disables `SETTLE_MS` and `EMPTY_FENCE_MS`, so uncached requests use the full
  10 s global budget before returning.
- Docs and tests updated (`README.md`, `architecture.md`, `AGENTS.md`, `tests/pipeline.test.ts`).

## 2026-11-08 - Subtitles resource for Nuvio Mobile

- Manifest now advertises `resources: ["stream", "subtitles"]`; added `GET /subtitles/:type/:path*`
  and `GET /:config/subtitles/:type/:path*` (`src/addon/routes.ts`). `:path*` absorbs the optional
  Stremio extras segment because Express 4 routes have no optional-param groups.
- `StreamPipeline.collectSubtitles()` reuses `handle()`, so subtitle requests share the stream cache,
  in-flight fan-out, deadlines, breakers, and rate limit; it flattens `stream.subtitles` and dedupes
  by URL. Config segments apply only `subtitleLangs` (`filterSubtitleTracks` in `userConfig.ts`).
- Subtitle track URLs are not rewritten through the media proxy; tracks needing provider headers may
  not load.
- Verified locally with `deploy/beamup.env` settings: `tt0111161` returned 44 tracks in ~10 s (the
  global deadline), extras path was a cache hit, the following stream request was a cache hit; all
  304 tests pass. Beamup redeploys via CI on push.

## 2026-11-09 - Root endpoint for uptime checks

- Added `GET /` (info JSON with relative `manifest`/`configure`/`health` links, `no-store`) in
  `src/addon/routes.ts`. The bare deployment URL previously returned a JSON 404 for every method, so
  uptime pingers pointed at the root had nothing to hit.
- Express answers `HEAD` on every GET route without a body; the new root route is covered by a
  `tests/addon.test.ts` case for GET and HEAD.
- Docs updated (`README.md`, `architecture.md`).

## 2026-11-11 - Web page & archive classification, canonical deduplication, 100/1000 stream limits

- Added `src/pipeline/urlClassifier.ts` (<150 lines) to identify web pages, HTML embeds, Telegram links, and compressed archives (`.zip`, `.rar`, `.7z`, etc.).
- `mapProviderStreams` maps detected web pages/embeds/archives to Stremio `externalUrl`, omitting `url`, `proxyHeaders`, and `subtitles` to prevent Stremio native player failures on web links.
- Anti-bot / rate-limit blocker links (`/slowdown`) are dropped at ingestion in `mapProviderStreams` and `sortStreams`.
- Direct playable video streams are sorted before external web links in `sortStreams`.
- Canonical same-file URL deduplication (`normalizeStreamKey`) strips URL fragments, trailing slashes, and host casing across all providers.
- Stream limits increased: per-provider limit increased from 20 to 100 (`MAX_STREAMS_PER_PROVIDER = 100`, `DEFAULT_PER_PROVIDER_LIMIT = 100`, `MAX_LINKS_PER_PROVIDER = 100`, `MAX_STREAM_CALLS_PER_REQUEST = 120`), and total link limit increased from 200 to 1000 (`MAX_TOTAL_STREAMS = 1000`).
- Updated `tests/mapping.test.ts` and `tests/pipeline.test.ts` with 5 new tests covering classification, externalUrl mapping, blocker dropping, canonical deduplication, direct-first sorting, and new 100/1000 limits. 330/330 tests pass.
- Fixed provider-level timeout clamping in `src/pipeline/streamHandler.ts` (`remaining + 50`) so global pipeline deadline authoritative timer reliably records deadline hit telemetry without race conditions.
- Deployed to Beamup via GitHub Actions CI/CD (`42964578722`). Verified live on `https://a38b6dd4fcd1-vg-8563e002b526099c5b9facfc-docker.baby-beamup.club`:
  - `/manifest.json` and `/health` responding with 40 active providers.
  - Movie `tt0137523` (Fight Club): 55 streams (54 direct, 1 externalUrl), 0 duplicates, direct streams ordered first, external stream correctly stripped of `url`, `subtitles`, and `proxyHeaders`.
  - Series `tt0944947:1:1` (Game of Thrones): 22 streams (18 direct, 4 externalUrl for `.zip` archive packages), 0 duplicates, direct streams sorted first.
- Docs updated (`architecture.md`, `memory.md`, `todo.md`).

## 2026-11-09 - Direct TMDB ID support

- Requests now accept `tmdb:<id>[:<season>[:<episode>]]` in addition to IMDb `tt...` IDs. The
  manifest advertises `idPrefixes: ["tt", "tmdb:"]` only when `TMDB_API_KEY` is set; otherwise it
  stays exactly `["tt"]` and TMDB requests return `{"streams":[]}`.
- Providers in this addon search by title and do not accept TMDB IDs, and Cinemeta rejects `tmdb:`
  IDs. `src/tmdb/client.ts` therefore maps `/movie/{id}` and `/tv/{id}` (with `external_ids`) to
  Cinemeta-shaped metadata: title, year, episode list from season counts, requested-season episode
  names, and the IMDb ID when TMDB has one. The IMDb ID drives provider meta matching; otherwise
  matching falls back to title/year/type. Metadata is cached 6 h; failed lookups are not cached.
- `StreamRequest` is now a union (`imdbId` or `tmdbId`); `parseStreamId`, `contentIdOf`, and
  `requestLogFields` in `src/addon/parseId.ts` centralize parsing, cache keys, and logs. Stream and
  mapping caches key on `contentId` (`tt...`/`tmdb:...`).
- Config adds `TMDB_API_KEY` (secret) and `TMDB_URL` (default `https://api.themoviedb.org/3`). The
  client uses `nativeFetch` and never logs request URLs or the key.
- Tests: new `tests/tmdb.test.ts` (movie/series mapping, season names, missing IMDb ID, 404 and
  key-redaction), plus TMDB cases in config, addon, and pipeline tests. `npm run typecheck`, 325
  tests, and `npm run build` pass. Live TMDB smoke returned Fight Club (`tt0137523`) and Breaking Bad
  season 1 episode names.
- Docs updated (`README.md`, `architecture.md`, `AGENTS.md`). The key is stored as the dedicated
  `TMDB_API_KEY` GitHub Actions secret (never in the repo); the deploy step appends it to
  `BEAMUP_EXTRA_ENV` before `scripts/apply-beamup-env.sh` runs. It can also be placed directly in
  `BEAMUP_EXTRA_ENV`. `mal:`/`kitsu:` IDs remain unsupported.


## 2026-11-11 - Decouple subtitle language filter from streams

- `filterStreams()` now applies only resolution and size rules. It no longer trims inline
  `stream.subtitles` or removes the field when a language does not match.
- The subtitle routes already applied `filterSubtitleTracks(subtitles, userConfig)`; that remains the
  only place `subtitleLangs` takes effect, so a language preference cannot remove media links.
- `/configure` hint now states that the language list filters only the subtitles resource.
- Updated `tests/userConfig.test.ts` to cover `filterSubtitleTracks` directly and to assert
  `filterStreams` leaves streams and inline tracks untouched; `tests/addon.test.ts` now asserts the
  stream route keeps every inline track under a config segment.
- Verified with `npm run typecheck && npm test && npm run build`.

## 2026-11-11 - Canonical health and stats telemetry

- `/health` and `/stats` now return the same canonical object: status/timestamps, snapshot, normalized provider stats, stream/metadata cache stats, and request metrics.
- `TtlCache` now records hits, misses, sets, evictions, and expiries; `getMetrics()` exposes stream-cache, metadata-cache, and provider snapshots.
- Health route tests assert canonical structure, stats parity, and normalized pipeline values.

## 2026-11-11 - Cache parity: non-empty only, partial results at 30 s

- Stream results are cached only when non-empty. Deadline/settle-truncated non-empty results use
  `STREAM_PARTIAL_CACHE_TTL_MS` (default `30000`); complete results use `STREAM_CACHE_TTL_MS`.
- The provider search cache no longer stores empty post lists, so an empty result always retries
  instead of being negative-cached for `PROVIDER_CACHE_TTL_MS`.
- Aligns Vega with Nuvio and SA7: empty stream results are never cached in any addon.
