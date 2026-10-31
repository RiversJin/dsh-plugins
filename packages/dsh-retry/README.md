# dsh-retry

Whole-turn retry for DeepSeek Harness 0.1.7-rc.2.

The Web ↻ button and `/retry` restart the latest user request in the same
session. The original user content and attachments enter the native input
queue again. No instruction asking the model to retry, ignore an answer, or
conceal a retry is added. Tools execute again normally; no `force` flag is
required. The old spelling `/retry force` remains an equivalent alias.

At the first admitted replay step, an empty native developer replacement
retracts the superseded request and its outputs from the model surface.
DSH omits that empty marker from model messages. The Web view hides the old
turn, including tool activity, and displays the replay in its place. Original
append-only history is retained for diagnostics and cold restoration.

Human steering received during the original turn is replayed in order with
the opening request. An idle session with queued new input must finish or
clear that input before retrying. If replay is rejected before admission,
the old answer remains active. A failure before the original request was
admitted recovers its input from the durable inbox instead of accidentally
retrying an earlier question.

`npm test` uses a real native Agent loop with a fake model adapter. It checks
provider-visible requests, repeated tool execution, attachments, stale targets,
failed admission, rejected steps, pending input, and strict native cold restore.
No external model or production service is used by those tests.

Provider transport-error retries from `@deepseek-ai/dsh-llm-retry` remain
independent of this explicit whole-turn retry action.
