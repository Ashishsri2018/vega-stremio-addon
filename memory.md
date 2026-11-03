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

## 2026-10-28 - Render deployment

The public repository is `https://github.com/Ashishsri2018/vega-stremio-addon`. Render service
`srv-dbgscpff3r2c73aiimkg` runs the free Docker plan in Oregon; GitHub Actions runs CI on commits to
`main`. The repository owner granted Render's GitHub app access on 2026-10-28, so pushes to `main`
can trigger Render's webhook auto-deploy. The addon URL is
`https://vega-stremio-addon-qtjz.onrender.com/manifest.json`.

Deployed checks:

- `/manifest.json`: HTTP 200 with the expected manifest.
- `/health`: `ok`, 39/39 providers active, no pending updates.
- Movie `tt0111161` warm: 38 streams, 0 magnets, 8 streams with proxy headers, ~6 s.
- Series `tt0944947:1:1` warm: 32 streams, ~6 s; first uncached request took 42-52 s on free CPU.
- Invalid IMDb IDs return `{"streams":[]}`; `HEAD` returns immediately.

The free plan stores data in `/tmp/data` and spins down when idle, so provider snapshots and runtime
KV/cookies are re-created after a restart. Use `PROVIDER_SETTINGS_JSON` for persistent settings, or
upgrade to Starter with the disk-enabled `render.yaml` blueprint.

### Known issues / notes

- `curl-cffi-node` 0.1.8 fails to load its native binding in this linux-arm64 PRoot environment;
  the addon correctly falls back to native fetch. Curl-specific impersonation is untested here.
- Provider-side WAF/site volatility remains the main live failure source; failures are isolated.
- Uncached series requests on the free Render plan can approach the 45 s global deadline.
- Upstream code executes in-process with Node privileges; this is an accepted trust boundary per PLAN.

## 2026-11-02 - Beamup deployment

Deployed the same Docker image to Stremio's Beamup PaaS. Live app:
`https://a38b6dd4fcd1-vega-stremio-addon-docker.baby-beamup.club/manifest.json`. Global CLI config
is `/root/beamup-config.json` (host `a.baby-beamup.club`, GitHub user `Ashishsri2018`);
`beamup.json` is local state with `projectName: vega-stremio-addon-docker`.

### Setup

- Added an account-level GitHub SSH key (`~/.ssh/id_ed25519`, comment
  `beamup-vega-stremio-addon`) via `gh api user/keys`; Beamup syncs account keys, not repo deploy
  keys.
- Used `beamup-cli` 1.3.2 through `npx`; `beamup init` added the remote
  `dokku@a.baby-beamup.club:a38b6dd4fcd1/vega-stremio-addon-docker`.
- First deployment used project name `vega-stremio-addon` and failed: Beamup ran the Herokuish
  `command: /start web`, producing `exec: "/start": stat /start: no such file or directory` and a
  504. Deleted that app and redeployed as `vega-stremio-addon-docker`; the Dockerfile path then
  worked without a `command`.
- Deploy command: `git push beamup HEAD:master --force`.

### Configuration

Applied via `ssh dokku@a.baby-beamup.club config:set a38b6dd4fcd1/vega-stremio-addon-docker ...`:
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
- Old broken app `a38b6dd4fcd1-vega-stremio-addon` was deleted with `delete-addon`.

No source changes were needed for the Beamup deployment.

## 2026-11-03 - Beamup is the active deployment

- The active public deployment is Beamup
  (`https://a38b6dd4fcd1-vega-stremio-addon-docker.baby-beamup.club/manifest.json`). The Render
  blueprint remains in the repo only as an optional/legacy self-hosting path.
- Pushes to GitHub `main` run CI but do not update the Beamup app. Beamup deploys stay manual via
  `git push beamup HEAD:master --force`; config changes use `ssh dokku@a.baby-beamup.club
  config:set <hash>/vega-stremio-addon-docker KEY=...`.
- Configured ShowBox by setting `PROVIDER_SETTINGS_JSON` with `kv.febboxCookie` as
  `ui=<Febbox JWT>`. The raw JWT alone is rejected by Febbox; the `ui=` prefix is required and was
  verified against `video_quality_list` (authenticated response instead of `Please login`).
- A GramCinema bearer token was provided, but no active provider in `Zenda-Cross/vega-providers` or
  this addon requires it, so it was not stored.
- Updated README, AGENTS.md, and architecture.md to state that Beamup is active and Render is
  optional/legacy. Pushed the docs update to GitHub; no Beamup redeploy was performed.
