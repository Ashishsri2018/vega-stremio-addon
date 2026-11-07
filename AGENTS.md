# AGENTS.md

This file provides guidance to the AI agent when working with code in this repository.

## Project

Self-hosted Stremio stream addon (Node >= 22, ESM TypeScript, Express). Provider JavaScript is downloaded from `Zenda-Cross/vega-providers` at runtime and executed in-process — there is no sandbox and no admin API. Configuration is environment-only, validated by zod in `src/config.ts`.

Official Vega app source is checked out at `/root/iptv/vega-app` (`https://github.com/vega-org/vega-app`). Consult it when comparing provider invocation, sandbox, timeout, or rate-limit behavior; it is a React Native app and is not part of this addon.

## Commands

- Verify changes: `npm run typecheck && npm test && npm run build`.
- `typecheck` only covers `src/`; `tests/` are excluded in `tsconfig.json`, so Vitest is the only check for test files.
- Tests require no network: they use local fixture HTTP servers and in-memory provider bundles.
- `npm run update` runs `dist/cli/update.js`; build first.
- `npm run probe -- <query>` runs per-provider search/meta/stream diagnostics (`--search-only`, `--json`); build first.
- Local run: `DATA_DIR=./data node dist/index.js` — `DATA_DIR` defaults to `/data`.

CI (`.github/workflows/ci.yml`) runs typecheck, tests, build, and a Docker build on PRs and pushes to `main`; pushes to `main` also deploy to Beamup after those jobs pass.

## Gotchas

- NodeNext ESM: relative imports need `.js` extensions, in tests too (`../src/foo.js`).
- `src/providers/sdk/context.ts` replaces `globalThis.fetch` with the provider-facing shim. Internal HTTP (GitHub, Cinemeta, updater, proxy) must use `nativeFetch` from `src/util/nativeFetch.ts`; using global `fetch` there recurses through the shim.
- Provider snapshots are immutable and SHA-versioned; requests hold refcounted registry leases and retired snapshots stay loaded until leases drain (or 10 minutes). Never mutate bundles or snapshots in place.
- Fetches of upstream `urls.json` are served from the active snapshot; activation clears the provider URL cache.
- Addon routes always return HTTP 200 JSON, using `{"streams":[]}` for bad IDs and provider failures; `/stream` and `/health` stay `no-store`. `/configure` is the only HTML route; per-user filters are a base64url URL segment (`/<config>/manifest.json`, parsed in `src/addon/userConfig.ts`) and invalid segments fall back to unfiltered defaults.
- Persisted JSON writes must remain atomic (temp + fsync + rename via `src/util/fs.ts`).
- Logging is structured JSON with key-based redaction; never log or commit `PROXY_SECRET`, `GITHUB_TOKEN`, debrid keys, or cookies.
- There is no lint or format script; don't assume ESLint/Prettier.
- Invalid env values abort startup (zod in `src/config.ts`). On Beamup this surfaces as the pre-flight error "beamup-lint: ... is not a valid Stremio addon, refusing to deploy it"; reproduce locally with the same env and check the schema bounds (`SEARCH_CONCURRENCY` is 1-40).

## Deployment

- The active deployment is a private Beamup app. Its app name and URL live only in the required `BEAMUP_REMOTE` repository secret; never commit, log, or document them. Treat the manifest URL like a password. Pushes to GitHub `main` run CI and then deploy via `.github/workflows/ci.yml` once `verify` and `docker` pass. The deploy job force-pushes to `BEAMUP_REMOTE` using `BEAMUP_SSH_PRIVATE_KEY` and optional `BEAMUP_KNOWN_HOSTS`; it masks the remote and app name and sanitizes push output. `beamup.json` is local deploy state (`projectName`, `lastCommit`) and must stay untracked.
- Beamup env survives normal redeploys but is deleted with the app. Non-secret settings are committed in `deploy/beamup.env`, copied into the image, and sourced by `docker-entrypoint.sh` at every start, so they survive deletion/redeploys and override Beamup app env for the keys they contain. Secret settings (`PROVIDER_SETTINGS_JSON`, `PROXY_SECRET`, etc.) belong in the `BEAMUP_EXTRA_ENV` repository secret as newline-separated `KEY=value` lines; CI applies them with `scripts/apply-beamup-env.sh`, which sets each changed key individually because Beamup accepts only one `KEY=value` per `config:set`; never commit secrets.
- Manual deploy fallback (verified 2026-11-04): `npx beamup-cli config a.baby-beamup.club <github-user>` writes `/root/beamup-config.json`; a new app can be initialized with `npx beamup-cli init <project-name>`, which writes `beamup.json` and a local remote. Keep the project name, `beamup.json`, and any local remote untracked. Then `git push "$BEAMUP_REMOTE" HEAD:master --force`. Apply secrets with `BEAMUP_REMOTE=... ./scripts/apply-beamup-env.sh`; non-secret `deploy/beamup.env` values load at container start. Beamup accepts only one `KEY=value` per `config:set`, and its wrapper passes the value literally, so the script must not shell-quote it. Beamup syncs account-level GitHub SSH keys, not repository deploy keys. After the push, Beamup takes about 60 s to swap containers: verify `/configure` contains the expected controls and make one stream request before reporting success.
- Push code to GitHub with `git push origin main`. Use `[skip ci]` in the commit message for docs-only changes; they do not require a Beamup redeploy.
- Deployed timeouts live in `deploy/beamup.env` (currently search 5 s, meta 8 s, stream 8 s, global 10 s, settle disabled, empty fence disabled, concurrency 40). Beamup's proxy returned 504 at 17-19 s wall time with a 20 s global deadline, so keep `GLOBAL_DEADLINE_MS` at 10 s or less; per-provider budgets above the global deadline are clamped to the remaining budget. Deadline-truncated and empty stream results are cached for `STREAM_PARTIAL_CACHE_TTL_MS` (30 s on Beamup); complete results use `STREAM_CACHE_TTL_MS` (180 s).
- Beamup deploys this repo's `Dockerfile`. The project name **must contain `docker`**; otherwise Beamup injects the Herokuish `command: /start web`, causing `exec: "/start": stat /start: no such file or directory` and a 504. Docker builds without `--build-arg PROVIDER_SHA=<commit>` ship no provider code; with it, the image bakes a pinned snapshot that the entrypoint seeds into an empty `DATA_DIR`. CI's Docker job boots the image with `VEGA_ENV_FILE=/dev/null UPDATE_ON_START=false` and asserts `/health` answers.
- Beamup mounts no persistent volume for this app: `/data` is ephemeral, so use `PROVIDER_SETTINGS_JSON`. Swarm limits are 1.2 CPU / 1 GB RAM; 20 addons per GitHub user. The server binds before bootstrap; until a snapshot is active, stream requests return `{"streams":[]}`, `/health` is `degraded`, and cold proxied requests may 504.
- Beamup has no published AUP. Bans are manual/report-driven and keyed to the hashed GitHub username (SSH key removed; deploy/config/logs/delete blocked). This addon aggregates third-party streaming links, so hosting it on Stremio's PaaS is a copyright/platform risk. Do not add multi-account or ban-evasion logic.
