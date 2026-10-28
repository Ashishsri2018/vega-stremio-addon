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
`srv-dbgscpff3r2c73aiimkg` runs the free Docker plan in Oregon with auto-deploy on commits to
`main`; GitHub Actions runs CI on the same commits. The addon URL is
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
