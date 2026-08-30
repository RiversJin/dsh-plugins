import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session';

const baseUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080';
const provider = process.env.DSH_PROVIDER ?? 'kimi-coding';
const model = process.env.DSH_MODEL ?? 'k3-256k';
const keepSession = process.env.DSH_KEEP_SESSION === '1';
const cwd = process.env.DSH_TEST_CWD ?? '/home/rivers/projects/dsh-plugins';
const sessionId = randomUUID();
const prompt = 'Reply with exactly FIRST and no other text.';

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const envelope = await response.json();
  if (envelope.result?.ok !== true) {
    throw new Error(`${path}: ${JSON.stringify(envelope.result?.error ?? envelope)}`);
  }
  return envelope.result.value;
}

async function unary(method, payload) {
  return post(`/api/${method}`, {
    type: 'client-request',
    rpcId: randomUUID(),
    method,
    payload,
  });
}

async function remote(endpoint, args) {
  return post(`/api/${endpoint}`, {
    type: 'client-request',
    rpcId: randomUUID(),
    method: endpoint,
    payload: { args },
  });
}

async function history() {
  const value = await unary('session.history', { sessionId, maxMessages: 500 });
  return value.events.map(entry => entry.event);
}

async function waitForCompletedAssistant(count) {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const events = await history();
    const assistants = events.filter(event => event.type === 'assistant/message');
    if (assistants.length >= count && events.at(-1)?.type === 'turn/end') {
      return { events, assistants };
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for completed assistant ${count}`);
}

console.log(`retry live smoke session: ${sessionId}`);
let archived = false;
try {
  await unary('session.create', {
    sessionId,
    cwd,
  });
  await unary('session.selectModel', {
    sessionId,
    provider,
    model,
    reasoningEffort: 'low',
  });

  const commands = await remote('commands/list', { agentId: sessionId });
  assert.equal(commands.some(command => command.name === 'retry'), true, '/retry is not registered');

  await unary('session.prompt', {
    sessionId,
    mode: 'queue',
    clientTimeZone: 'Asia/Singapore',
    content: [{ type: 'text', text: prompt }],
  });
  const first = await waitForCompletedAssistant(1);
  const oldAnswerId = first.assistants.at(-1).data.message.id;

  const retry = await remote('commands/execute', {
    agentId: sessionId,
    line: `/retry ${oldAnswerId}`,
    images: [],
  });
  assert.equal(retry?.result?.kind, 'success', JSON.stringify(retry));

  const completed = await waitForCompletedAssistant(2);
  const newAnswerId = completed.assistants.at(-1).data.message.id;
  const folded = foldSurface(completed.events);
  const visibleMessages = folded.nodes
    .map(seq => deriveEventMessage(completed.events[seq]))
    .filter(Boolean);

  assert.equal(oldAnswerId === newAnswerId, false, 'retry reused the old assistant id');
  assert.equal(
    visibleMessages.some(message => message.id === oldAnswerId),
    false,
    'old answer remained in the model-visible surface',
  );
  assert.equal(
    visibleMessages.some(message => message.id === newAnswerId),
    true,
    'new answer is missing from the model-visible surface',
  );
  assert.equal(
    completed.events.some(event => event.type === 'assistant/message' && event.data.message.id === oldAnswerId),
    true,
    'append-only source event unexpectedly disappeared',
  );
  assert.equal(folded.replacements.length, 1, 'retry did not commit exactly one surface replacement');

  const sessions = await unary('session.list', {});
  assert.equal(
    sessions.items.some(item => item.parentSessionId === sessionId),
    false,
    'retry created a fork child',
  );
  console.log(JSON.stringify({
    sessionId,
    oldAnswerId,
    newAnswerId,
    replacement: folded.replacements[0],
    visibleMessageCount: visibleMessages.length,
    forkCreated: false,
  }, null, 2));
} finally {
  if (!keepSession) {
    try {
      await unary('workspace.archiveSession', { sessionId });
      archived = true;
    } catch (error) {
      console.error(`could not archive smoke session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(keepSession
    ? `retry live smoke session retained: ${sessionId}`
    : `retry live smoke session archived: ${archived}`);
}
