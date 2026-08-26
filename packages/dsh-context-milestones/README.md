# dsh-context-milestones

A small DSH agent-plane plugin that injects durable, model-visible notices when
a conversation reaches another configured context percentage or its selected
provider/model changes.

The notice is a plugin-sourced `user/message`, not user-authored input. It is
evaluated on the first step of each turn, includes pending model-visible
messages in the estimate, and starts a new milestone cycle after successful
summarizing compaction. A model-switch notice is emitted only when the selected
provider/model differs from the last completed request; initial and resumed
requests on the same route stay silent. Mount it from an agent preset to limit
its scope to that preset.

```yaml
- id: context-milestones
  name: dsh-context-milestones
  config:
    stepPercent: 5
    modelSwitchNotice: true
```
