# Todo: cache stream responses with split TTLs

Status: implemented.

## Implemented

- Complete, non-aborted responses use `STREAM_CACHE_TTL_MS`.
- Responses truncated by the settle timer or global deadline, plus empty results,
  use `STREAM_PARTIAL_CACHE_TTL_MS` (default 30 s).
- Fully aborted requests are not cached.
- `deploy/beamup.env` disables `SETTLE_MS` and `EMPTY_FENCE_MS`, so uncached
  requests run until providers finish or `GLOBAL_DEADLINE_MS` is reached.
