# dsh-dream-context

面向 DSH 0.1.7-rc.2 的隔离试用版本。夜间形成和修订记忆；时间窗口决定什么时候改变历史的呈现方式。**2026-10-13 已按本人同意的边界完成影子部署；启用范围、验证结果及回退命令见 [DEPLOYMENT.md](DEPLOYMENT.md)。** 给本人审阅的完整说明见 [REVIEW.md](REVIEW.md)。

## 已实现的行为

- 默认 Asia/Singapore，每天 04:00 后安静满 10 分钟整理；重启后补做错过的夜晚。一天以 04:00 为界，跨界的完整轮次留到结束后再处理。
- 同一聊天模型、当前人格，使用原生 `buildForkSeed`/`Session.create` 从当前完整轮次边界分叉，直接用 fork 的 `deriveMessages()` 继续整理。保持已有 system、有效对话、图片、总结和工具记录，不重新拼人格或自动补回不可见的原文。只追加整理范围与挑选出的记忆。梦境可以按需调用 `experience_search`、`experience_read` 和梦境只读版 `trajectory_read`，查阅后继续整理；读取不打开锚点，也不需要 compact/release。分支不注册到宿主，QQ、日程和旧记忆捕获都收不到整理过程。模型的思考与适配器续接状态仅在本次多步请求期间保留，归档不保存新生成的私有思考。
- 每晚从相关记忆、到期复查记忆和少量随机旧记忆中选择材料，随机池包含休眠记忆；不会携带全部记忆目录。默认随机抽 3 条，避开一天内刚复查的条目。有到期事项但没有新经历时也可以只复查；没有新经历也没有到期事项时跳过模型请求。
- 模型自己写当天总结，以及可新增、修订、退出自动召回的记忆。更新沿用原 ID；省略表示语义不改。成功呈现的条目记录复查时间；默认 7 天后再看，模型可用 `reviewAfterDays` 指定 1～90 天，复查期限不是自动休眠期限。记忆带经历证据、版本和原始日期。旧版本仅保存在不可变对象里，不参加正常检索。
- 默认日龄小于 2 天保留当前文字原文；第 2～6 日对同一份当前可见材料比较文字版与图片版的预计输入 token，图片严格更少才选图片，相等时保留文字；第 7～20 日呈现为自写总结，第 21 日起退出常驻上下文。总结写成后不会立刻替换昨天的原文。
- 模型可以为个别经历给出延长理由和期限，将总结保留期延至最多 30 天。延长不改变发生日期，不会连带延长整周其他经历。
- 经历原始事件先完整归档；生成按天图片时只取当前有效上下文仍可见的当天材料，已被摘要替换的内容沿用摘要，后续替换按原生来源归属到原日，不重新展开已压缩或撤回内容。跨日摘要不能安全拆分时保留现状。工具调用复用旧 optical 序列化：参数值最多 500 字符、整次调用和每份工具返回各最多 2000 字符，截短保留头尾约 60/40，返回正文使用淡色。图片使用 `hybrid-fusion12-bw` 渲染器，当前可见媒体引用保留。退出常驻上下文后，完整归档原文与媒体仍可取回。
- 可选的独立 DeepSeek 辅助请求读取最近 3 轮正文及当前消息，输出是否需要回忆和最多 3 个查询。固定 `thinking.type=disabled`，不继承人格、工具、思考或注入的旧召回；独立凭据环境变量、3 秒超时、不重试，失败回退当前消息检索。
- 自动召回查询当前版本记忆和经历总结，支持本地 embeddings + 词项匹配，以及“昨天/前天/今天/日期”的时间索引。召回进入当前请求，下一轮撤下；同一记忆版本在接下来 2 个轮次不重复自动注入（进程内去重，重启后重置），主动搜索不受此限制；读取不会更新经历年龄、增加重要性或自动恢复为近三天原文。
- `experience_search` 主动搜索包含活跃及休眠记忆，并标明状态；自动召回只纳入活跃记忆。搜索到休眠记忆不会自动激活它。两种入口均可搜索经历总结。`experience_read` 分页取回原文和媒体。每日整理忽略这些工具返回的旧原文，保留这次交流中新产生的表达。

## 梦境与锚点边界

模型提示明确要求锚点不跨梦境。进入夜间整理前，由本人收束当前锚点；复查锚点先收束或释放，再收束底层工作锚点，未完事项保留在收束总结里。醒来需要继续时重新开锚点。

手动整理和定时整理在进入维护边界后都检查活动锚点及暂存工作锚点。存在未收束锚点时返回延后原因，不归档改写主会话，不消耗夜间调用次数，不替本人生成收束。底层 dream 入口也检查同一条件。如果本人一直没有收束，整理会持续等待。

总结范围继续使用目标日期及首尾摘录 dayBoundary，不增加永久驻留的时间注入。它用于帮助定位，不能机械保证模型每句话都没有时间或事实误差。

## 状态与隔离

不可变 JSON 对象使用 SHA-256 寻址，写入与目录同步后才发布到原生会话。主会话只追加无正文的版本引用。DSH 的空 developer 替换需要已打开的 step，因此夜间使用原生空 user 标记，在下一次实际模型请求前换成不可见 developer 标记；整理提示、回答和新产生的思考均不进入主请求。

整理分支归档使用不可变的父事件前缀引用及子分支原生事件，记录继承消息校验值、模型、逐步及合计用量和完成状态。分支有完整的 turn/step 和工具调用/结果边界，可组合前缀与分支事件做严格回放。归档保留可见回答、只读查阅过程和用量；继承历史保持原样。只有通过完整校验的记忆变更及归档引用发布回主会话。

fork 继承切点处的记忆版本。此后父子各自发布新版本，共享不可变原文对象，不读取父分支后来的可变“最新文件”。备份时需要同时保留会话日志、`dataDir` 和 DSH attachments。

完整日子是第一版整理单位。未指定起点时，首次接入仅整理最近最多 21 天，优先昨天，然后补较近的积压；已压缩的更早历史保持原状。默认每晚至多 3 段整理，次数先持久化，打断/重启不会重置预算。一段内可以有多次按需查阅，所有步骤共享该段的超时；每次请求重新检查上下文容量。新消息到来会取消夜间模型请求，回到安静状态后可在剩余额度内续做。

失败或超出输入预算时不生成空白替代总结。模型回复必须完整通过结构和来源校验，所有记忆修改一起应用。没有总结的历史不会因为满两周而移除。

## 与现有插件的边界

- 新插件拥有自己的经历和可修改记忆库；不会写旧 `dsh-layered-memory` 数据库。两者可以并存，旧 `memory_search` 仍可使用；这一版还没有将旧的 80 条记忆迁入新库或统一两个搜索入口。
- 完成的 trajectory 总结可以作为原有材料参与转换；尚未收束的 work/review 锚点所覆盖部分会被保护。旧 trajectory 归档不删除。
- 已有光学检查点不转换、不拆解，也不丢弃其中的图片。
- 试用 preset 应关闭旧 optical/basic 的自动压力压缩，让时间窗口成为常规策略。旧引擎仍可保留手动应急入口。不要在未核对 profile 实际合成树时仅粘贴一个稀疏数组去覆盖整个 preset。
- 原文窗口也有有限的模型上下文容量；目前未实现“高压下仍同时严格保持天数和总 token 上限”的调度。图片超过默认 8 页总预算或模型不支持图片时采用同内容文字版，不截掉多余页。图片成本优先使用当前适配器的请求图片计价（视觉 token 加随附文字），否则使用旧 optical 的保守估算。选择在进入该阶段时完成；到总结阶段再转换。因此时间窗口是正常容量下的目标，不是强制删减保证。
- 日总结可以修订，但长期记忆不会仅因为年纪大就自动变成 dormant；由夜间模型结合新经历决定。没有交流的夜晚不会凭空产生一批新记忆。

## 构建与验证

Node 24。为了复用已经验证的生产依赖图而不改变其 lockfile，可以只在这个目录创建依赖链接：

```sh
node scripts/link-runtime.mjs /path/to/dsh-profile /path/to/typescript-development-package
npm run typecheck
npm test
npm pack
```

此脚本仅在本包 `node_modules` 下建链接，不安装或修改所给运行环境。发布包依赖现有的 optical 0.3.4、trajectory 0.2.0、原生 token-meter 和 DSH 0.1.7-rc.2。

测试使用真实 Agent loop、Session、磁盘持久化、PNG 生成、附件存储及严格原生日志回放。脚本模型仅提供正向的对话与整理产物，覆盖时间转换、召回和分页、冷恢复、原文不变、父子分支版本、定时补做、连续两晚修订及延长保留。没有增加负样本。

`scripts/trial.mjs` 是显式运行的付费验证入口，要求复制的会话文件、新输出目录及 `DREAM_TRIAL_MODEL=1`。默认用 DeepSeek 开启思考，只允许一次真实做梦请求；DeepSeek 试运行另允许一次关闭思考的查询生成。设置 `DREAM_TRIAL_PROVIDER=k3` 用当前 K3 路由做最终验证；设置 `DREAM_TRIAL_SKIP_QUERY=1` 可复用已经验证的查询环节而不再次调用，不加载 QQ、不使用生产 RPC、不把试运行结果写回主会话；凭据仅在内存读取，不写入产物。默认本地路径针对当前部署，迁移使用前需核对。

## 可试用配置

在独立试用 preset 中挂载 `dsh-dream-context`，配置示例见 `trial-config.json`。设置 `auto: false` 时可通过 `ctx.dreamContext.run(agent)` 手动执行一次，便于先审阅她实际写下的内容。

查询辅助默认关闭（`queryApiUrl` 为空）；试用配置给出了官方 API 地址，独立凭据通过 `queryApiKeyEnv` 指定的进程环境变量读取，不写入配置或产物。

完整 fork 仍占用模型上下文。余量检查使用原生 token-meter 的当前会话压力，增加补充材料、输出预算和余量；另有 100 万字符的异常请求上限。记忆补充默认不超过 2.4 万字符；这是防溢出的边界，不是按条目精细配额。超出容量会保留原文并延后，不会为做梦偷偷压缩或删除继承上下文。图像字节和原生路由限制仍由适配器校验。上下文前缀保持不等于服务端缓存必然命中，真实用量单独记录。

旧 layered-memory 尚未合并，超长积压日子尚无可续读的分批整理；一次真实模型调用不能证明长期记忆质量。


## 影子部署边界（2026-10-13）

`shadow: true` 只允许夜间原生 fork、归档和独立记忆库回写，关闭新记忆自动召回、experience 工具及所有历史按龄替换。旧 layered-memory 和旧压缩继续工作。

`legacyQueryHelper: true` 可独立启用：旧召回通过既有门控和冷却后，请 DeepSeek（关闭 thinking）用最近三轮和当前输入补全检索词。辅助结果只改变检索查询；超时、不可用或无需检索时沿用原查询。旧索引、阈值、去重、结果条数不变。检索词和命中放在同一条临时召回里，并计入原有字符预算；没有新命中时不单独注入查询词。凭据通过原生 credentials 服务动态解析，环境变量是备用入口。

旧召回仍在六小时到期或成功压缩后清理。梦境 fork 在发出请求前复用同一清理规则，仅改变子分支；清理的是临时上下文，不是记忆库。梦境归档保留原始继承前缀及清理事件。

`notBefore` 只限制自动调度的首次允许时间；本次设为 2026-10-14 04:00 +08:00，防止安装后立即补做。此后遵循每日 04:00、空闲十分钟和锚点已收束的条件。默认 `shadow: false` 和 `legacyQueryHelper: false` 保持原候选配置语义，安装时必须显式设置影子模式。


2026-10-14 超时修正：`timeoutMs` 按每段梦境独立计时（默认五分钟），不由整晚多个请求共享；前一段完成即持久化。用户新消息与维护取消仍可中断当前整理。每日自动请求上限、影子边界和积压选择顺序不变。

`startDay` 指定最早允许新总结的日子；本次设为 2026-10-14，此前未总结历史不再补齐，已生成的总结和记忆保留。稳定运行通常只处理刚结束的一天；起点之后的欠账仍会补做，不会因为超过七天而被静默排除。

`backlogAlerts: true` 启用积压告警：连续至少两个整理夜出现失败，且指定起点之后最早未总结经历的日龄超过三天，才建立原会话的一次性 schedule 通知。模型收到状态并简短转告用户，QQ 通过已有精确会话路由发送；同一夜去重，重启时同时查持久 schedule 目录避免重复创建。用户消息打断不计故障；某轮成功整理后故障连续计数清零。


## 召回开放、保留原压缩（2026-10-14）

生产采用 `shadow: false`、`historyCompression: false`：开放 `experience_search`、`experience_read` 和新库自动召回；夜间继续整理，同一不可变记忆库及分支版本不迁移。新插件完全跳过历史按龄转换，既不生成替代原文的图片，也不将历史替换成日总结或按龄移除。原有压缩插件和旧库召回照常运行。

`historyCompression` 默认 `true`，保持原候选方案兼容；`shadow: true` 仍覆盖该开关，始终关闭新召回、工具和历史转换。新旧召回在同一 Agent 的同批用户消息中共享一次查询词生成；跨用户消息重新生成，失败或取消不会留下永久缓存。新库自动召回仍保留每次最多两条、2400 字符和三轮重复抑制。


## 旧库迁入（2026-10-14）

`migrationRef` 指向同一不可变对象目录中的一次性迁移清单，绑定明确的原生会话。串行 `agent/created` 已处于原生初始化维护边界；在该边界内校验来源并追加新 book 引用，不能再次嵌套 `runMaintenance`。重启按 book 内迁移戳去重，后续 fork 自然继承已发布的版本。

每条迁入记忆保存 `provenance`，旧 ID、正文、类型、范围、版本、日期和可定位原消息完整保留在独立 legacy 来源对象；不伪造日经历。`experience_read` 可以读取搜索结果 evidence 中的 legacy 来源 ID。后续夜间修订仍可引用这些来源，保留迁移出处。检索显示原记录日期，迁移不重置经历时间。

`embeddingCacheDir` 持久保存按 endpoint、model、全文寻址的向量，`Recall.warm()` 用于安装前准备。正文或模型变化会得到新键；召回请求仍有四秒嵌入截止时间，预计算使冷启动无需重算整库。向量全部由现有本地服务为新文本重新生成，不复制旧库向量。

### Native dream routing and receipts

Direct dream forks apply `dsh-kimi-auto`'s default hysteresis policy before admission, using inherited provider-anchored pressure plus the complete new instruction/source supplement and output reservation. K3 selects either context tier without changing the parent route. Non-K3 routes are retained.

`notifications: true` appends a passive native receipt after the book is durably saved. It reports the actual date, completion state and memory changes, with no model name. It is visible to the next ordinary conversation request and does not trigger an extra model call. The durable book and receipt ID support restart deduplication. Actual model and usage remain in the immutable dream archive.

`manualRun: { id, sessionId, day }` authorizes one existing unsummarized day. The unique ID is reserved before calling the model; completed, interrupted or failed attempts are never automatically repeated with that ID. It does not reset the normal night's allowance or capture additional days. An open trajectory anchor still defers execution until its author closes it.

The review selection is supplemental: a current memory whose full ID and full current text are already visible in inherited conversation/tool results can also be revised. Existing branch/evidence/retention checks still apply. `manualRun.resultRef` can recover an immutable finished native response without another model request, provided its session/day and request-time memory content still match; a new archive records `recoveredFrom`, preserving the original artifact.

Dream replies may surround their JSON sections with prose or Markdown fences. The parser preserves authored JSON values and applies the same schema, identity, evidence, and retention checks. New memories still omit `id`; an explicit ID identifies an existing memory. Recovery uses the same parser and retains the original response, including its surrounding prose, in the saved dream archive.

### Author-controlled recall and bias (2026-10-15)

`experience_recall` exposes `status`, `pause`, and `resume`. Pause is a durable branch-local hard gate checked before query planning and automatic retrieval; explicit `experience_search`/`experience_read` remain available. After five actual user conversation rounds or thirty minutes, the next conversation request receives one passive reminder asking the author to resume or continue pausing. No idle-time message or model request is created, and no automatic resumption occurs. Repeating `pause` starts a new interval. The reminder marker survives restart; its visible text retires on the next turn.

With automatic recall enabled, DeepSeek's query helper is instructed to preserve focused discussion, intimate conversation and emotional support when the present context is sufficient. It returns `recall:false` for that turn. A helper outage retains the existing raw-query fallback; explicit pause always takes precedence.

`experience_bias` accepts an `updates` array of `{id,bias,reason}` for one or multiple current memory IDs. Bias is an absolute finite number from -1 to 1 (default zero), independent of fact reliability, memory text and active/dormant state. The immutable book history preserves prior versions and reasons. Identical repeated setters are idempotent; parallel edits are serialized. The dream proposal also accepts optional `biasAdjustments` for sampled memory IDs, allowing bias-only batches without rewriting text.

Automatic retrieval first checks relevance or an explicit matching date. Eligible results rank by relevance plus bias plus a bounded freshness bonus (`freshnessMaxBonus: 0.15`, `freshnessHalfLifeDays: 30`). Explicit date matches retain priority, including the matching day's summary. Bias does not decay. Active search uses relevance/date ordering and exposes bias/freshness metadata without letting automatic-recall preferences hide dormant or down-biased records.

Freshness uses the original source experience time, or labeled source-record/creation time when no event date exists. Existing records need no destructive migration. Bias changes, review, retrieval and text-only revision preserve the source date; genuinely added newer evidence may advance it. Querying or reviewing does not strengthen bias.

## 梦前主会话收束（2026-10-16）

夜间整理遇到活动锚点时，通过持久化 schedule 向原主会话投递一次收束请求，唤起当前模型亲自调用 trajectory 工具。查阅层和工作层都清空后，下一次调度检查自动继续整理；收束后的衔接不重新等待十分钟。若期间用户开始新对话，仍遵守正常空闲期。

与 dsh-trajectory 0.2.2 配合时，自动锚点提醒和梦前流程共用持久化请求记录；同一锚点只投递一次，跨条件、跨夜及重启均不重复催促。旧版 trajectory 兼容路径按同一整理夜、同一组锚点去重。提示本身不算收束，系统以真实锚点状态为准；等待时不消耗梦境次数，也不代写摘要。梦境前先移除已完成的交接标记，梦境分支保持无锚点。

时间通知发起的轮次中，实际助手内容和工具操作可进入每日经历。通知正文从夜间分支的有效输入中移出，主会话原始日志保持完整。纯时间通知唤醒不会刷新夜间整理的外部活动计时；收到真实会话输入仍会更新计时并中止正在进行的夜间处理。

## 渐进遗忘（0.2.0，默认关闭）

替换旧光学压缩的上下文方案，设计与审查记录另存，未随仓库发布。`progressive.enabled: true` 且 `historyCompression: true` 时生效，默认关闭。

- 上下文结构：system → 一条每晚重建的 `[往日]` 合成消息（照片联系表 + 每个仍被记得的日子：标题、日总结、淡化原文）→ 最近原文窗口（按整天、累计不超过 `rawTokens`，至少保留最近一个已完成日）→ 今天。
- 淡化额度：离开原文窗口的日子按从新到旧的序号 i 分到 `fadeBudgetTokens × (1 − fadeRatio) × fadeRatio^i`（默认 30k × 0.25 × 0.75^i），低于 `minDayTokens` 的日子不再有原文；总结仍按 `summaryDays`/`keepUntil` 常驻；两者都没有时该日退出常驻上下文，只能召回或 `experience_read`。
- 只删不改：每个日子有一条固定的删除序列（工具标记 → 助手长回复的中间句 → 助手收束摘要的中间句 → 未被挑中的整轮（权重最低、时段最密集者先） → 用户消息的中间句 → 其余未钉住的句子 → 助手挑的原话按优先级从低到高）。已应用的步数持久化在 `episode.fade.step`，只增不减，所以每晚保留的内容都是前一晚的子集。省略处标 `…`，整轮跳过标 `（此处略去 N 轮）`，助手原话用「」。
- 梦境新增 `quotes`：`{"episodeId","text","priority":1–3}`，逐字来自当天对话；只接受尚未开始淡化的日子；找不到出处、格式不符或超出 `quoteShare × 首日额度` 的条目忽略，并写入整理回执。
- 未总结的日子：留在原文窗口，连续 `maxRawNights` 个整理夜后无总结则照常淡化（回执注明）；`startDay` 之前的日子直接淡化、不补总结。
- 归档：不再丢弃没有人类消息的轮次（提醒、通知、子代理回报并入其后第一个有效轮次的那一天）。`archiveRange` 可为游标之前的日子补归档。
- 照片：仍被记得的日子里收到的照片拼成一张联系表（1536px 宽，越旧越小，标签“日期 #编号”），对应原文里的 `[照片 #n]`。
- 首次重建：配置 `rebuild: { id, sessionId, fromDay? }` 一次性授权：补归档 → 用合成消息替换旧检查点与全部更早历史。可延后（跨截止点的替换节点、未收束锚点、工具不成对、比 `[往日]` 更新的 `compact-checkpoint`），延后时每晚重试并记日志。**启用前必须先把 optical 的 `auto` 关掉**，否则压力压缩会吞掉 `[往日]`。
- 首次重建的时机：配置了 `rebuild` 且未完成时，会话安静满 `quietMinutes` 后的下一次 tick 就执行（不做梦、不消耗当晚次数）；之后每晚照常在做梦后重建。生产 2026-10-18 使用 `fromDay: 2026-09-23`，不为更早的日子补归档。试算可用 `DRYRUN_FROM_DAY`、`DRYRUN_SHEET=1`（配合 `DRYRUN_HOME` 指向含附件的目录副本）复现同样的参数并真实渲染联系表。
- 离线试算：`node scripts/progressive-dryrun.mjs <session.v4.jsonl.zstd> <objects-dir> <out-dir> [now]` 用真实日志生成 `composite.md` 与 `report.json`，不写回主会话（补归档写入 `<out-dir>/objects`）。
- 2026-10-17 用 k3-256k 实测像素字中文页：能省 token 的字号读不出来、读得出来的字号不省，且低推理强度下会编造，故原文淡化改在文本域完成，图片只用于照片。

```yaml
historyCompression: true
progressive:
  enabled: true
  rawTokens: 40000
  fadeBudgetTokens: 30000
  fadeRatio: 0.75
  minDayTokens: 300
  quoteShare: 0.5
  maxRawNights: 3
  photoSheet: true
  labels: { user: 用户, self: 我 }
rebuild: { id: rebuild-20261017, sessionId: session-<your-main-session-id> }
```


## 2026-10-18 提交校验反馈

最终 JSON 的格式、ID、来源及保留期限等提交校验失败时，保留原回答，在同一梦境分支追加具体反馈，让模型自行修正并重新提交完整 JSON。最多反馈两轮，共用上下文容量和取消信号；不自动改写正文或删除 ID。每段梦境的 deadline 为 `timeoutMs × 3`（首答加两轮纠正各一份额度，实测 k3 每轮约 150–180 秒），所以 `timeoutMs: 300000` 现在表示单段最多 15 分钟。全部校验通过才一次性提交。模型请求、存储或其他运行故障仍按原有路径停止。归档记录 corrections 和 submissionFailures 便于核对。

本次生产补丁基于 5da6e99b808756b9 的线上基线，只增加提交反馈，不包含工作区未上线的渐进淡化功能。32 项基线测试及昨晚两份真实回答的隔离修正回放通过；未新增负样本、未调用真实模型、未重跑生产梦境。

### 2026-10-18 梦境查阅防御

10-18 凌晨的三次失败：前两次模型给新增记忆自拟了 id，被判为修订不存在的记录；第三次 `experience_search` 带了未定义的 `limit` 被 strict schema 拒绝后，模型连续 8 次以空参数调用 `experience_read`，每次拿到约 1.35 万字符的完整目录，请求字符超过 `maxRequestChars`。对应修正：

- `experience_read` 省略 `episode_id` 时返回紧凑目录：每个经历一行（ID、日期、是否已总结、总结首句），按日期倒序，legacy 来源只给 ID 和日期并放在末尾；目录同样按 `offset`/`max_chars`（默认 6000）分页，按行切分。线上记忆库实测约 5.6k 字符，原来约 13.5k 且随每日总结线性增长。
- 同一梦境内参数完全相同的调用只执行一次，之后返回 `repeated`、`sameAsCall` 与提示，不计额度。
- 每次梦境有查阅额度 `maxDreamReads`（默认 10 次）与 `maxDreamReadChars`（默认 60000 字符）；每个结果带 `readsLeft`/`charsLeft`，用完后以工具错误提示直接提交，而不是撞上容量上限整次失败。失败的调用不计额度。
- `experience_search` 接受 `limit`（1–20，默认 8）；三个梦境工具都忽略多余键而不是报错。
- 梦境指令新增：新增记忆不要自拟 id；查阅有额度、重复调用无新内容。模型可见的新增文案一律英文。
- `recordFailure` 新增分类「提交内容未通过校验」；同一晚同原因的失败回执按尝试序号区分，不再去重。
- 新增 `scripts/replay-dream-fork.mjs <objects> <scratch> <parent-log> <fork-ref>…`：离线重放已存 dream-fork 的提交步骤，打印被拒原因与可疑 ID。`tests/defensive.test.mjs` 覆盖目录分页、去重、额度、反馈轮次与超时额度、校验失败分类和回执。


### 2026-10-18 白天便签 experience_note（0.2.3）

白天原本没有任何写记忆的入口：旧库 `memory_commit` 因 `historyOnly` 不再注册，soul-md 的 `memory_append` 已关闭，只能靠夜里做梦。新增 `experience_note`，让她白天留下便签，由当晚的梦决定去向，不绕过夜间整理的校验：

- `action: add`（`text` ≤ 2000 字，可选 `about` 指向一条已有记忆 ID）、`list`、`withdraw`（按 `id`）。便签存于 Book 的 `notes`，记录工具调用时的日志 seq，最多 40 条待处理。
- 便签所在的那一天被 capture 成 episode 后，才会随处理该日（或更晚）的梦一起呈现在 `daytimeNotes` 中，每条带 `episodeId`、`day`、时间与 `about`；`about` 指向的记忆自动加入本次抽选，因此可以修订。英文梦境指令说明便签不是来源 ID，证据应引用其 `episodeId`；把 `note_…` 当证据会收到相应的校验反馈。
- 梦境成功提交后，呈现过的便签即被消费并写入回执「处理白天便签 N 条」；失败则原样保留，等下次尝试。dream-fork 归档记录 `noteIds`，`recoverDream` 同样消费。
- 系统提示新增一句英文说明；工具描述为英文。`tests/notes.test.mjs` 覆盖本地校验、等待本日 capture、呈现与消费、`about` 记忆可修订、失败保留。

### 2026-10-29 白天自改记忆 experience_edit（0.2.6）

模型白天也可以直接修改记忆，不必再等夜里。新增 `experience_edit`，与便签、偏置并列：

- `action: revise`：按 `id`（必须来自新鲜的 `experience_search` 结果，`memory_…` 与 `legacy_memory_…` 同样接受）改 `text`、`kind`、`state`，或用 `evidence` 追加来源 ID（原有证据保留，来源必须是本分支真实的 episode / legacy ID）。`reason` 必填，连同日志 seq 与时间记在该记忆的 `daytime` 字段上。修订使 `revision` 加一、`updatedAt` 更新，`createdAt`、`reviewedAt`、`freshAt` 不动；完全没有变化的调用返回 `unchanged`，不计修订。
- `action: add`：`text`、`kind` 必填，`state` 默认 active，`evidence` 可空。当天尚未 capture 时记忆暂无来源；当天被 capture 成 episode 时（`appendEpisodes` → `linkDaytimeEvidence`），seq 落在其中的空证据记忆自动挂上该 episode。
- 每次白天修改都把 `nextReviewAt` 设为当下，因此下一次梦境的 `selectReview` 一定把它列入抽选，夜里的她能看到 `daytime.reason` 并决定是否再改。`state: dormant` 只是不再自动召回，主动搜索仍可见；没有删除，旧版本留在不可变的 Book 历史里。
- 未知 ID 复用 0.2.5 的 `Unknown memory ID …` 提示；证据越界复用 `Memory evidence is outside this branch`。系统提示补一句英文说明；工具描述为英文。`tests/native.test.mjs` 末尾用例覆盖拒绝未知 ID、证据校验、原地修订、幂等、无来源新增与次日挂证据、休眠、以及两条白天改动都进入次日梦境抽选。

