import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  apply,
  contextMilestone,
  latestMilestone,
  name,
  renderModelSwitchNotice,
  renderNotice,
} from '../index.js'

function noticeEvent(seq, milestone, contextWindow = 1000) {
  const rendered = renderNotice({
    percent: milestone + 0.2,
    milestone,
    totalTokens: (milestone + 0.2) * contextWindow / 100,
    contextWindow,
  })
  return {
    seq,
    type: 'user/message',
    data: {
      content: [{ type: 'text', text: rendered.text }],
      source: { kind: 'plugin', plugin: name, form: 'notice', summary: rendered.summary },
    },
  }
}

function fixture({
  totalTokens = 49,
  contextWindow = 1000,
  pendingTokens = 2,
  previousRoute,
  selectedRoute = { provider: 'test', model: 'test' },
  events = [],
  nodes = events.filter(event => event.type === 'user/message').map(event => ({ seq: event.seq, tokens: 1 })),
} = {}) {
  let listener
  let assemblyListener
  let options
  const session = {
    events,
    requestHeader: () => previousRoute === undefined ? undefined : { config: previousRoute },
    requestContext: () => ({ provider: 'test', model: 'test', contextWindow }),
  }
  const ctx = {
    logger: { info: () => {} },
    tokenMeter: {
      measure: value => {
        assert.equal(value, session)
        return { totalTokens, nodes }
      },
      estimateMessage: () => pendingTokens,
    },
    on(event, callback, value) {
      if (event === 'system-prompt/assemble') {
        assemblyListener = callback
      } else {
        assert.equal(event, 'agent/pre-step')
        listener = callback
        options = value
      }
      return () => {}
    },
  }
  apply(ctx, { stepPercent: 5 })
  return {
    options,
    async run({ step = 1, aborted = false, messages = [{ id: 'pending' }] } = {}) {
      const controller = new AbortController()
      if (aborted) controller.abort()
      const agent = { session }
      await assemblyListener(
        {},
        { agent },
        async () => ({ variables: selectedRoute }),
      )
      return listener(
        { agent, step, signal: controller.signal },
        async () => ({ kind: 'enter', messages }),
      )
    },
  }
}

test('milestones use configured five-percent buckets', () => {
  assert.equal(contextMilestone(49, 1000, 5), undefined)
  assert.deepEqual(contextMilestone(50, 1000, 5), { percent: 5, milestone: 5 })
  assert.deepEqual(contextMilestone(249, 1000, 5), { percent: 24.9, milestone: 20 })
  assert.equal(contextMilestone(10, 0, 5), undefined)
})

test('pending messages can cross a threshold and produce one plugin notice', async () => {
  const f = fixture()
  assert.deepEqual(f.options, { prepend: true })
  const decision = await f.run()
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0].source.kind, 'plugin')
  assert.equal(decision.messages[0].source.plugin, name)
  assert.equal(decision.messages[0].source.form, 'notice')
  assert.match(decision.messages[0].content[0].text, /^\[Framework-injected context\]/u)
  assert.match(decision.messages[0].content[0].text, /5\.1% used/u)
  assert.equal(decision.messages[1].id, 'pending')
})

test('the same milestone is durable and not injected twice', async () => {
  const event = noticeEvent(0, 5)
  const decision = await fixture({ totalTokens: 74, pendingTokens: 1, events: [event] }).run()
  assert.deepEqual(decision.messages, [{ id: 'pending' }])
})

test('a turn that crosses multiple buckets emits only the highest bucket', async () => {
  const event = noticeEvent(0, 5)
  const decision = await fixture({ totalTokens: 164, pendingTokens: 1, events: [event] }).run()
  assert.equal(decision.messages.length, 2)
  assert.match(decision.messages[0].content[0].text, /crossed 15%/u)
})

test('successful compaction starts a new cycle even if an old notice remains visible', async () => {
  const old = noticeEvent(0, 60)
  const compacted = { seq: 1, type: 'compaction/end', data: { compactionId: 'c1', turn: 1 } }
  const f = fixture({
    totalTokens: 159,
    pendingTokens: 1,
    events: [old, compacted],
    nodes: [{ seq: 0, tokens: 1 }],
  })
  const decision = await f.run()
  assert.equal(decision.messages.length, 2)
  assert.match(decision.messages[0].content[0].text, /crossed 15%/u)
})

test('failed compaction does not reset the current cycle', async () => {
  const old = noticeEvent(0, 60)
  const failed = { seq: 1, type: 'compaction/end', data: { compactionId: 'c1', turn: 1, error: 'failed' } }
  const f = fixture({
    totalTokens: 159,
    pendingTokens: 1,
    events: [old, failed],
    nodes: [{ seq: 0, tokens: 1 }],
  })
  const decision = await f.run()
  assert.deepEqual(decision.messages, [{ id: 'pending' }])
})

test('a context-window change starts a new milestone scale', async () => {
  const old = noticeEvent(0, 60, 1000)
  const decision = await fixture({
    totalTokens: 399,
    pendingTokens: 1,
    contextWindow: 2000,
    events: [old],
  }).run()
  assert.equal(decision.messages.length, 2)
  assert.match(decision.messages[0].content[0].text, /crossed 20%/u)
})

test('only first-step active requests are considered', async () => {
  assert.deepEqual((await fixture().run({ step: 2 })).messages, [{ id: 'pending' }])
  assert.deepEqual((await fixture().run({ aborted: true })).messages, [{ id: 'pending' }])
})

test('latest milestone ignores shadowed notices', () => {
  const old = noticeEvent(0, 5)
  const current = noticeEvent(1, 10)
  assert.deepEqual(latestMilestone({ events: [old, current] }, new Set([1])), {
    contextWindow: 1000,
    milestone: 10,
  })
})

test('a real provider/model change emits one framework model-switch notice', async () => {
  const previousRoute = { provider: 'kimi-coding', model: 'k3' }
  const selectedRoute = { provider: 'qwen38-local', model: 'qwen-test' }
  const decision = await fixture({
    totalTokens: 0,
    pendingTokens: 0,
    previousRoute,
    selectedRoute,
  }).run()
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0].source.plugin, name)
  assert.match(decision.messages[0].content[0].text, /^\[Framework-injected model switch\]/u)
  assert.match(decision.messages[0].content[0].text, /kimi-coding\/k3/u)
  assert.match(decision.messages[0].content[0].text, /qwen38-local\/qwen-test/u)
})

test('initial requests and unchanged routes do not emit a model-switch notice', async () => {
  const route = { provider: 'kimi-coding', model: 'k3' }
  assert.deepEqual((await fixture({ totalTokens: 0, pendingTokens: 0, selectedRoute: route }).run()).messages, [{ id: 'pending' }])
  assert.deepEqual((await fixture({ totalTokens: 0, pendingTokens: 0, previousRoute: route, selectedRoute: route }).run()).messages, [{ id: 'pending' }])
})

test('model-switch and context notices compose in deterministic order', async () => {
  const decision = await fixture({
    previousRoute: { provider: 'kimi-coding', model: 'k3' },
    selectedRoute: { provider: 'qwen38-local', model: 'qwen-test' },
  }).run()
  assert.equal(decision.messages.length, 3)
  assert.match(decision.messages[0].content[0].text, /^\[Framework-injected model switch\]/u)
  assert.match(decision.messages[1].content[0].text, /^\[Framework-injected context\]/u)
})

test('model-switch notice wording marks runtime continuity explicitly', () => {
  const notice = renderModelSwitchNotice(
    { provider: 'old', model: 'a' },
    { provider: 'new', model: 'b' },
  )
  assert.equal(notice.summary, 'Model switched: old/a -> new/b')
  assert.match(notice.text, /does not start a new conversation or change the active persona/u)
})
