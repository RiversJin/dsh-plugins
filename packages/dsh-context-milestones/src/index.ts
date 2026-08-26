import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-token-meter'

export const name = 'dsh-context-milestones'
export const inject = ['agents', 'tokenMeter']

export interface PluginConfig {
  stepPercent?: number
  modelSwitchNotice?: boolean
}

export interface ModelRoute {
  provider: string
  model: string
}

export interface Notice {
  summary: string
  text: string
}

export interface ContextMilestone {
  percent: number
  milestone: number
}

export interface RenderNoticeInput extends ContextMilestone {
  totalTokens: number
  contextWindow: number
}

export const Config: z<PluginConfig> = z.object({
  stepPercent: z.natural().min(1).max(100).default(5),
  modelSwitchNotice: z.boolean().default(true),
})

const NOTICE_PATTERN = /^\[Framework-injected context\] [\d.]+% used \(\d+\/(\d+) tokens\); crossed (\d+)%\.$/u

function validContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function successfulCompaction(event: SessionEvent): boolean {
  return event.type === 'compaction/end' && event.data.error === undefined
}

function parseNotice(event: SessionEvent): { contextWindow: number, milestone: number } | undefined {
  if (event.type !== 'user/message') return undefined
  const source = event.data.source
  if (source.kind !== 'plugin' || source.plugin !== name) return undefined
  const block = event.data.content[0]
  if (block?.type !== 'text') return undefined
  const match = NOTICE_PATTERN.exec(block.text)
  if (match === null) return undefined
  const contextWindow = Number(match[1])
  const milestone = Number(match[2])
  if (!validContextWindow(contextWindow) || !Number.isSafeInteger(milestone)) return undefined
  return { contextWindow, milestone }
}

/**
 * Find the last still-visible milestone in the current compaction cycle.
 * Successful summarizing compaction begins a new cycle even when it retained
 * the old notice among its recent surface nodes.
 */
export function latestMilestone(
  session: Pick<Session, 'events'>,
  visibleNodes: ReadonlySet<number>,
): { contextWindow: number, milestone: number } | undefined {
  const events = session.events
  let cycleStart = -1
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event !== undefined && successfulCompaction(event)) {
      cycleStart = index
      break
    }
  }
  for (let index = events.length - 1; index > cycleStart; index--) {
    const event = events[index]
    if (event === undefined) continue
    if (!visibleNodes.has(event.seq)) continue
    const state = parseNotice(event)
    if (state !== undefined) return state
  }
  return undefined
}

export function contextMilestone(
  totalTokens: number,
  contextWindow: number,
  stepPercent: number,
): ContextMilestone | undefined {
  if (!Number.isFinite(totalTokens) || totalTokens < 0 || !validContextWindow(contextWindow)) return undefined
  const percent = totalTokens / contextWindow * 100
  const milestone = Math.min(100, Math.floor(percent / stepPercent) * stepPercent)
  if (milestone < stepPercent) return undefined
  return { percent, milestone }
}

export function renderNotice({
  percent,
  milestone,
  totalTokens,
  contextWindow,
}: RenderNoticeInput): Notice {
  const exactPercent = percent.toFixed(1)
  const summary = `Context ${exactPercent}% used; crossed ${milestone}%`
  const text = `[Framework-injected context] ${exactPercent}% used (${Math.round(totalTokens)}/${contextWindow} tokens); crossed ${milestone}%.`
  return { summary, text }
}

function routeOf(variables: { provider?: unknown, model?: unknown } | undefined): ModelRoute | undefined {
  const provider = variables?.provider
  const model = variables?.model
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

function sameRoute(left: ModelRoute, right: ModelRoute): boolean {
  return left.provider === right.provider && left.model === right.model
}

export function renderModelSwitchNotice(previous: ModelRoute, current: ModelRoute): Notice {
  const from = `${previous.provider}/${previous.model}`
  const to = `${current.provider}/${current.model}`
  return {
    summary: `Model switched: ${from} -> ${to}`,
    text: `[Framework-injected model switch] Active model changed from ${from} to ${to}. Continue the same conversation; preserve the established identity, memory, decisions, and relationship. This runtime switch does not start a new conversation or change the active persona.`,
  }
}

function pluginNotice(notice: Notice): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: notice.text }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'notice',
      summary: notice.summary,
    },
  })
}

export function apply(ctx: Context, config: PluginConfig): void {
  const stepPercent = config.stepPercent ?? 5
  const modelSwitchNotice = config.modelSwitchNotice ?? true
  const selectedRoutes = new WeakMap<Session, ModelRoute>()

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const selected = routeOf(assembled.variables)
    const session = context.agent?.session
    if (selected !== undefined && session !== undefined) selectedRoutes.set(session, selected)
    return assembled
  })

  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    const notices: UserMessage[] = []
    if (modelSwitchNotice) {
      const selected = selectedRoutes.get(agent.session)
      const previousConfig = agent.session.requestHeader()?.config
      const previous = routeOf(previousConfig)
      if (selected !== undefined && previous !== undefined && !sameRoute(previous, selected)) {
        notices.push(pluginNotice(renderModelSwitchNotice(previous, selected)))
      }
    }

    if (step !== 1) {
      return notices.length === 0 ? decision : { kind: 'enter', messages: [...notices, ...decision.messages] }
    }

    const requestContext = agent.session.requestContext()
    const contextWindow = requestContext?.contextWindow
    if (!validContextWindow(contextWindow)) {
      return notices.length === 0 ? decision : { kind: 'enter', messages: [...notices, ...decision.messages] }
    }

    const measurement = ctx.tokenMeter.measure(agent.session)
    const pendingTokens = decision.messages.reduce(
      (total, message) => total + ctx.tokenMeter.estimateMessage(message),
      0,
    )
    const totalTokens = measurement.totalTokens + pendingTokens
    const current = contextMilestone(totalTokens, contextWindow, stepPercent)
    if (current === undefined) {
      return notices.length === 0 ? decision : { kind: 'enter', messages: [...notices, ...decision.messages] }
    }

    const previous = latestMilestone(agent.session, new Set(measurement.nodes.map(node => node.seq)))
    if (previous?.contextWindow === contextWindow && previous.milestone >= current.milestone) {
      return notices.length === 0 ? decision : { kind: 'enter', messages: [...notices, ...decision.messages] }
    }

    const notice = renderNotice({ ...current, totalTokens, contextWindow })
    notices.push(pluginNotice(notice))
    return {
      kind: 'enter',
      messages: [...notices, ...decision.messages],
    }
  }, { prepend: true })
  ctx.logger.info(`registered ${stepPercent}% context milestones${modelSwitchNotice ? ' and model-switch notices' : ''}`)
}
