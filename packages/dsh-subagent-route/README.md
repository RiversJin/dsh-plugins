# dsh-subagent-route

A small DeepSeek Harness agent-plane tool that replaces one configured
`subagent_fork` instance with an allowlisted, model-selectable LLM route.

The provider remains DSH's official `fork` backend. The plugin only validates
the model-facing `route` value and maps it to `agentOptions`, preserving the
official child composition, lineage, permission, continuation, and disposal
paths.

Omitting `route` inherits the parent's LLM route. Configured route names map to
fixed provider/model pairs; arbitrary provider or model strings are never
accepted from the model.
