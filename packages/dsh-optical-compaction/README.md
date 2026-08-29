# dsh-optical-compaction

OMP Snapcompact port for vision-capable DeepSeek Harness models.

This package ports `@oh-my-pi/snapcompact` 18.0.10 from OMP commit [`33cc6b9a043a74e00a157e72ca909272796d8461`](https://github.com/can1357/oh-my-pi/commit/33cc6b9a043a74e00a157e72ca909272796d8461). It uses OMP's native pixel-font renderer, normalization rules, provider/model-aware shapes, foveated archive layout, text-edge preservation, serialization caps, data-URL healing, frame budgets, and cross-compaction source unfolding.

The DSH adapter is deliberately narrow:

- DSH content blocks are translated into OMP's message vocabulary.
- OMP PNG frames are committed through `ctx.attachments` and placed in the normal DSH compaction checkpoint.
- OMP's kept archive source is stored in the checkpoint's durable, non-model-facing `rawOutput`, then unfolded and re-rendered on the next Snapcompact pass.
- OMP's platform N-API package is loaded directly under Node; the renderer and embedded fonts are unchanged.

The OMP port remains intact, with two DSH-side selection policies: a model-context guard that falls back to semantic compaction when images stop reducing context, and a timestamp-aware resolution-decay window for older optical pages.

## Behavior

The selected old history is serialized locally. Per-tool-result, per-argument, and per-call caps keep noisy payloads bounded with explicit head/tail elision. ANSI and whitespace are normalized, semantic emoji are folded, supported Unicode is preserved through OMP's Silver fallback, and base64 data URLs are replaced atomically before any slicing.

With `optical.memoryDecay` enabled (the default), the complete newest time period remains verbatim plain text and only older transcript is rendered into timestamp buckets. The default period is 12 hours: older glyph resolution steps through 90%, 81%, 72.9%, and so on down to a 50% floor. The raster canvas also shrinks, but more slowly than the glyph cells, so older periods become denser and need fewer pages while remaining genuinely lower-resolution. If the age-derived pages still exceed the information-selected working set, source-volume pressure lowers old-page resolution again, smoothly, down to the same floor. No Gaussian or other blur filter is applied.

The model's source-token estimate first chooses how many pages the pass may use: one page per 16,000 effective tokens by default, capped by the configured, transport, and reader limits. Those pages are then shared across occupied age buckets with a diminishing-return weight of `sqrt(bucket characters) * resolution scale`. Dense periods receive more room, newer periods win otherwise-equal choices, and one enormous tool trace cannot linearly monopolize the archive. Within a partially retained bucket, its newest pages survive. A later payload overflow retires one continuous oldest prefix from the planned working set. The persisted re-render source always matches the visible frames. If payload fitting retires every older visual page, the adapter uses semantic compaction instead.

Decay is lazy: no timer rewrites an idle session. DSH event timestamps, normalized source segments, and cumulative pre-visual information tokens are persisted in the checkpoint's non-model-facing `rawOutput`; whenever that session compacts again, all retained optical pages are re-rendered at their then-current age. The cumulative counter prevents an already-compressed request from being mistaken for a genuinely smaller history and collapsing 8 pages to 2 and then 1 merely because compaction ran again. Legacy archives derive this counter once from their readable and retired character counts. Disabling `memoryDecay` restores OMP's original plain-text edges and HQ/LQ/HQ foveated middle.

The active route must declare image input. A text-only route uses the configured semantic fallback. Before committing frames, the adapter estimates the model-context occupancy of both the selected source and the complete optical checkpoint with OMP's provider-aware, height-aware image-token rules plus DSH's text estimator. Any strictly smaller optical checkpoint is kept; if it is equal to or larger than the source, optical compaction has stopped freeing context and the adapter uses the same semantic fallback without saving the candidate frames. This is a context-capacity guard, not a price optimizer. DSH's basic engine still performs its final local shrink check. Original conversational image blocks are not copied into the archived transcript, matching OMP serialization; images in the recent retained tail remain untouched.

## DSH host boundaries

Two OMP inputs have no equivalent in the current DSH compaction and attachment contracts:

- `SummarizationInput` contains the replayed system prompt, tools, and messages, but no canonical file-operation ledger. The adapter therefore passes an empty OMP `fileOps` set instead of guessing paths from tool names or prose. Snapcompact's file-list appendix stays empty; the tool calls and results themselves are still archived.
- DSH image blocks contain a durable attachment reference but no per-message resolution hint. OMP's OpenAI `detail: "original"` hint cannot survive attachment materialization, so the active DSH provider adapter owns request-image sizing. Kimi has no OMP-evaluated model shape and remains on OMP's unknown-model safety default, which does not carry this OpenAI-only hint.

Both are explicit host limitations, not alternate compression policy. Adding either requires a DSH contract change rather than a heuristic inside this port.

## Install

```sh
dsh plugin --profile web add file:/home/rivers/projects/dsh-plugins/packages/dsh-optical-compaction
```

The bundle row is disabled by default. Mount the plugin explicitly inside an agent preset's isolated `compaction` realm:

```yaml
- id: optical-compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
  config:
    - id: dsh-optical-compaction
      name: dsh-optical-compaction
      config:
        thresholdRatio: 0.60
        retainRatio: 0.16
        summarizationProvider: qwen38-local
        summarizationModel: Qwen3.8-27B/Qwen3.8-27B-UD-Q4_K_XL.gguf
        maxTokens: 8192
        optical:
          enabled: true
          shape: auto
          maxFrames: 80
          # Kimi-specific payload headroom; the engine's effective page cap is 8.
          maxFrameDataBytes: 8000000
          toolResultMaxChars: 2000
          toolArgumentMaxChars: 500
          toolCallMaxChars: 2000
          truncateHeadRatio: 0.6
          dimToolResults: true
          includeReasoning: true
          memoryDecay:
            enabled: true
            periodHours: 12
            scalePerPeriod: 0.9
            minScale: 0.5
            informationTokensPerFrame: 16000
```

Do not mount another compaction backend in the same isolated realm.

## Configuration

- `thresholdRatio`, retention, retry, `maxTokens`, and `auto` keep `@deepseek-ai/dsh-compaction-basic` semantics.
- `summarizationProvider` and `summarizationModel` select the text-only/disabled fallback route. Omit both to use the conversation route.
- Source images and candidate frames use the same provider context-token formula; partial-height PNG frames are measured by their actual dimensions. Visual compaction remains selected for every strict reduction and falls back to semantics only when it no longer frees context.
- `optical.shape` is `auto` or one of OMP's exported shape variant names.
- `optical.maxFrames` defaults to OMP's 80-frame ceiling and is further capped by DSH's per-message attachment limit. Kimi is additionally capped at eight dense transcript frames: the 1M K3 route could afford 20 in token space and accepted the wire request, but failed real recall at that visual scanning load. The actual working set is dynamic from one page up to that ceiling.
- `optical.maxFrameDataBytes` defaults to OMP's 3,000,000-byte standing payload budget. If the rendered archive exceeds it, one oldest chronological frame prefix is retired during planning; the stored source and visible checkpoint always agree.
- The three tool caps, `truncateHeadRatio`, `dimToolResults`, and `includeReasoning` map directly to OMP serialization options. Claude-family targets always exclude replayed reasoning, matching OMP's host integration.
- `optical.memoryDecay` defaults to a lazy 12-hour sliding window. The newest period stays entirely as text. `scalePerPeriod` defaults to `0.9`, `minScale` to `0.5`, and `informationTokensPerFrame` to `16000`. Time controls the fidelity preference; normalized source volume controls page count, weighted allocation, and any additional density pressure. Set `enabled: false` to retain OMP's original foveated layout.

## Development

```sh
pnpm install
pnpm test
pnpm pack --dry-run
```

`scripts/live-smoke.mjs` exercises a real DSH `/compact` and vision recall. It requires an isolated preset that mounts this plugin; pass its id as `DSH_AGENT_PRESET`. The inexpensive test reader defaults to `kimi-coding/k3-256k` and can be overridden with `DSH_PROVIDER` and `DSH_MODEL`; runtime selection and context accounting always follow the conversation's actual model, including the normal 1M-context K3 route.

Node.js 22.19 or newer is required. See [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) for OMP attribution.
