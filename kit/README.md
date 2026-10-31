# 陪伴型 DSH 套件（@riversjin 插件集）

这是一套在 DeepSeek Harness（DSH）上运行长期陪伴型助手的完整配方：打了补丁的 DSH 运行时、一组插件、一份可直接起服务的 profile 模板。它来自一个连续运行了数月的生产实例，这里去掉了其中的私人内容。

## 组成

| 目录 | 内容 |
|---|---|
| `runtime/` | DSH 0.2.1-rc.5 运行时的 pnpm 配方：7 个打补丁的上游包用 `overrides` 替换，`@earendil-works/pi-ai` 钉 1.1.0 并带上游补丁 |
| `profile-template/` | 只装插件的 profile：`package.json`（bundles 列表）、`cordis.patch.yml`（带占位符的完整配置） |
| `packages/` | 全部 tgz（本仓库打包产物、打补丁的上游包、第三方 fork）。仓库里不提交 tgz，从 Release 下载，或用 `scripts/build-from-source.sh` 从源码构建 |
| `install.sh` | 一键安装到指定 `DSH_HOME` |

## 前置条件

- Linux x86_64，Node ≥ 24，pnpm ≥ 11。
- Kimi Coding API key（`KIMI_CODING_API_KEY`，主模型 k3 / k3-256k）；DeepSeek API key（`DEEPSEEK_API_KEY`，网页搜索/抓取与夜间记忆的检索词辅助）。
- 可选：一个 OpenAI 兼容的 `/v1/embeddings` 服务，用于 dream-context 召回排序和 layered-memory 的向量召回。没有的话 dream-context 仍能工作，但召回质量下降；layered-memory 的 recall 保持关闭。

## 安装

```sh
kit/install.sh --dsh-home ~/.dsh --workspace ~/companion --name 月见 --user 我 --time-zone Asia/Shanghai
```

脚本做的事：
1. 把 `runtime/` 复制到 `$DSH_HOME/runtime/dsh-0.2.1-rc.5/`，放入 7 个打补丁的 tgz，`pnpm install`。
2. 把 `profile-template/` 复制到 `$DSH_HOME/profiles/web/`，替换占位符，放入插件 tgz，执行 `dsh plugin install`，并导出一份 `dump-config.yml` 供检查。
3. 打印启动命令。

启动：

```sh
export KIMI_CODING_API_KEY=... DEEPSEEK_API_KEY=... DSH_HOME=~/.dsh
node --expose-internals ~/.dsh/runtime/dsh-0.2.1-rc.5/node_modules/@deepseek-ai/dsh/lib/bin.js web --profile web --host 127.0.0.1 --port 3080
```

装完后至少改三处 `cordis.patch.yml`：`soul-md.cards` 里的人格卡；第一次对话后把主会话 id 填进 `schedule.timePassingSessions`；要用 QQ 入口就填 `im-qqbot` 的环境变量并把 `disabled` 改成 `false`。

## 从源码构建

不想用 Release 里的 tgz，可以全部从公开源码构建，结果放进 `kit/packages/`，之后照常运行 `install.sh`：

```sh
git clone https://github.com/RiversJin/dsh-plugins.git && cd dsh-plugins
scripts/build-from-source.sh            # 源码克隆到 ~/.cache/dsh-companion-src，可用 --workdir 改位置
kit/install.sh --dsh-home ~/.dsh --workspace ~/companion --name 月见 --user 我
```

脚本用到的源码：

| 仓库 | 分支 | 产出 |
|---|---|---|
| [RiversJin/deepseek-harness](https://github.com/RiversJin/deepseek-harness) | `local/schedule-idle-0.2.1-rc.5` | 7 个打补丁的 `@deepseek-ai/dsh-*` 包 |
| [RiversJin/dsh-plugins](https://github.com/RiversJin/dsh-plugins) | `main` | 12 个 `@riversjin/dsh-*` 插件 |
| [RiversJin/dsh-layered-memory](https://github.com/RiversJin/dsh-layered-memory) | `upgrade/dsh-0.2.1-rc.5` | `dsh-layered-memory` |
| [RiversJin/dsh-qqbot](https://github.com/RiversJin/dsh-qqbot) | `upgrade/dsh-0.2.1-rc.5` | `@tencent-connect/dsh-qqbot` |
| [RiversJin/dsh-usage-stats](https://github.com/RiversJin/dsh-usage-stats) | `upgrade/dsh-0.2.1-rc.5` | `dsh-usage-stats` |
| [RiversJin/dsh-soul-md](https://github.com/RiversJin/dsh-soul-md) | `rivers/dsh-0.2.1-rc.5` | `dsh-soul-md` |

需要 git、Node ≥ 24、pnpm ≥ 11 和 npm。最慢的是 harness monorepo：依赖安装后有几 GB，完整构建一般要十几到几十分钟。已经有这 7 个 tgz 时，加 `--skip-harness` 只重建其余部分。四个 fork 都是 MIT 协议，保留原作者的 LICENSE。

## 为什么需要打补丁的运行时

插件集依赖上游 0.2.1-rc.5 没有的三组能力，源码在 [RiversJin/deepseek-harness](https://github.com/RiversJin/deepseek-harness) 分支 `local/schedule-idle-0.2.1-rc.5`：

1. **schedule / tool-schedule / ui-schedule**：新增 `idle` 任务（安静一段时间后触发，每轮活动结束重新计时）、按本地时段投递的 `active_window`、投递时间读数的 `notification: time_passing`、只保留最新一条的 `retain: latest`，以及重放这些状态的 `scheduleActivity` 投影。`dream-context`、`tick-template`、`context-cleanup` 直接依赖 `time_passing` 通知。
2. **time-context**：`refreshUserMessageCount`（每 N 条真人消息强制刷新时间）、识别上下文重写后补注、与 dsh-retry 配合回滚计数。
3. **compaction-basic**：两个 waterfall 事件 `compaction/pressure-target`（kimi-auto 据此按目标模型算容量）和 `compaction/summarize-input`（layered-memory 据此把召回排除在摘要外）。

另外 `session-format-v3-to-v4` 与重建的 `session-persistence-jsonl` 只为兼容旧日志，新装实例用不到但无害。

## 插件一览

| 包 | 作用 |
|---|---|
| `@riversjin/dsh-trajectory` | 模型自管的工作/查阅锚点，原文归档与收束摘要 |
| `@riversjin/dsh-dream-context` | 夜间整理：日总结、长期记忆、渐进遗忘的上下文重建；白天 `experience_*` 工具 |
| `@riversjin/dsh-tick-template` | 时间流逝通知投递时渲染模型自定义模板 |
| `@riversjin/dsh-kimi-auto` | k3 / k3-256k 自动切档与压缩容量目标 |
| `@riversjin/dsh-optical-compaction` | 位图上下文压缩（OMP 兼容）与语义回退 |
| `@riversjin/dsh-context-milestones` | 上下文用量里程碑与模型切换通知 |
| `@riversjin/dsh-context-cleanup` | 冷会话 12 小时后清理工具输出、召回与时间快照 |
| `@riversjin/dsh-retry` | 整回合重试 |
| `@riversjin/dsh-subagent-route` | 子代理按路由选模型 |
| `@riversjin/dsh-projection-cache` | 会话投影缓存 |
| `@riversjin/dsh-http-gzip` | Web 响应压缩 |
| `@riversjin/dsh-session-id` | 侧栏显示/复制会话 id |
| `dsh-layered-memory`（fork） | 分层长期记忆，含分片嵌入 |
| `dsh-soul-md`（fork 0.8.5）| 人格卡注入，带 host settings 桥 |
| `dsh-usage-stats`（fork） | 用量统计 |
| `@tencent-connect/dsh-qqbot`（fork） | QQ 入口，含定时回复投递、会话切换、原生压缩 |
| `dsh-better-edit`、`dsh-composer-history`、`dsh-context`、`dshmarket` | 直接用 npm 版 |

## 已知限制

- `kimi-auto` 只针对 kimi-coding 的 k3 / k3-256k；换主模型时把它从 bundles 里去掉即可。
- dream-context 的提示词是中文，面向中文对话。
- 四个第三方 fork 以 `-rivers.N` 版本随 tgz 分发，未发到 npm；源码见上表。
- 升级 DSH 版本需要在 fork 上重打补丁、重新打包 7 个上游 tgz。
