import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import LocalAttachments from '@deepseek-ai/dsh-attachment-local';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import Projections from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import * as Dream from '../lib/index.js';

export const at = (day, hour = 12) => Date.UTC(2026, 0, day, hour - 8);
export const blocks = text => [{ type: 'text', text }];
export const respond = text => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: blocks(text)[0] },
  { type: 'finish', reason: { kind: 'stop' } },
];
export class Adapter extends LlmAdapter {
  requests = [];
  next = [];
  dreamNext = [];
  proposal;
  async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ['text', 'image'] }; }
  async *stream(options) {
    this.requests.push(options);
    if (options.purpose === 'compaction') {
      if (this.dreamNext.length) { yield* await this.dreamNext.shift()(options); return; }
      const text = options.messages.findLast(m => m.source?.kind === Dream.SOURCE && m.source.form === 'dream').content.find(b => b.type === 'text').text;
      const meta = JSON.parse(text.split('现有记忆与本次范围：\n')[1].split('\n\n本日原文')[0]);
      const p = this.proposal?.(meta) ?? (meta.requiredEpisode === null ? { episodes: [], memories: [] } : {
        episodes: [{ id: meta.requiredEpisode, summary: '我们一起在公园散步，聊起雨后的气味。我想记住这份轻松，也记得下次再看那棵树。' }],
        memories: [{ text: '公园散步是我们愿意再次一起做的事情。', kind: 'experience', state: 'active', evidence: [meta.requiredEpisode] }],
      });
      yield* respond(JSON.stringify(p));
    } else yield* (this.next.shift() ?? respond('我也记得公园里雨后的气味。'));
  }
}
export class Query extends SessionQueryEngine { name = 'dream-test-query'; }
export async function harness(options = {}, agentOptions = { provider: 'mock', model: 'same-self' }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dream-native-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const ctx = new Context();
  for (const plugin of [LlmRuntime, SessionStore, Projections, TokenMeter, SystemPrompt, Tools, AgentRegistry, Query, LocalAttachments]) await ctx.plugin(plugin);
  await ctx.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' });
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(Dream, { auto: false, quietMinutes: 0, dataDir: join(root, 'objects'), ...options });
  const adapter = new Adapter(); ctx.llm.registerAdapter(['mock', 'kimi-coding'], adapter);
  let handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), agentOptions });
  let agent = handle.agent;
  return { ctx, root, get agent() { return agent; }, adapter, service: ctx.dreamContext,
    async restart() {
      const id = agent.id;
      await handle.dispose();
      handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions });
      agent = handle.agent;
    },
    async say(text) {
      agent.followup(createUserMessage({ content: blocks(text), source: { kind: 'user' } }));
      await agent.whenIdle();
      const end = agent.session.snapshotEvents().findLast(e => e.type === 'turn/end');
      assert.equal(end.data.reason.kind, 'completed', JSON.stringify(end));
    },
    async tool(name, args, prompt = '想起公园散步，看看原来的记录。', { expectError = false } = {}) {
      adapter.next.push([
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ], respond('记起了这段经历。'));
      await this.say(prompt);
      const event = agent.session.snapshotEvents().findLast(e => e.type === 'tool/result');
      assert.equal(event.data.message.isError, expectError);
      return event.data.message;
    },
    async close() {
      await handle.dispose(); await ctx.fiber.dispose();
      if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
      await rm(root, { recursive: true, force: true });
    },
  };
}
export function visible(session) { return JSON.stringify(session.deriveMessages().map(m => ({ role: m.role, content: m.content }))); }
export function strictReplay(session) {
  const artifact = JSON.parse(JSON.stringify({ header: { ...session.header, delegationDepth: session.header.delegationDepth ?? 0 }, events: session.snapshotEvents() }));
  const restore = sessionFormatCatalog.createRestore(sessionFormatCatalog.encodeCurrentHeader(artifact.header, session.inheritedEventCount), { recovery: 'strict', validation: 'current' });
  for (const event of artifact.events) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event));
  const restored = restore.finish();
  assert.equal(restored.events.length, artifact.events.length);
  const replay = Session.create(SessionId(session.id), artifact.events, artifact.header, session.inheritedEventCount);
  assert.deepEqual(replay.deriveMessages(), session.deriveMessages());
  return replay;
}
