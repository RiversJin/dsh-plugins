# dsh-retry

In-place response regeneration for DeepSeek Harness.

The plugin adds `/retry` and a retry action beside the latest finalized Web
assistant message. Instead of forking, it uses DSH's append-only surface
replacement contract to remove the active request and its previous attempt
from future model requests, then schedules the same human request again in the
existing session.

The superseded answer is removed from the Web conversation and from future
model requests. DSH's low-level append-only event log is not rewritten; the
command lifecycle and replacement metadata remain available for diagnostics.

Only the latest active request can be retried. A request whose attempt invoked
tools is rejected by default because retry cannot undo external effects; an
explicit `/retry force` overrides that guard. The Web button never forces a
tool-bearing retry.

This is separate from `@deepseek-ai/dsh-llm-retry`, which already retries
eligible provider failures automatically.
