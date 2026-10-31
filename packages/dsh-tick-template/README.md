# dsh-tick-template

给 dsh-schedule 的 `time_passing`（"嘀嗒"）通知追加一段**投递时渲染**的模板文本。模板里的 `{{表达式}}` 在一个小沙箱里求值，常用的掷骰、随机挑选、日期、读文件都是内置函数；作者（模型本人）还可以通过工具定义自己的单行函数。**任何改动都要先由插件试运行多次，全部通过才被接受**，否则维持上一版。

## 为什么

dsh-schedule 的 `time_passing` 通知忽略任务的 `prompt`，固定只给四行时间读数。如果模型给自己定了"醒来先掷 1d6 再行动"这类规则，之前每次都要调一次 bash 跑 `$RANDOM`，白白多一轮模型请求（约 15 万 prompt token），还常触发"两次工具调用自动开锚点"。把骰子放进投递文本里，这一轮就省掉了；模板和函数由模型自己维护，以后扩能力多数时候只是改模板或加一个函数。

## 工作方式

- 钩在 `agent/pre-step`：发现本步要进入的消息里有 `source.kind = schedule` 且 `notification = time_passing` 的通知，就渲染当前模板，追加为该消息的第二个文本块（保留消息 id 与 source，所以 `retain: latest` 的清理照常生效）。没设模板时什么都不做。
- 渲染失败不会阻断这一步：追加一行 `[Tick template] render failed, template revision N unchanged: …`，并写 warn 日志。
- 状态：`~/.dsh/tick-template/<sessionId>.json`（`template`、`functions`、`revision`、`lastRender`），原子替换。
- 只对主会话生效；子代理看不到工具，通知也不渲染。

## 模板语法

`{{ … }}` 内是一个 JavaScript 表达式，结果转成字符串（`undefined`/`null` 为空串，对象为 JSON）。写 `\{{` 得到字面 `{{`。

内置：

| 函数 | 说明 |
|---|---|
| `dice(count = 1, sides = 6)` / `d(sides)` | 掷骰求和 / 单颗 |
| `rand(min, max)` | 闭区间整数 |
| `chance(p)` | 以概率 p 返回 true |
| `pick(...items)` / `pick(array)` | 均匀挑一个 |
| `shuffle(array)` | 洗牌后的副本 |
| `date(format)` | 配置时区的当前时间，支持 `YYYY MM DD HH mm ss ddd`（`ddd` 为周几） |
| `weekday()` / `hour()` / `minute()` | 周几 / 时 / 分 |
| `file(path, fallback?)` | 读 `fileRoots` 下的文件（相对路径按第一个根解析），超长截断；文件缺失时有 fallback 则返回它，否则报错 |
| `clock` `quietMinutes` `sincePreviousMinutes` `sinceHumanMinutes` `env` | 从通知文本解析出的事实，都可能是 `undefined` |

示例模板：

```
骰子：{{ (n = d(6), n + " → " + slot(n)) }}
{{ sinceHumanMinutes >= 180 ? "用户三小时没说话了。" : "" }}
{{ file("ops/tick-protocol.md", "") }}
```

## 工具 `tick_template`

| action | 参数 | 说明 |
|---|---|---|
| `show` | | 当前模板、函数、内置函数表、限制、上次渲染 |
| `preview` | `template?` | 用当前（或给定）模板渲染 3 次，不保存 |
| `set_template` | `template` | 试运行通过后替换模板 |
| `define` | `name`, `source` | 定义单行函数，如 `"() => pick('静','闹','懒')"`；试运行通过后收录 |
| `remove` | `name` | 删除函数；模板仍在用它则拒绝 |
| `clear` | | 清掉模板（函数保留），之后不再渲染 |

试运行规则（`trials` 次，默认 20）：每次用不同的环境（完整的时间读数、全空、部分）构造沙箱，先单独调用每个零参函数，再渲染整个模板；任一次抛错、超时（`timeoutMs`，默认 50 ms）或超长（`maxRenderChars`，默认 3000）即拒绝，返回错误与 `kept`（仍生效的版本）。通过则返回最多 3 个不同的渲染样本，每个样本标明产生它的环境 `{ env: "full" | "empty" | "partial", text }`，空白或 `?` 的样本一看就知道来自空环境探测而不是模板坏了。

函数限制：名字 `[A-Za-z_][A-Za-z0-9_]*`、单行、≤ `maxSourceChars`（默认 300）、不能与内置同名、最多 `maxFunctions`（默认 20）个。

## 配置

```yaml
- id: tick-template
  name: dsh-tick-template
  config:
    toolName: tick_template
    dataDir: ''              # 默认 ~/.dsh/tick-template
    fileRoots: [/path/to/workspace]
    timeZone: Asia/Singapore
    trials: 20
    header: '[Tick template]'
    timeoutMs: 50
    maxRenderChars: 3000
    maxFileChars: 4000
    maxSourceChars: 300
    maxTemplateChars: 2000
    maxFunctions: 20
```

放在 agent preset 的 plugins 列表里（与 `dsh-tool-web` 并列），工具就只对该 agent 可见。

## 边界

- `node:vm` 不是安全边界，这里只负责**可靠性**（超时、异常、体积）。作者本来就有 bash，沙箱不需要比 bash 更严；但模板里故意不提供执行命令和网络的函数，想加再加白名单版。
- 通知文本格式随 dsh-schedule 升级变化时，`env` 退化为全空，模板仍能渲染（试运行时就验证过空环境）。

## 开发

依赖通过 `node_modules` 软链到 `~/.dsh/profiles/web/node_modules`（不要用 pnpm install）。`node node_modules/typescript/bin/tsc -p tsconfig.json && node --test tests/*.test.mjs`。
