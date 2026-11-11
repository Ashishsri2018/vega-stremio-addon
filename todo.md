# Tasks & Roadmap

## Implemented

- [x] Detect web pages, HTML embeds, Telegram links, and compressed archives (`.zip`, `.rar`, etc.) in `src/pipeline/urlClassifier.ts`.
- [x] Map web pages and compressed files to `externalUrl` (omitting `url`, `proxyHeaders`, and `subtitles`).
- [x] Drop anti-bot blocker links (`/slowdown`) at ingestion.
- [x] Prioritize direct video streams before external web links in `sortStreams`.
- [x] Canonical same-file URL deduplication (`normalizeStreamKey`) stripping fragments, trailing slashes, and host casing.
- [x] Increase per-provider limit from 20 to 100 (`MAX_STREAMS_PER_PROVIDER = 100`, `DEFAULT_PER_PROVIDER_LIMIT = 100`, `MAX_LINKS_PER_PROVIDER = 100`, `MAX_STREAM_CALLS_PER_REQUEST = 120`).
- [x] Increase total stream limit from 200 to 1000 (`MAX_TOTAL_STREAMS = 1000`).
- [x] Add unit tests in `tests/mapping.test.ts` and update `tests/pipeline.test.ts`.
- [x] Cache stream responses with split TTLs (complete vs partial).
- [x] Deploy to Beamup via GitHub Actions and verify live endpoints (`/manifest.json`, `/health`, `/stream/...`).
