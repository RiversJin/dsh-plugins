import { randomUUID } from 'node:crypto'

const baseUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const agentPreset = process.env.DSH_AGENT_PRESET
if (agentPreset === undefined || agentPreset.trim().length === 0) {
  throw new Error('DSH_AGENT_PRESET must name an isolated preset that mounts dsh-optical-compaction')
}
const provider = process.env.DSH_PROVIDER ?? 'kimi-coding'
const model = process.env.DSH_MODEL ?? 'k3-256k'
const sessionId = randomUUID()
const expected = {
  path: '/srv/omp/optical-live-check',
  verification: 'cinnabar-current-4827',
  counter: '64127',
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
  const envelope = await response.json()
  if (envelope.result?.ok !== true) {
    throw new Error(`${path}: ${JSON.stringify(envelope.result?.error ?? envelope)}`)
  }
  return envelope.result.value
}

async function unary(method, payload) {
  const rpcId = randomUUID()
  return post(`/api/${method}`, { type: 'client-request', rpcId, method, payload })
}

async function remote(endpoint, args) {
  const rpcId = randomUUID()
  return post(`/api/${endpoint}`, {
    type: 'client-request',
    rpcId,
    method: endpoint,
    payload: { args },
  })
}

async function waitForHost() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      await unary('session.list', {})
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error(`DSH host did not become ready at ${baseUrl} within 60 seconds`)
}

async function history() {
  const value = await unary('session.history', { sessionId, maxMessages: 500 })
  return value.events.map((entry) => entry.event)
}

async function waitForAssistantCount(count, label) {
  const deadline = Date.now() + 20 * 60 * 1000
  let nextReport = Date.now() + 30_000
  while (Date.now() < deadline) {
    const events = await history()
    const messages = events.filter((event) => event.type === 'assistant/message')
    if (messages.length >= count) return { events, messages }
    if (Date.now() >= nextReport) {
      console.log(`${label}: waiting (${Math.round((20 * 60 * 1000 - (deadline - Date.now())) / 1000)}s)`)
      nextReport += 30_000
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`${label}: timed out waiting for assistant message ${count}`)
}

function densePrompt() {
  const rows = Array.from({ length: 640 }, (_, index) => {
    const prefix = `archive-record-${String(index).padStart(4, '0')} status=stable `
    return prefix + 'context datum '.repeat(6)
  })
  rows[160] += ` exact-path=${expected.path}`
  rows[320] += ` verification=${expected.verification}`
  rows[480] += ` counter=${expected.counter}`
  return [
    'This is deterministic optical-compaction test material. Preserve it exactly. Reply with only ACK.',
    ...rows,
  ].join('\n')
}

await waitForHost()
console.log(`live smoke session: ${sessionId}`)
let archived = false
try {
  await unary('session.create', {
    sessionId,
    cwd: '/home/rivers/projects/dsh-optical-compaction',
    agentPreset,
  })
  await unary('session.selectModel', {
    sessionId,
    provider,
    model,
    reasoningEffort: 'low',
  })

  await unary('session.prompt', {
    sessionId,
    mode: 'queue',
    clientTimeZone: 'Asia/Singapore',
    content: [{ type: 'text', text: densePrompt() }],
  })
  await waitForAssistantCount(1, 'seed turn')

  const commands = await remote('commands/list', { agentId: sessionId })
  if (!commands.some((command) => command.name === 'compact')) {
    throw new Error(`/compact is not registered in preset ${agentPreset}`)
  }
  const compact = await remote('commands/execute', {
    agentId: sessionId,
    line: '/compact',
    images: [],
  })
  if (compact?.result?.kind !== 'success') {
    throw new Error(`/compact failed: ${JSON.stringify(compact)}`)
  }

  const compactedEvents = await history()
  const summaryEvent = compactedEvents.findLast((event) => event.type === 'compaction/summary')
  if (summaryEvent === undefined) throw new Error('no compaction/summary event was committed')
  const frameCount = summaryEvent.data.summary.filter((block) => block.type === 'image').length
  if (frameCount < 2) throw new Error(`compaction committed only ${frameCount} optical image frame(s)`)
  if (summaryEvent.data.provider !== 'local'
    || summaryEvent.data.model !== 'dsh-optical-compaction/omp-snapcompact-18.0.10') {
    throw new Error(`unexpected compaction route: ${summaryEvent.data.provider}/${summaryEvent.data.model}`)
  }
  console.log(`committed optical checkpoint: ${frameCount} frame(s), shadowed ~${summaryEvent.data.shadowedTokenCount} tokens`)

  await unary('session.prompt', {
    sessionId,
    mode: 'queue',
    clientTimeZone: 'Asia/Singapore',
    content: [{
      type: 'text',
      text: 'Read the optical archive from the earlier conversation. Return exactly one JSON object with path, verification, and counter. Do not guess.',
    }],
  })
  const { messages } = await waitForAssistantCount(2, 'recall turn')
  const latest = messages.at(-1).data.message.content
    .filter((block) => block.type === 'text' || block.type === 'reasoning')
    .map((block) => block.text)
    .join('\n')
  for (const value of Object.values(expected)) {
    if (!latest.includes(value)) throw new Error(`recall response omitted ${value}`)
  }
  console.log(`recall verified: ${JSON.stringify(expected)}`)
} finally {
  try {
    await unary('workspace.archiveSession', { sessionId })
    archived = true
  } catch (error) {
    console.error(`could not archive live smoke session: ${error instanceof Error ? error.message : String(error)}`)
  }
  console.log(`live smoke session archived: ${archived}`)
}
