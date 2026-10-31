import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { assertSubagentMaxDepth } from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'subagent-route-tool'
export const inject = ['tools', 'subagents', 'systemPrompt']

export interface RouteConfig {
  name: string
  provider: string
  model: string
  maxTokens?: number
}

export interface PluginConfig {
  provider?: string
  toolName?: string
  maxDepth?: number
  routes?: RouteConfig[]
}

export type ResolvedRoute = Readonly<Pick<AgentOptions, 'provider' | 'model' | 'maxTokens'>> & {
  provider: string
  model: string
}

type RouteMap = ReadonlyMap<string, ResolvedRoute>

interface ProviderWording {
  description: string
  prompt: string
  guidance: string
}

export const Config: z<PluginConfig> = z.object({
  provider: z.string().default('fork'),
  toolName: z.string().default('subagent_fork'),
  maxDepth: z.natural().max(Number.MAX_SAFE_INTEGER).default(1),
  routes: z.array(z.object({
    name: z.string().required(),
    provider: z.string().required(),
    model: z.string().required(),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  })).default([]),
})

const SECTION_ORDER = 116.5
const ROUTE_NAME = /^[a-z][a-z0-9_-]{0,31}$/

function routeTable(routes: readonly RouteConfig[]): Map<string, ResolvedRoute> {
  const table = new Map<string, ResolvedRoute>()
  for (const route of routes) {
    if (!ROUTE_NAME.test(route.name) || route.name === 'inherit') {
      throw new Error(`subagent-route-tool: invalid route name "${route.name}"`)
    }
    if (table.has(route.name)) {
      throw new Error(`subagent-route-tool: duplicate route name "${route.name}"`)
    }
    table.set(route.name, Object.freeze({
      provider: route.provider,
      model: route.model,
      ...(route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens }),
    }))
  }
  return table
}

export function resolveRoute(routes: RouteMap, requested?: string): ResolvedRoute | undefined {
  const route = requested ?? 'inherit'
  if (route === 'inherit') return undefined
  const selected = routes.get(route)
  if (selected === undefined) {
    throw new Error(`subagent-route-tool: unknown route "${route}"`)
  }
  return selected
}

function providerWording(provider: SubagentProvider): ProviderWording {
  if (provider.inheritsParentContext) {
    return {
      description: 'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all completed turns so far (it does not see the current in-flight turn). The child also joins this agent\'s active preset, including its Soul and durable memory. You receive its result, not its intermediate steps.',
      prompt: 'The task for the subagent. It already sees this conversation\'s completed turns, but not the current in-flight turn, so include the new request it should address.',
      guidance: 'The child inherits completed turns and your active preset, Soul, and durable memory, but not the current in-flight turn. Include the current request in prompt.',
    }
  }
  return {
    description: 'Delegate a self-contained task to a separate subagent. The child joins this agent\'s active preset but does not inherit this conversation\'s completed turns.',
    prompt: 'The complete, self-contained task for the subagent.',
    guidance: 'The child starts with no parent conversation history, but joins your active preset, Soul, and durable memory. Give it a complete, standalone prompt containing everything it needs from the current request.',
  }
}

export function apply(ctx: Context, config: PluginConfig): void {
  const maxDepth = config.maxDepth ?? 1
  assertSubagentMaxDepth(maxDepth)
  const routes = routeTable(config.routes ?? [])
  const routeNames = ['inherit', ...routes.keys()]
  const providerName = config.provider ?? 'fork'
  const toolName = config.toolName ?? 'subagent_fork'
  let disposeTool: (() => void) | undefined
  let providerGuidance: string | undefined

  const mount = (provider: SubagentProvider): void => {
    if (!provider.capabilities.depthLimit) {
      throw new Error(`subagent-route-tool: provider "${provider.name}" cannot enforce maxDepth`)
    }
    if (routes.size > 0 && !provider.capabilities.agentOptions) {
      throw new Error(`subagent-route-tool: provider "${provider.name}" does not support child agentOptions, so routes cannot be offered`)
    }
    const wording = providerWording(provider)
    providerGuidance = wording.guidance
    disposeTool = ctx.tools.register(defineTool({
      name: toolName,
      description: `${wording.description} Returns a durable subagent id immediately; the final answer arrives as a completion notification. Use route to select an allowlisted child LLM; omit it to inherit the parent route.`,
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          required: true,
          description: wording.prompt,
        },
        route: {
          type: 'string',
          enum: routeNames,
          description: `Child LLM route. Defaults to inherit. Allowed: ${routeNames.join(', ')}.`,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, const: 'activation' },
            subagentId: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `started subagent ${value.subagentId}` }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const parent = exec.agent
        if (parent === undefined) {
          throw new Error('subagent-route-tool requires a calling agent')
        }
        const agentOptions = resolveRoute(routes, args.route)
        const prompt: ContentBlock[] = [{ type: 'text', text: args.prompt }]
        const request: Omit<SubagentStartRequest, 'label' | 'signal'> = {
          prompt,
          parent,
          ...(agentOptions === undefined ? {} : { agentOptions }),
          maxDepth,
        }
        // dsh 0.2.1: every delegation is a managed activation; the final answer
        // reaches the parent as a completion notification (delivery: 'parent').
        const started = await ctx.subagents.startActivation({
          provider: providerName,
          label: args.description,
          request,
          signal: exec.signal,
          delivery: 'parent',
        })
        return { kind: 'activation' as const, subagentId: started.childId }
      },
    }))
  }

  ctx.on('subagent/provider-added', provider => {
    if (provider.name === providerName && disposeTool === undefined) mount(provider)
  })
  ctx.on('subagent/provider-removed', removed => {
    if (removed !== providerName || disposeTool === undefined) return
    disposeTool()
    disposeTool = undefined
    providerGuidance = undefined
  })

  const present = ctx.subagents.getProvider(providerName)
  if (present !== undefined) mount(present)
  else ctx.logger.info(`subagent provider "${providerName}" not registered yet; "${toolName}" will register when it appears`)

  ctx.systemPrompt.section({
    name: `tool:${toolName}`,
    order: SECTION_ORDER,
    text: context => disposeTool === undefined || ctx.tools.get(toolName, context.scope) === undefined
      ? ''
      : `${toolName} returns a child id at once and the child's final answer arrives later as a completion notification; end your turn and wait for it unless other work remains. Choose the allowlisted child route that best fits the task; omit route to inherit your current model. ${providerGuidance ?? ''} After the child settles, send_message with its id continues the same child conversation.`,
  })
}
