import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, resolveRoute } from '../lib/index.js'

const qwen = {
  name: 'qwen',
  provider: 'qwen38-local',
  model: 'Qwen3.8-27B/Qwen3.8-27B-UD-Q4_K_XL.gguf',
  maxTokens: 32768,
}

function fixture({
  providerName = 'fork',
  toolName = 'subagent_fork',
  inheritsParentContext = true,
  maxDepth = 1,
} = {}) {
  let definition
  let activation
  const promptSections = []
  const provider = {
    name: providerName,
    inheritsParentContext,
    capabilities: { depthLimit: true, agentOptions: true },
    prepareContinuable: async () => ({}),
  }
  const ctx = {
    logger: { info: () => {} },
    tools: {
      register(value) {
        definition = value
        return () => { definition = undefined }
      },
      get(name) {
        return definition?.name === name ? definition : undefined
      },
    },
    subagents: {
      getProvider: name => name === providerName ? provider : undefined,
      async startActivation(spec) {
        activation = spec
        return {
          childId: 'child-qwen',
          messageId: 'message-1',
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }),
          dispose: async () => {},
        }
      },
    },
    systemPrompt: { section: value => { promptSections.push(value); return () => {} } },
    on: () => () => {},
  }
  apply(ctx, {
    provider: providerName,
    toolName,
    maxDepth,
    routes: [qwen],
  })
  return {
    get definition() { return definition },
    get activation() { return activation },
    promptSections,
  }
}

test('route resolver preserves inheritance and rejects unknown routes', () => {
  const routes = new Map([['qwen', { provider: qwen.provider, model: qwen.model }]])
  assert.equal(resolveRoute(routes), undefined)
  assert.equal(resolveRoute(routes, 'inherit'), undefined)
  assert.deepEqual(resolveRoute(routes, 'qwen'), { provider: qwen.provider, model: qwen.model })
  assert.throws(() => resolveRoute(routes, 'other'), /unknown route/)
})

test('tool schema adds one allowlisted route field without adding another tool', () => {
  const f = fixture()
  assert.equal(f.definition.name, 'subagent_fork')
  const properties = f.definition.parameters.properties
  assert.deepEqual(Object.keys(properties).sort(), [
    'description',
    'prompt',
    'route',
  ])
  assert.deepEqual(properties.route.enum, ['inherit', 'qwen'])
  assert.equal(f.promptSections.length, 1)
})

test('qwen route maps to fixed agentOptions on a parent-delivered fork activation', async () => {
  const f = fixture()
  const parent = { id: 'parent' }
  const result = await f.definition.execute(
    {
      description: 'ask qwen helper',
      prompt: 'Continue this conversation.',
      route: 'qwen',
    },
    { agent: parent, signal: new AbortController().signal },
  )
  assert.deepEqual(result, { kind: 'activation', subagentId: 'child-qwen' })
  assert.equal(f.activation.provider, 'fork')
  assert.equal(f.activation.delivery, 'parent')
  assert.equal(f.activation.label, 'ask qwen helper')
  assert.equal(f.activation.request.parent, parent)
  assert.equal(f.activation.request.maxDepth, 1)
  assert.deepEqual(f.activation.request.agentOptions, {
    provider: qwen.provider,
    model: qwen.model,
    maxTokens: qwen.maxTokens,
  })
})

test('spawn route stays fresh while preserving preset and memory guidance', async () => {
  const f = fixture({
    providerName: 'spawn',
    toolName: 'subagent',
    inheritsParentContext: false,
    maxDepth: 3,
  })
  assert.equal(f.definition.name, 'subagent')
  assert.match(f.definition.description, /does not inherit this conversation/)
  const guidance = f.promptSections[0].text({ scope: {} })
  assert.match(guidance, /no parent conversation history/)
  assert.match(guidance, /active preset, Soul, and durable memory/)

  await f.definition.execute(
    {
      description: 'fresh qwen worker',
      prompt: 'Complete standalone task.',
      route: 'qwen',
    },
    { agent: {}, signal: new AbortController().signal },
  )
  assert.equal(f.activation.provider, 'spawn')
  assert.equal(f.activation.request.maxDepth, 3)
  assert.deepEqual(f.activation.request.agentOptions, {
    provider: qwen.provider,
    model: qwen.model,
    maxTokens: qwen.maxTokens,
  })
})

test('inherit route omits agentOptions and every delegation is an activation', async () => {
  const f = fixture()
  const result = await f.definition.execute(
    {
      description: 'inherit route',
      prompt: 'Review this.',
      route: 'inherit',
    },
    { agent: {}, signal: new AbortController().signal },
  )
  assert.deepEqual(result, { kind: 'activation', subagentId: 'child-qwen' })
  assert.equal(f.activation.provider, 'fork')
  assert.equal('agentOptions' in f.activation.request, false)
})

test('a provider without child agentOptions cannot offer routes', () => {
  assert.throws(() => apply({
    logger: { info: () => {} },
    tools: { register: () => () => {}, get: () => undefined },
    subagents: { getProvider: () => ({ name: 'fork', inheritsParentContext: true, capabilities: { depthLimit: true, agentOptions: false } }) },
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
  }, { provider: 'fork', toolName: 'subagent_fork', maxDepth: 1, routes: [qwen] }), /does not support child agentOptions/)
})

test('invalid and duplicate route names fail closed at mount', () => {
  const makeCtx = () => ({
    logger: { info: () => {} },
    tools: { register: () => () => {}, get: () => undefined },
    subagents: { getProvider: () => undefined },
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
  })
  assert.throws(() => apply(makeCtx(), {
    provider: 'fork', toolName: 'subagent_fork', maxDepth: 1,
    routes: [{ ...qwen, name: 'inherit' }],
  }), /invalid route name/)
  assert.throws(() => apply(makeCtx(), {
    provider: 'fork', toolName: 'subagent_fork', maxDepth: 1,
    routes: [qwen, qwen],
  }), /duplicate route name/)
})
