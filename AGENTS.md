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

- The active public deployment is Beamup (`baby-beamup.club`): `https://a38b6dd4fcd1-vega-stremio-addon-docker.baby-beamup.club/manifest.json`. Pushes to GitHub `main` run CI and then deploy via `.github/workflows/ci.yml` once `verify` and `docker` pass. The deploy job force-pushes to the Beamup remote using `BEAMUP_SSH_PRIVATE_KEY` (and optional `BEAMUP_KNOWN_HOSTS`/`BEAMUP_REMOTE`) repository secrets; never commit the key. `beamup.json` is local deploy state (`projectName`, `lastCommit`) and must stay untracked.
- Beamup env survives normal redeploys but is deleted with the app. Non-secret settings are committed in `deploy/beamup.env`, copied into the image, and sourced by `docker-entrypoint.sh` at every start, so they survive deletion/redeploys and override Beamup app env for the keys they contain. Secret settings (`PROVIDER_SETTINGS_JSON`, `PROXY_SECRET`, etc.) belong in the `BEAMUP_EXTRA_ENV` repository secret as newline-separated `KEY=value` lines; CI applies them with `scripts/apply-beamup-env.sh`, which sets each changed key individually because Beamup accepts only one `KEY=value` per `config:set`; never commit secrets.
- Manual deploy fallback (verified 2026-11-04): `npx beamup-cli config a.baby-beamup.club <github-user>` writes `/root/beamup-config.json`; `npx beamup-cli init <project-name>` writes `beamup.json` (it may warn that the `beamup` remote already exists, which is harmless); then `git push beamup HEAD:master --force`. Apply secrets with `./scripts/apply-beamup-env.sh`; non-secret `deploy/beamup.env` values load at container start. Beamup accepts only one `KEY=value` per `config:set`. Beamup syncs account-level GitHub SSH keys, not repository deploy keys. After the push, Beamup takes about 60 s to swap containers: verify `/configure` contains the expected controls and make one stream request before reporting success.
- Push code to GitHub with `git push origin main`. Use `[skip ci]` in the commit message for docs-only changes; they do not require a Beamup redeploy.
- Deployed timeouts live in `deploy/beamup.env` (currently search 5 s, meta 8 s, stream 8 s, global 10 s, settle 4 s, concurrency 40). Beamup's proxy returned 504 at 17-19 s wall time with a 20 s global deadline, so keep `GLOBAL_DEADLINE_MS` at 10 s or less; per-provider budgets above the global deadline are clamped to the remaining budget.
- Beamup deploys this repo's `Dockerfile`. The project name **must contain `docker`**; otherwise Beamup injects the Herokuish `command: /start web`, causing `exec: "/start": stat /start: no such file or directory` and a 504.
- Beamup mounts no persistent volume for this app: `/data` is ephemeral, so use `PROVIDER_SETTINGS_JSON`. Swarm limits are 1.2 CPU / 1 GB RAM; 20 addons per GitHub user. Bootstrap can delay listening up to 60 s, and cold proxied requests may 504.
- Beamup has no published AUP. Bans are manual/report-driven and keyed to the hashed GitHub username (SSH key removed; deploy/config/logs/delete blocked). This addon aggregates third-party streaming links, so hosting it on Stremio's PaaS is a copyright/platform risk. Do not add multi-account or ban-evasion logic.
