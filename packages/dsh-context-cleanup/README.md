# dsh-context-cleanup

Independent, model-free cleanup for DSH 0.1.7-rc.2. No auxiliary dependency.

After **5 hours without a completed conversation turn**, the next turn:

- Prunes large tool outputs using the preset's native `toolResultPruner`, protecting the last **2 completed turns**. There is **no minimum token-savings gate**. Native character budgets and rich-block handling still apply.
- Removes previous memory recall injections, including old removal notices. The memory plugin's independent **6-hour expiry** remains enabled.
- Removes old time-context snapshots and keeps the latest one (including a newly prepared snapshot).

Native pressure/manual tool pruning also schedules old-clock cleanup before the next model request. All text, optical, and fallback summarization inputs exclude recall and time snapshots; snapshots retained outside a compacted range are removed before the next request too.

Cleanup appends native prune/replacement records. Empty developer replacements do not appear in model messages. These replacements happen inside the first open step, before request admission, so original raw logs remain intact and strict native replay works. Human-authored dates and quoted text are never matched by content.

This is a next-turn idle check, **not a background timer**. A system prompt section discloses the lifecycle to the model. Configure the builtin `time-context` separately with `refreshIntervalMs: 1800000` for 30-minute refreshes.

Requires the local `compaction/summarize-input` hook in `@deepseek-ai/dsh-compaction-basic` (also used by memory recall filtering). Plugin sources use native query observations, not deprecated synchronous log reads.

```sh
pnpm --filter dsh-context-cleanup test
```
