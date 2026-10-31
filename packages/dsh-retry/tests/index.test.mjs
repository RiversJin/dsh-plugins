import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import { retryAgent, planRetry, parseRetryInput } from '../lib/index.js';

const text = value => [{ type: 'text', text: value }];
function textResponse(value) {
  return [{ type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: text(value)[0] },
    { type: 'finish', reason: { kind: 'stop' } }];
}
function toolResponse(id) {
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'count', argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'count', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } }];
}
class Adapter extends LlmAdapter {
  requests = [];
  constructor(script) { super(); this.script = script; }
  async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ['text', 'image'] }; }
  async *stream(options) {
    this.requests.push(options);
    const entry = this.script.shift();
    assert.ok(entry, 'unexpected model request');
    if (entry instanceof Error) throw entry;
    for (const chunk of entry) yield chunk;
  }
}
async function harness(script) {
  const ctx = new Context(), events = [];
  ctx.on('session/event', (_session, event) => { events.push(event); });
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt, { personaPrefix: 'stable system' });
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  const adapter = new Adapter(script); ctx.llm.registerAdapter(['mock'], adapter);
  let calls = 0, closed = 0;
  ctx.tools.register(defineContentToolFixture({ name: 'count', description: 'Count each execution', parameters: {},
    async execute() { return text(`count-${++calls}`); } }));
  const handle = await ctx.agents.create({ sessionId: SessionId(crypto.randomUUID()), agentOptions: { provider: 'mock', model: 'test' } });
  const agent = handle.agent;
  const retryCtx = { sessions: ctx.sessions, sessionPersistence: { async open() { return {
    async read(offset, count) { return { events: events.slice(offset, offset + count) }; },
    async close() { closed++; },
  }; } } };
  return { ctx, agent, events, adapter, retryCtx, get calls() { return calls; }, get closed() { return closed; },
    async send(content = text('original question')) { agent.followup(createUserMessage({ source: { kind: 'user' }, content })); await agent.whenIdle(); },
    async retry(id) { const result = await retryAgent(retryCtx, agent, id, new AbortController().signal); await agent.whenIdle(); return result; },
    async close() { await handle.dispose(); await ctx.fiber.dispose(); },
  };
}
const lastId = h => h.events.findLast(event => event.type === 'assistant/message')?.data.message.id;
const wireMessages = request => request.messages.map(({ role, content }) => ({ role, content }));
function validateColdHistory(h) {
  const artifact = JSON.parse(JSON.stringify({ header: { ...h.agent.session.header, delegationDepth: 0, isSeeded: false }, inheritedEventCount: 0, events: h.events }));
  const restore = sessionFormatCatalog.createRestore(sessionFormatCatalog.encodeCurrentHeader(artifact.header, 0), { recovery: 'strict', validation: 'current' });
  for (const event of artifact.events) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event));
  assert.equal(restore.finish().events.length, artifact.events.length);
  const cold = Session.create(SessionId(artifact.header.id), artifact.events, artifact.header, 0);
  assert.deepEqual(cold.deriveMessages(), h.agent.session.deriveMessages());
}

test('replays the actual user request without a synthetic instruction, repeatedly', { timeout: 10000 }, async () => {
  const h = await harness([textResponse('first'), textResponse('second'), textResponse('third')]);
  try {
    await h.send(); const first = lastId(h);
    assert.equal((await h.retry(first)).kind, 'success');
    assert.deepEqual(wireMessages(h.adapter.requests[1]), wireMessages(h.adapter.requests[0]));
    assert.equal((await h.retry(lastId(h))).kind, 'success');
    assert.deepEqual(wireMessages(h.adapter.requests[2]), wireMessages(h.adapter.requests[0]));
    assert.equal(h.agent.session.deriveMessages().filter(m => m.source.kind === 'user').length, 1);
    assert.ok(h.events.some(e => e.type === 'assistant/message' && e.data.message.id === first));
    assert.ok(h.adapter.requests.every(r => !JSON.stringify(r.messages).includes('plugin:dsh-retry')));
    assert.equal(h.closed, 2); validateColdHistory(h);
  } finally { await h.close(); }
});

test('reexecutes the whole tool-bearing turn without force and excludes old results', { timeout: 10000 }, async () => {
  const h = await harness([toolResponse('c1'), textResponse('first'), toolResponse('c2'), textResponse('second')]);
  try {
    await h.send(); assert.equal(h.calls, 1);
    assert.equal((await h.retry(lastId(h))).kind, 'success');
    assert.equal(h.calls, 2);
    assert.deepEqual(wireMessages(h.adapter.requests[2]), wireMessages(h.adapter.requests[0]));
    const surface = JSON.stringify(h.agent.session.deriveMessages());
    assert.ok(surface.includes('count-2')); assert.ok(!surface.includes('count-1'));
    assert.ok(!JSON.stringify(h.adapter.requests[2].toolHistory).includes('c1'));
    validateColdHistory(h);
  } finally { await h.close(); }
});

test('preserves multimodal user content and rejects a stale target', { timeout: 10000 }, async () => {
  const h = await harness([textResponse('first'), textResponse('second')]);
  try {
    const content = [...text('inspect attachment'), { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' }];
    await h.send(content); const first = lastId(h);
    assert.equal((await h.retry(first)).kind, 'success');
    assert.deepEqual(h.adapter.requests[1].messages.find(m => m.role === 'user').content, content);
    const before = h.agent.session.seq;
    assert.equal((await h.retry(first)).kind, 'error');
    assert.equal(h.agent.session.seq, before);
  } finally { await h.close(); }
});

test('retries a failed turn that produced no finalized assistant message', { timeout: 10000 }, async () => {
  const h = await harness([new Error('simulated model outage'), textResponse('recovered')]);
  try {
    await h.send(); assert.equal(lastId(h), undefined);
    assert.equal((await h.retry()).kind, 'success');
    assert.deepEqual(wireMessages(h.adapter.requests[1]), wireMessages(h.adapter.requests[0]));
    validateColdHistory(h);
  } finally { await h.close(); }
});

test('keeps old history if a pre-step hook rejects the retry', { timeout: 10000 }, async () => {
  const h = await harness([textResponse('keep me')]);
  try {
    await h.send(); const messages = h.agent.session.deriveMessages();
    h.agent.ctx.on('agent/pre-step', () => ({ kind: 'reject' }));
    assert.equal((await h.retry(lastId(h))).kind, 'error');
    assert.deepEqual(h.agent.session.deriveMessages(), messages);
    assert.equal(h.adapter.requests.length, 1);
  } finally { await h.close(); }
});

test('a retry rejected before admission can itself be retried without retaining the old answer', { timeout: 10000 }, async () => {
  const h = await harness([textResponse('old answer'), textResponse('new answer')]);
  try {
    await h.send();
    const stop = h.agent.ctx.on('agent/pre-step', () => ({ kind: 'reject' }));
    assert.equal((await h.retry(lastId(h))).kind, 'error'); stop();
    assert.equal((await h.retry()).kind, 'success');
    assert.deepEqual(wireMessages(h.adapter.requests[1]), wireMessages(h.adapter.requests[0]));
    validateColdHistory(h);
  } finally { await h.close(); }
});

test('does not absorb queued messages into retry', { timeout: 10000 }, async () => {
  const h = await harness([textResponse('done')]);
  try {
    await h.send();
    h.agent.inject(createUserMessage({ source: { kind: 'user' }, content: text('queued') }));
    const before = h.agent.session.seq;
    assert.equal((await h.retry(lastId(h))).kind, 'error');
    assert.equal(h.agent.session.seq, before); assert.equal(h.agent.inbox.nextStep.length, 1);
  } finally { await h.close(); }
});

test('recovers a failed admission without replaying the previous user question', { timeout: 10000 }, async () => {
  const h = await harness([textResponse('previous answer'), textResponse('new answer')]);
  try {
    await h.send(text('previous question'));
    const dispose = h.agent.ctx.on('agent/request', () => { throw new Error('preparation failed'); });
    await h.send(text('new question')); dispose();
    assert.equal((await h.retry()).kind, 'success');
    assert.deepEqual(h.adapter.requests[1].messages.filter(m => m.source.kind === 'user').map(m => m.content),
      [text('previous question'), text('new question')]);
    validateColdHistory(h);
  } finally { await h.close(); }
});

test('accepts plain retry; old force spelling has no extra privilege', () => {
  assert.deepEqual(parseRetryInput(''), {});
  assert.deepEqual(parseRetryInput('force'), {});
  assert.deepEqual(parseRetryInput('message --force'), { targetMessageId: 'message' });
  assert.equal(parseRetryInput('one two'), undefined);
});
