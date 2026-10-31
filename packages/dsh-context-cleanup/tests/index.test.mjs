import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools';
import Projections from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import * as TimeContext from '@deepseek-ai/dsh-time-context';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import * as Cleanup from '../lib/index.js';
const text = value => [{ type: 'text', text: value }];
const response = value => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: value },
  { type: 'block-end', index: 0, block: text(value)[0] },
  { type: 'finish', reason: { kind: 'stop' } },
];
class Adapter extends LlmAdapter {
  requests = [];
  async resolveModel(provider, model) { return { provider, id: model, name: model }; }
  async *stream(options) {
    this.requests.push(options);
    const lastUser = options.messages.findLast(m => m.source.kind === 'user');
    const tool = lastUser.content[0].text.startsWith('tool');
    const last = options.messages.at(-1);
    if (tool && last?.role !== 'tool') {
      const id = crypto.randomUUID();
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: 'fixture', argumentsDelta: '{}' };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'fixture', arguments: '{}' } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else yield* response('fixture answer');
  }
}
async function harness() {
  const ctx = new Context(), events = [];
  ctx.on('session/event', (_session, event) => events.push(event));
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(Projections);
  await ctx.plugin(SystemPrompt, { personaPrefix: 'test' }); await ctx.plugin(TokenMeter);
  await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(ToolResultPruner, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 });
  let released = 0;
  ctx.provide('sessionQuery');
  ctx.set('sessionQuery', { async observeSession() { return { events: [...events], [Symbol.dispose]() { released++; } }; } });
  await ctx.plugin(TimeContext, { refreshIntervalMs: 1800000, timeZone: 'Asia/Singapore' });
  await ctx.plugin(Cleanup);
  let count = 0;
  ctx.tools.register(defineContentToolFixture({ name: 'fixture', description: 'test', parameters: {},
    async execute() { return text(`OUTPUT-${++count}-` + 'x'.repeat(9000)); } }));
  const adapter = new Adapter(); ctx.llm.registerAdapter(['mock'], adapter);
  const handle = await ctx.agents.create({ sessionId: SessionId(crypto.randomUUID()), agentOptions: { provider: 'mock', model: 'test' } });
  const agent = handle.agent;
  return { ctx, events, agent, adapter, get released() { return released; },
    async send(value = 'hello') { agent.followup(createUserMessage({ content: text(value), source: { kind: 'user' } })); await agent.whenIdle();
      const end = events.findLast(e => e.type === 'turn/end'); assert.equal(end?.data.reason.kind, 'completed', JSON.stringify(end)); },
    recall() { agent.session.append('user/message', createUserMessage({ content: text('RECALL_NEEDLE'), source: { kind: 'plugin:memory', form: 'recall', injectedAt: Date.now() } }), { surfaceOp: 'append' }); },
    async close() { await handle.dispose(); await ctx.fiber.dispose(); },
  };
}
function strictReplay(h) {
  const artifact = JSON.parse(JSON.stringify({ header: { ...h.agent.session.header, delegationDepth: 0, isSeeded: false }, events: h.events }));
  const restore = sessionFormatCatalog.createRestore(sessionFormatCatalog.encodeCurrentHeader(artifact.header, 0), { recovery: 'strict', validation: 'current' });
  for (const event of artifact.events) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event));
  assert.equal(restore.finish().events.length, artifact.events.length);
  assert.deepEqual(Session.create(SessionId(artifact.header.id), artifact.events, artifact.header, 0).deriveMessages(), h.agent.session.deriveMessages());
}

test('exactly 5h cold cleanup covers all three, protects two turns, and has no minimum savings', async () => {
  assert.equal(Cleanup.COLD_IDLE_MS, 5 * 60 * 60_000);
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  const h = await harness();
  try {
    for (let i = 0; i < 3; i++) { await h.send('tool ' + i); now += 1800001; }
    h.recall();
    const previousEnd = h.events.findLast(e => e.type === 'turn/end').time;
    const beforeTools = h.agent.session.deriveMessages().filter(m => m.role === 'tool');
    const delta = h.ctx.tokenMeter.estimateMessage(beforeTools[0]) - h.ctx.tokenMeter.estimateMessage({ ...beforeTools[0], content: h.ctx.toolResultPruner.pruneContent(beforeTools[0].content) });
    assert.ok(delta > 0 && delta < 4096, `fixture saved ${delta}`);
    now = previousEnd + 5 * 60 * 60_000;
    await h.send('wake [09-28 08:00] human quote');
    const messages = h.agent.session.deriveMessages();
    const toolMessages = messages.filter(m => m.role === 'tool');
    assert.ok(toolMessages[0].content[0].text.includes('middle pruned'));
    assert.deepEqual(toolMessages.slice(1), beforeTools.slice(1));
    assert.equal(messages.filter(m => Cleanup.transientKind(m) === 'time').length, 1);
    assert.ok(!JSON.stringify(messages).includes('RECALL_NEEDLE'));
    assert.ok(JSON.stringify(messages).includes('[09-28 08:00] human quote'));
    assert.ok(!h.adapter.requests.at(-1).messages.some(m => m.source.kind === 'plugin:dsh-context-cleanup'));
    assert.ok(JSON.stringify(h.events).includes('RECALL_NEEDLE'));
    strictReplay(h);
    const prunes = h.events.filter(e => e.type === 'compaction/prune').length;
    await h.send('warm followup');
    assert.equal(h.events.filter(e => e.type === 'compaction/prune').length, prunes);
    strictReplay(h); assert.ok(h.released >= 2);
  } finally { await h.close(); Date.now = realNow; }
});

test('warm session does not cold-prune; time snapshots refresh at 30min', async () => {
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  const h = await harness();
  try {
    await h.send(); h.recall(); now += 10 * 60000; await h.send();
    assert.equal(h.events.filter(e => e.type === 'user/message' && e.data.source.kind === 'time-context').length, 1);
    now += 20 * 60000; await h.send();
    assert.equal(h.events.filter(e => e.type === 'user/message' && e.data.source.kind === 'time-context').length, 2);
    now = h.events.findLast(e => e.type === 'turn/end').time + 5 * 60 * 60_000 - 1; await h.send();
    assert.ok(h.agent.session.deriveMessages().some(m => Cleanup.transientKind(m) === 'recall'));
    assert.equal(h.events.filter(e => e.type === 'compaction/prune').length, 0);
    strictReplay(h);
  } finally { await h.close(); Date.now = realNow; }
});

test('cold cleanup removes injections even with no tool outputs', async () => {
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  const h = await harness();
  try {
    await h.send(); h.recall(); now += Cleanup.COLD_IDLE_MS; await h.send('wake');
    assert.equal(h.agent.session.deriveMessages().filter(m => Cleanup.transientKind(m) === 'time').length, 1);
    assert.ok(!JSON.stringify(h.agent.session.deriveMessages()).includes('RECALL_NEEDLE'));
    strictReplay(h);
  } finally { await h.close(); Date.now = realNow; }
});

test('native pressure tool pruning also cleans old clocks on the next model request', async () => {
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  const h = await harness();
  try {
    await h.send('tool first'); now += 1800000; await h.send('second'); h.recall();
    const off = h.agent.ctx.on('agent/pre-step', async (_payload, next) => { h.ctx.toolResultPruner.pruneSession(h.agent.session); return next(); });
    await h.send('followup'); off();
    assert.equal(h.agent.session.deriveMessages().filter(m => Cleanup.transientKind(m) === 'time').length, 1);
    assert.ok(JSON.stringify(h.agent.session.deriveMessages()).includes('RECALL_NEEDLE'));
    strictReplay(h);
  } finally { await h.close(); Date.now = realNow; }
});

test('the shared summarizer input seam strips time and recall, keeping literal human quotes', async () => {
  const h = await harness();
  try {
    await h.send('[time-context] human quote'); h.recall();
    const input = { messages: h.agent.session.deriveMessages(), tools: [] };
    const filtered = await h.ctx.waterfall('compaction/summarize-input', { agent: h.agent, input }, async () => input);
    assert.ok(filtered.messages.every(m => Cleanup.transientKind(m) === undefined));
    assert.ok(JSON.stringify(filtered).includes('[time-context] human quote'));
    assert.ok(input.messages.some(m => Cleanup.transientKind(m) === 'time'));
  } finally { await h.close(); }
});
