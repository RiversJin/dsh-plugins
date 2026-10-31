# DSH Plugins

A pnpm workspace containing independently packaged plugins for DeepSeek Harness.

## Packages

- `@riversjin/dsh-trajectory`: model-directed single-anchor trajectory summaries, durable raw archives, and automatic review anchors.
- `@riversjin/dsh-dream-context`: nightly memory consolidation (daily summaries, long-term memories, progressive-forgetting context rebuild) and daytime `experience_*` tools.
- `@riversjin/dsh-tick-template`: model-authored templates rendered into `time_passing` notifications at delivery.
- `@riversjin/dsh-kimi-auto`: automatic k3 / k3-256k tier selection and compaction pressure targets.
- `@riversjin/dsh-optical-compaction`: OMP-compatible bitmap context compaction with semantic fallback and time-aware resolution decay.
- `@riversjin/dsh-context-milestones`: durable model-visible context usage and model-switch notices.
- `@riversjin/dsh-context-cleanup`: 12-hour cold-session cleanup of tool outputs, memory recall and time snapshots.
- `@riversjin/dsh-retry`: whole-turn retry.
- `@riversjin/dsh-subagent-route`: allowlisted per-call model routing for subagent activations.
- `@riversjin/dsh-projection-cache`: session projection cache.
- `@riversjin/dsh-http-gzip`: negotiated Brotli, Zstandard, and gzip compression for DSH Web responses.
- `@riversjin/dsh-session-id`: display and copy session IDs in the DSH Web sidebar.

All packages target DSH `>=0.2.1-rc.5 <0.3.0` on the patched runtime described in [kit/README.md](kit/README.md); `dream-context`, `tick-template` and `context-cleanup` need the patched `dsh-schedule`. The plugin identifiers used inside session logs (`plugin:dsh-*`) are unchanged by the npm scope.

## Distribution kit

`kit/` holds the runtime recipe, a profile template and `install.sh`; `scripts/pack-kit.sh --extra <dir>` builds and packs every package into `kit/packages/`. See [kit/README.md](kit/README.md) (Chinese).


Each directory under `packages/` is a standalone DSH plugin with its own package name, version, tests, and release boundary. The repository-level commands run the corresponding scripts across every package that defines them:

All maintained source is strict TypeScript. Packages publish compiled ESM and
declaration files from `lib/`; DSH never depends on unchecked source files.

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```
