# AGENTS.md

This file provides guidance to the AI agent when working with code in this repository.

## Project

Self-hosted Stremio stream addon (Node >= 22, ESM TypeScript, Express). Provider JavaScript is downloaded from `Zenda-Cross/vega-providers` at runtime and executed in-process — there is no sandbox and no admin API. Configuration is environment-only, validated by zod in `src/config.ts`.

## Commands

- Verify changes: `npm run typecheck && npm test && npm run build`.
- `typecheck` only covers `src/`; `tests/` are excluded in `tsconfig.json`, so Vitest is the only check for test files.
- Tests require no network: they use local fixture HTTP servers and in-memory provider bundles.
- `npm run update` runs `dist/cli/update.js`; build first.
- Local run: `DATA_DIR=./data node dist/index.js` — `DATA_DIR` defaults to `/data`.

CI (`.github/workflows/ci.yml`) runs typecheck, tests, build, and a Docker build on PRs and pushes to `main`.

## Gotchas

- NodeNext ESM: relative imports need `.js` extensions, in tests too (`../src/foo.js`).
- `src/providers/sdk/context.ts` replaces `globalThis.fetch` with the provider-facing shim. Internal HTTP (GitHub, Cinemeta, updater, proxy) must use `nativeFetch` from `src/util/nativeFetch.ts`; using global `fetch` there recurses through the shim.
- Provider snapshots are immutable and SHA-versioned; requests hold refcounted registry leases and retired snapshots stay loaded until leases drain (or 10 minutes). Never mutate bundles or snapshots in place.
- Fetches of upstream `urls.json` are served from the active snapshot; activation clears the provider URL cache.
- Addon routes always return HTTP 200 JSON, using `{"streams":[]}` for bad IDs and provider failures; `/stream` and `/health` stay `no-store`.
- Persisted JSON writes must remain atomic (temp + fsync + rename via `src/util/fs.ts`).
- Logging is structured JSON with key-based redaction; never log or commit `PROXY_SECRET`, `GITHUB_TOKEN`, debrid keys, or cookies.
- There is no lint or format script; don't assume ESLint/Prettier.

## Deployment

Pushes to `main` auto-deploy to Render (`render.yaml` uses a persistent disk; `render-free.yaml` uses ephemeral `/tmp/data`). Keep `main` green.
