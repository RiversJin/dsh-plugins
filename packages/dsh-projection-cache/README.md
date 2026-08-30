# dsh-projection-cache

A drop-in replacement for DeepSeek Harness's persisted session projection
cache with a deployment policy for excluding selected projection keys.

The excluded projections still run live. When a cold session is opened, the
standard DSH restore ladder treats their missing rows as a cache miss and
rebuilds them from the authoritative session log. This package therefore
trades first-open latency for bounded cache memory without deleting chat data.

The bundled profile patch excludes `contextHeaders` and `contextTimeline`.
Those `dsh-context` UI projections dominated the JSON cache when many long
sessions were forked, while all lightweight list and session-stat projections
remain persisted.

This implementation follows the public API and fail-soft behavior of the
MIT-licensed `@deepseek-ai/dsh-session-projection-cache` package.
