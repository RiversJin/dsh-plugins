# DSH Plugins

A pnpm workspace containing independently packaged plugins for DeepSeek Harness.

## Packages

- `dsh-context-milestones`: durable model-visible context usage and model-switch notices.
- `dsh-http-gzip`: negotiated Brotli, Zstandard, and gzip compression for DSH Web responses.
- `dsh-session-id`: display and copy session IDs in the DSH Web sidebar.
- `dsh-subagent-route`: allowlisted per-call model routing for continuable fork subagents.

Each directory under `packages/` is a standalone DSH plugin with its own package name, version, tests, and release boundary. The repository-level commands run the corresponding scripts across every package that defines them:

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

