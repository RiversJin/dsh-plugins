import z from '@deepseek-ai/schemastery'
import { assertSubagentMaxDepth } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'subagent-route-tool'
export const inject = ['tools', 'subagents', 'systemPrompt']

export const Config = z.object({
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

function outputValueText(values) {
  return values
    .filter(value => typeof value === 'object' && value !== null && !Array.isArray(value)
      && value.type === 'text' && typeof value.text === 'string')
    .map(value => value.text)
    .join('')
}

function stopReasonError(result) {
  switch (result.stopReason) {
    case 'completed': return undefined
    case 'aborted': return 'subagent run was cancelled'
    case 'error': return 'subagent run failed'
    case 'max-tokens': return 'subagent run hit its token limit before finishing'
    case 'refusal': return 'subagent declined the task'
    default: return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

function withDiagnosticAndPartialText(error, result) {
  const diagnostic = result.diagnostic === undefined ? '' : `\nDiagnostic: ${result.diagnostic}`
  const text = result.output
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  return `${error}${diagnostic}${text.length === 0 ? '' : `\nPartial output before the run ended:\n${text}`}`
}

async function settleForegroundRun(run) {
  const [execution] = await Promise.allSettled([
    run.result.then(result => {
      const error = stopReasonError(result)
      if (error !== undefined) throw new Error(withDiagnosticAndPartialText(error, result))
      return {
        kind: 'foreground',
        runId: run.id,
        output: result.output,
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([
    Promise.resolve().then(() => run.dispose()),
  ])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

function routeTable(routes) {
  const table = new Map()
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

export function resolveRoute(routes, requested) {
  const route = requested ?? 'inherit'
  if (route === 'inherit') return undefined
  const selected = routes.get(route)
  if (selected === undefined) {
    throw new Error(`subagent-route-tool: unknown route "${route}"`)
  }
  return selected
}

function providerWording(provider) {
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

export function apply(ctx, config) {
  assertSubagentMaxDepth(config.maxDepth)
  const routes = routeTable(config.routes ?? [])
  const routeNames = ['inherit', ...routes.keys()]
  const providerName = config.provider ?? 'fork'
  const toolName = config.toolName ?? 'subagent_fork'
  let disposeTool
  let providerGuidance

  const mount = provider => {
    if (!provider.capabilities.depthLimit) {
      throw new Error(`subagent-route-tool: provider "${provider.name}" cannot enforce maxDepth`)
    }
    if (provider.prepareContinuable === undefined) {
      throw new Error(`subagent-route-tool: provider "${provider.name}" does not support continuable children`)
    }
    const wording = providerWording(provider)
    providerGuidance = wording.guidance
    disposeTool = ctx.tools.register(defineTool({
      name: toolName,
      description: `${wording.description} Runs in the background by default and returns a durable subagent id. Use route to select an allowlisted child LLM; omit it to inherit the parent route.`,
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
        run_in_background: {
          type: 'boolean',
          description: 'Whether to return a durable subagent id immediately. Defaults to true. Set false only when the next action depends on the result; a foreground run is not continuable.',
        },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'continuable' },
                subagentId: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'foreground' },
                runId: { type: 'string', required: true },
                output: { type: 'array', required: true, items: { type: 'json' } },
              },
            },
          ],
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.kind === 'continuable'
            ? `started subagent ${value.subagentId}`
            : outputValueText(value.output),
        }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const parent = exec.agent
        if (parent === undefined) {
          throw new Error('subagent-route-tool requires a calling agent')
        }
        const agentOptions = resolveRoute(routes, args.route)
        const request = {
          label: args.description,
          prompt: [{ type: 'text', text: args.prompt }],
          parent,
          ...(agentOptions === undefined ? {} : { agentOptions }),
          maxDepth: config.maxDepth,
        }
        if (args.run_in_background !== false) {
          const started = await ctx.subagents.startContinuable({
            provider: providerName,
            label: args.description,
            request,
            signal: exec.signal,
          })
          return { kind: 'continuable', subagentId: started.childId }
        }
        return settleForegroundRun(await ctx.subagents.start(providerName, {
          ...request,
          signal: exec.signal,
        }))
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
      : `Use ${toolName} in the background by default. Choose the allowlisted child route that best fits the task; omit route to inherit your current model. ${providerGuidance} When the child settles, use send_message with its id for later turns in the same child conversation.`,
  })
}
