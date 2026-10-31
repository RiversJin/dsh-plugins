# dsh-kimi-auto

Automatic bidirectional routing for DSH conversations selecting `kimi-coding/k3` or `kimi-coding/k3-256k`. Other providers and the `kimi-for-coding` aliases retain their selected route.

The default promotion boundary is 253,952 prompt tokens: the 262,144-token small window minus 8,192 tokens of headroom (4,096 output reservation plus 4,096 estimation safety). Explicit larger output caps promote earlier. Once on `k3`, the conversation returns to `k3-256k` at or below 196,608 estimated prompt tokens. Server usage anchors, pending messages, new tool results, and prompt/tool changes contribute to the estimate. A provider-confirmed small-tier context overflow retries on `k3` once; timeouts, generic auth errors, and partially emitted output do not change the tier.

Both tiers render `{{model}}` as `k3`. Existing prompts without a model field gain no new text. Native model-selection notices are suppressed between these two tiers. Request headers and assistant history still record the physical model, while routing state persists as empty, non-model-facing developer metadata. Forks and restarts preserve the state. This does not rewrite archived events or change reasoning effort.

For pi-ai's Anthropic adapter, transport copies normalize only K3 replay identity so that the SDK preserves historical thinking signatures across tier changes. Install matching compatibility settings on the small catalog entry:

```yaml
- id: llm-pi-ai
  config:
    providers:
      kimi-coding:
        modelOverrides:
          k3-256k:
            compat:
              allowEmptySignature: true
```

Use the patched `dsh-compaction-basic` pressure-target hook so proactive compaction keeps the K3 family's 1,048,576-token capacity. If `dsh-context-milestones` is mounted, configure its equivalent model group:

```yaml
modelGroups:
  - provider: kimi-coding
    models: [k3, k3-256k]
    contextWindow: 1048576
```

`npm test` exercises policy boundaries, native agent admission and notices, strict session replay, fork/resume, overflow recovery, and real pi-ai HTTP payload equality including signed thinking and tool-result pairing. Wire tests use a local HTTP server and synthetic credentials.
