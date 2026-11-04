# Vega Streams - Stremio Addon

Self-hosted Stremio addon that serves movie and series streams from the 39 enabled providers in
[`Zenda-Cross/vega-providers`](https://github.com/Zenda-Cross/vega-providers).

- Streams only, IMDb IDs only (`tt...`), movie and series.
- Provider code is downloaded from GitHub at runtime and executed in-process.
- Upstream is checked every 4-6 hours and new provider bundles are hot-swapped without a restart.
- Direct links are returned with the HTTP headers players need; an optional signed proxy is included.
- Per-user filters (resolution, file size, subtitle languages) are encoded in the add-on URL; nothing is stored server-side.
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

## Deployment

The active public deployment runs on **Beamup**:
`https://a38b6dd4fcd1-vega-stremio-addon-docker.baby-beamup.club/manifest.json`.

Pushes to `main` run CI and, after typecheck, tests, build, and the Docker build pass, deploy to
Beamup automatically. Configure these repository secrets once:

| Secret | Required | Value |
|---|---|---|
| `BEAMUP_SSH_PRIVATE_KEY` | yes | Private half of a dedicated SSH key |
| `BEAMUP_KNOWN_HOSTS` | no | Pinned `a.baby-beamup.club` host key |
| `BEAMUP_REMOTE` | no | Override the Dokku remote (defaults to this app) |

```bash
ssh-keygen -t ed25519 -C "github-actions-beamup" -f beamup_deploy -N ""
gh ssh-key add beamup_deploy.pub --title "GitHub Actions Beamup deploy"
gh secret set BEAMUP_SSH_PRIVATE_KEY < beamup_deploy
ssh-keyscan a.baby-beamup.club | gh secret set BEAMUP_KNOWN_HOSTS
rm beamup_deploy
```

Beamup syncs account-level GitHub SSH keys, not per-repository deploy keys, so the public key must
be added to the GitHub account. Keep the private key only in the encrypted repository secret and
never commit it. When `BEAMUP_KNOWN_HOSTS` is unset, the workflow falls back to `ssh-keyscan`.

## Deploy to Beamup (active deployment)

Beamup is Stremio's own addon PaaS (`baby-beamup.club`). The active Docker deployment is
`https://a38b6dd4fcd1-vega-stremio-addon-docker.baby-beamup.club/manifest.json`.

Beamup identifies users by GitHub username and deploys over SSH/Dokku. For Dockerfile apps the
project name **must contain `docker`**: without it Beamup configures the swarm service with
`command: /start web` (the Herokuish entrypoint), and the container fails with
`exec: "/start": stat /start: no such file or directory` while the proxy returns 504. This repo's
`beamup.json` therefore uses `"projectName": "vega-stremio-addon-docker"`.

1. Add an account-level SSH key to the GitHub user Beamup will authenticate:
   ```bash
   ssh-keygen -t ed25519 -C beamup-vega-stremio-addon
   # Add ~/.ssh/id_ed25519.pub at GitHub Settings > SSH and GPG keys
   ```
2. Configure and initialize the CLI (tested with `beamup-cli` 1.3.2 via `npx`):
   ```bash
   npx beamup-cli config   # host: a.baby-beamup.club, GitHub username: <user>
   npx beamup-cli init     # writes beamup.json and adds the beamup git remote
   ```
   Keep `beamup.json` local; it contains deploy state (`lastCommit`) and is not needed by the image.
3. Deploy the current commit:
   ```bash
   git push beamup HEAD:master --force
   ```
4. Set environment variables (the CLI can prompt, or use Dokku directly):
   ```bash
   ssh dokku@a.baby-beamup.club config:set <hash>/vega-stremio-addon-docker \
     LOG_LEVEL=info PROXY_ENABLED=false INCLUDE_MAGNETS=false \
     SEARCH_CONCURRENCY=16 GLOBAL_DEADLINE_MS=8000 SEARCH_TIMEOUT_MS=4000 \
     STREAM_TIMEOUT_MS=6000 SETTLE_MS=4000 EMPTY_FENCE_MS=0 \
     UPDATE_INTERVAL_MIN_HOURS=4 UPDATE_INTERVAL_MAX_HOURS=6
   ```
   `<hash>` is the per-user path in the `beamup` remote, for example
   `dokku@a.baby-beamup.club:a38b6dd4fcd1/vega-stremio-addon-docker`.

Beamup notes:

- No persistent disk is mounted: `/data` is container-local, so a redeploy (or a restart that
  recreates the container) re-downloads the provider snapshot and loses KV, cookies, and settings.
  Use `PROVIDER_SETTINGS_JSON` for persistent settings. The server binds only after bootstrap (up to
  60 s), so requests immediately after a deploy can be sparse or return 504.
- The swarm service is limited to 1.2 CPU and 1 GB RAM, restarts at most 10 times per 5 minutes
  with a 60 s delay, and each GitHub user can have at most 20 addons.
- Beamup's nginx proxy is configured to cache `200`/`302` responses for 2 h (subject to the
  response's cache headers) and serves stale responses on upstream errors. `/stream` and `/health`
  send `Cache-Control: no-store`; warm requests still return more streams because the addon's
  in-memory caches and upstream providers have warmed up.
- Provider updates keep the normal 4-6 h schedule plus 0-120 s jitter; a fresh deploy bootstraps
  because `UPDATE_ON_START` defaults to `true`.
- Beamup has no published acceptable-use policy. Enforcement is manual and report-driven: a ban
  removes the hashed GitHub username's SSH key and blocks further deploy, config, log, and delete
  commands. This addon aggregates third-party streaming links, so hosting it on Stremio's PaaS
  carries copyright and platform risk; Stremio's terms make addon developers responsible for the
  content they distribute. Self-hosting avoids that platform risk.

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

Open `/configure` to choose a maximum and/or minimum resolution, a maximum file size, whether
streams with unknown resolution or size are included (default: included), and which subtitle
languages to keep. The page builds a personalized add-on URL of the form
`https://<host>/<config>/manifest.json`, where `<config>` is a base64url-encoded JSON document such
as `{"v":1,"maxRes":720}`, `{"v":1,"maxSizeMB":2048}`, or
`{"v":1,"subtitleLangs":["en","pt"]}`. Filters travel in the URL: nothing is stored server-side, so
installs keep working across restarts, redeploys, and free-tier cold starts. Invalid config segments
fall back to unfiltered defaults.

Resolution is inferred from provider quality tags, stream titles, and stream URLs. Streams whose
resolution cannot be determined are kept unless the "include unknown resolution" checkbox is
cleared. File size is heuristic: it is parsed from human-readable values such as `656 MB` or
`1.29 GB` in stream titles (speeds like `1.5 MB/s` are ignored), because many providers do not
report size. Streams without a parseable size are kept unless the "include unknown file size"
checkbox is cleared. When subtitle languages are selected, each stream keeps only matching tracks
(region variants such as `pt-BR` match `pt`) and streams with no matching tracks are still returned
without subtitles. Leaving the field blank keeps all subtitles. Installing the plain
`/manifest.json` URL remains supported and returns unfiltered streams. In Stremio, the add-on's
gear icon opens the configure page with the current settings pre-filled.

## Response time

Requests stop early instead of always burning the full `GLOBAL_DEADLINE_MS`:

- `SETTLE_MS` (default `8000`): after at least one stream is collected, the request finishes when
  no new stream arrives for this long. Slow or dead providers no longer block the response.
- `EMPTY_FENCE_MS` (default `0`, disabled): with no streams collected, finish after this long
  instead of waiting for the global deadline. Keep this disabled on slow hosts: series providers
  often need more than 25 s to return their first stream, and an early fence makes every series
  request look empty.

Both guards are disabled with `0`; the global deadline remains the absolute cap. On Beamup, cold
starts (30-60 s) dominate the first request; a keep-warm ping every ~10 minutes avoids most of that
cost.

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
| `DISABLED_PROVIDERS` | empty | Comma-separated provider values to skip at stream time (they still install and update) |
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
- On Beamup or other ephemeral platforms, set `PROVIDER_SETTINGS_JSON` to the same JSON object; it
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

Set `DISABLED_PROVIDERS=torrentio,internetArchive,youtube` to stop those providers from being
queried for streams. Disabled providers are still downloaded, installed, and kept current by the
normal update schedule; only stream requests skip them. Values are the upstream `value` field and
are matched case-insensitively.

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

## DMCA

We hereby issue this notice to inform you that these extensions just function like an ordinary
browser (like your browser) that fetch video files from internet, and do not violate the provisions
of the Digital Millennium Copyright Act (DMCA). The Content these extensions may access is not
hosted by us or the Cloudstream 3 application but the websites they are browsing in their autonomous
mode. It is sole responsibility of the user and his/her countries' or states' law. If you think they
are violating any intellectual property then please contact the actual file hosts not the owners of
this repository or the CloudStream 3 app. Thank You.
