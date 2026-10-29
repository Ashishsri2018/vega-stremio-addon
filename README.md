# Vega Streams - Stremio Addon

Self-hosted Stremio addon that serves movie and series streams from the 39 enabled providers in
[`Zenda-Cross/vega-providers`](https://github.com/Zenda-Cross/vega-providers).

- Streams only, IMDb IDs only (`tt...`), movie and series.
- Provider code is downloaded from GitHub at runtime and executed in-process.
- Upstream is checked every 4-6 hours and new provider bundles are hot-swapped without a restart.
- Direct links are returned with the HTTP headers players need; an optional signed proxy is included.
- Per-user filters (max/min resolution) are encoded in the add-on URL; nothing is stored server-side.
- No admin HTTP API. Only `/configure`, `/manifest.json`, `/stream/...`, `/health`, and (when enabled)
  `/proxy/...`.

## Quick start

```bash
mkdir -p data
docker compose up -d --build
```

Install in Stremio with `http://<host>:7000/manifest.json`, or open `http://<host>:7000/configure`
to build a personalized add-on URL with stream filters.

On the first start the addon downloads the current snapshot (39 providers, about 1.8 MB). The
server binds after the download completes or after 60 seconds, whichever comes first. If GitHub is
unreachable, the addon still starts, reports `degraded` on `/health`, and retries in the background.

Without Docker:

```bash
npm ci
npm run build
PORT=7000 DATA_DIR=./data node dist/index.js
```

## Deploy to Render

The repository includes a Render Blueprint (`render.yaml`): a Docker web service on the Starter
plan with a 1 GB persistent disk mounted at `/data`, so snapshots and provider-written KV survive
restarts.

Live instance: `https://vega-stremio-addon-qtjz.onrender.com/manifest.json` (free plan, Oregon).

1. Push the repository to GitHub.
2. In Render, choose **New +** > **Blueprint** and select the repository. Render reads
   `render.yaml`. Make sure Render's GitHub app can access the repository, otherwise push webhooks
   (and therefore auto-deploy) are not delivered.
3. Optionally add environment variables in the Render dashboard:
   - `GITHUB_TOKEN` for higher GitHub API rate limits.
   - `PROVIDER_SETTINGS_JSON` with the same JSON accepted by `provider-settings.json`; the
     environment value takes precedence over the file.
   - `PROXY_ENABLED=true`, `PROXY_SECRET=<random>`, and
     `PUBLIC_BASE_URL=https://<service>.onrender.com` to use the signed media proxy.
4. Install the addon in Stremio with `https://<service>.onrender.com/manifest.json`, or open
   `https://<service>.onrender.com/configure` to build a filtered install URL.

Pushes to `main` run the GitHub Actions workflow (typecheck, tests, build, Docker build), and Render
auto-deploys the same commit from GitHub (`autoDeploy: true`). Grant Render's GitHub app access to
the repository under GitHub **Settings > Applications > Render > Configure**; without it, Render can
clone a public repository but does not receive push webhooks. You can also deploy manually with
`render deploys create <service-id>` or use the service's Deploy Hook.

- Render injects `PORT`; leave it unset.
- The container entrypoint starts as root only to fix ownership of the mounted disk, then drops to
  the unprivileged `node` user.
- Render probes `/health`. The first boot downloads the 39-provider snapshot (about 1.8 MB).
- The free plan has no persistent disks and spins down when idle. Use `render-free.yaml` instead
  (copy it over `render.yaml` before creating the Blueprint): it stores data in `/tmp/data`, so cold
  starts re-download the snapshot and runtime KV/cookies/settings are lost. Keep provider settings
  in `PROVIDER_SETTINGS_JSON` on the free plan. The blueprint disables the empty-result fence
  (`EMPTY_FENCE_MS=0`) so slow series requests can still return streams, settles after 8s without
  new streams (`SETTLE_MS=8000`), runs provider searches with `SEARCH_CONCURRENCY=16`, and uses
  shorter provider timeouts (`SEARCH_TIMEOUT_MS=6000`, `STREAM_TIMEOUT_MS=15000`) because the free
  instance's 0.1 CPU is the bottleneck.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /configure` | Filter configuration page that builds the add-on URL |
| `GET /manifest.json` | Stremio manifest (stable version across provider updates) |
| `GET /<config>/manifest.json` | Manifest for a personalized (filtered) install |
| `GET /stream/movie/tt0111161.json` | Movie streams |
| `GET /stream/series/tt0944947:1:1.json` | Series episode streams |
| `GET /stream/series/tt0944947:1.json` | Season requests (packs and episodes) |
| `GET /<config>/stream/...` | Streams filtered by the config segment |
| `GET /health` | Minimal provider/update status (no secrets) |
| `GET /proxy/<token>` | Signed media proxy (only when `PROXY_ENABLED=true`) |

Addon routes always return HTTP 200 with JSON. Invalid IDs and provider failures produce
`{"streams":[]}`. `/stream` and `/health` are `Cache-Control: no-store`. `/configure` is the only
HTML route.

## Filters

Open `/configure` to choose a maximum and/or minimum resolution and whether streams with unknown
resolution are included (default: included). The page builds a personalized add-on URL of the form
`https://<host>/<config>/manifest.json`, where `<config>` is a base64url-encoded JSON document such
as `{"v":1,"maxRes":720}`. Filters travel in the URL: nothing is stored server-side, so installs
keep working across restarts, redeploys, and free-tier cold starts. Invalid config segments fall
back to unfiltered defaults.

Resolution is inferred from provider quality tags and stream titles. Streams whose resolution
cannot be determined are kept unless the "include unknown resolution" checkbox is cleared. Installing
the plain `/manifest.json` URL remains supported and returns unfiltered streams. In Stremio, the
add-on's gear icon opens the configure page with the current settings pre-filled.

## Response time

Requests stop early instead of always burning the full `GLOBAL_DEADLINE_MS`:

- `SETTLE_MS` (default `8000`): after at least one stream is collected, the request finishes when
  no new stream arrives for this long. Slow or dead providers no longer block the response.
- `EMPTY_FENCE_MS` (default `0`, disabled): with no streams collected, finish after this long
  instead of waiting for the global deadline. Keep this disabled on slow hosts: series providers
  often need more than 25 s to return their first stream, and an early fence makes every series
  request look empty.

Both guards are disabled with `0`; the global deadline remains the absolute cap. On Render's free
plan, cold starts (30-60 s) dominate the first request, so a keep-warm ping every ~10 minutes
avoids most of that cost.

## Configuration

All settings are environment variables. Invalid values fail fast at startup.

| Name | Default | Purpose |
|---|---|---|
| `PORT` | `7000` | HTTP port |
| `DATA_DIR` | `/data` | Persistent state, provider snapshots, KV, cookies |
| `PROVIDER_SOURCE` | `Zenda-Cross/vega-providers` | GitHub `owner/repo` |
| `PROVIDER_BRANCH` | `main` | Branch used for HEAD resolution and fallback |
| `PROVIDER_SHA` | empty | Pin a snapshot (install or rollback) |
| `GITHUB_TOKEN` | empty | Higher GitHub API rate limits |
| `UPDATE_ON_START` | `true` | Update after boot when no snapshot is loaded |
| `UPDATE_INTERVAL_MIN_HOURS` | `4` | Minimum check interval |
| `UPDATE_INTERVAL_MAX_HOURS` | `6` | Maximum check interval |
| `UPDATE_CONCURRENCY` | `8` | Provider download parallelism |
| `HTTP_TIMEOUT_MS` | `15000` | SDK transport timeout |
| `SEARCH_CONCURRENCY` | `16` | Provider search parallelism |
| `SEARCH_TIMEOUT_MS` | `10000` | Per-provider search timeout |
| `META_TIMEOUT_MS` | `15000` | Per-provider meta/episodes timeout |
| `STREAM_TIMEOUT_MS` | `20000` | Per-provider stream timeout |
| `GLOBAL_DEADLINE_MS` | `45000` | Overall request budget (partial results are returned) |
| `SETTLE_MS` | `8000` | Finish once collected streams stop arriving for this long (`0` disables) |
| `EMPTY_FENCE_MS` | `0` | Finish a request with no collected streams after this long (`0` disables) |
| `INCLUDE_MAGNETS` | `false` | Include torrent/magnet streams (playback needs a debrid client) |
| `PROXY_ENABLED` | `false` | Enable the signed media proxy |
| `PROXY_SECRET` | empty | HMAC secret; required when the proxy is enabled |
| `PUBLIC_BASE_URL` | empty | Absolute base URL used in proxy stream links |
| `SETTINGS_FILE` | `<DATA_DIR>/provider-settings.json` | Provider settings file |
| `PROVIDER_SETTINGS_JSON` | empty | Inline provider settings JSON; overrides the settings file |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `CINEMETA_URL` | `https://v3-cinemeta.strem.io` | Metadata endpoint |
| `KV_FLUSH_MS` | `500` | KV/cookie write debounce |
| `PROVIDER_CACHE_TTL_MS` | `21600000` | Search/mapping cache TTL |
| `STREAM_CACHE_TTL_MS` | `60000` | Stream cache TTL |

Never log or commit `PROXY_SECRET`, `GITHUB_TOKEN`, debrid keys, or cookies.

## Provider settings

Mount an optional JSON file at `$DATA_DIR/provider-settings.json` (or `SETTINGS_FILE`):

```json
{
  "skipTimings": false,
  "kv": {
    "torrentio_debridService": "realdebrid",
    "torrentio_debridApiKey": "REPLACE_ME",
    "torrentio_customInstanceUrl": "https://torrentio.strem.fun",
    "febboxCookie": "REPLACE_ME",
    "netflixMirror_t_hash_t": "REPLACE_ME"
  }
}
```

- `skipTimings: false` (default) seeds every `*_skipTimings` key to `false`, avoiding TheIntroDB calls.
- `kv` entries use exact provider KV keys and override schema defaults and `skipTimings`.
- Provider-written values (for example tokens obtained at runtime) are preserved unless overridden.
- On Render or other ephemeral platforms, set `PROVIDER_SETTINGS_JSON` to the same JSON object; it
  takes precedence over the file and is useful when no persistent disk is available.
- Malformed files or JSON are ignored with an error log; the last good configuration stays active.
- Reload without a restart: `docker kill -s HUP vega-addon` (or `kill -HUP <pid>`).

Useful keys: Torrentio debrid service/API key and custom instance; `febboxCookie` for Showbox;
`t_hash_t`/`baseUrlOverride` for the Netflix/Prime/Disney mirrors; Animesub manifest and debrid settings.

## Provider updates and rollback

- The updater resolves the HEAD SHA with ETag caching, downloads only `posts`, `meta`, `stream`, and
  optional `episodes`/`settings` modules, validates the `@vega-provider`/`@vega-version` stamps and
  exports, then stages, fsyncs, and atomically activates the new snapshot.
- Providers that fail validation stay `pending` and keep their previous bundle. They are retried on
  the next cycle even when the HEAD SHA is unchanged.
- The active and previous snapshots are kept on disk. Older snapshots are removed.
- Manual update: `docker exec vega-addon node dist/cli/update.js`.
- Pin or roll back: set `PROVIDER_SHA=<sha>` and restart, or run the CLI with that variable.

## Media proxy

The proxy is off by default. When enabled it exposes `/proxy/<token>` where the token is a
base64url JSON payload plus an HMAC-SHA256 signature. It forwards `Range`/`If-Range`, streams
`200`/`206` responses, rewrites HLS playlists (segments, keys, maps, variants) through the proxy,
enforces DNS-based SSRF checks on every redirect, and rejects non-HTTP(S) targets. Set
`PUBLIC_BASE_URL` when the addon is behind a reverse proxy.

## Data layout

```
/data/
  providers/<owner>/state.json
  providers/<owner>/<sha>/manifest.json
  providers/<owner>/<sha>/urls.json
  providers/<owner>/<sha>/<provider>/{posts,meta,stream,episodes,settings}.js
  kv.json
  cookies.json
  provider-settings.json   (mounted, optional)
  update.lock
```

All state writes are atomic (temp file, fsync, rename). Provider module paths include the SHA, so a
new snapshot is a new `require` path and in-flight requests keep using the previous bundle.

## Development

```bash
npm ci
npm run dev        # tsx watch
npm test           # 200+ Vitest tests
npm run typecheck
npm run build
```

Tests use local fixture HTTP servers and in-memory provider bundles; no network is required.

## Security and limitations

- Upstream provider JavaScript is fetched automatically and executed in-process with Node
  privileges. The app runs as the unprivileged `node` user (the entrypoint briefly starts as root
  to fix disk ownership, then drops privileges), but this is not a sandbox. Trust the upstream
  repository before running.
- `curl-cffi-node` is an optional dependency used for Chrome TLS impersonation. If its native
  binding cannot load (for example on some non-glibc or unsupported hosts), the addon falls back to
  native `fetch`/axios; Cloudflare-protected providers are then less reliable.
- Providers that require an interactive WAF challenge fail with `WAF_REQUIRED`; supplying a
  `cf_clearance` cookie in `provider-settings.json` may help some sites.
- Torrentio returns magnets without a debrid key. Magnets are filtered unless `INCLUDE_MAGNETS=true`.
- Provider sites change often. Failures are isolated per provider, logged, and retried on later requests.
- Upstream has no `LICENSE` file (`package.json` says ISC). Review licensing before distributing a
  public image.
