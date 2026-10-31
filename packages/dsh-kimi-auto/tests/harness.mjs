import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import Projections from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { estimateMessage } from '@deepseek-ai/dsh-token-meter/estimate';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import * as Auto from '../lib/index.js';

export const text = value => [{ type: 'text', text: value }];
export function response(value = 'OK', inputTokens) {
  return options => [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: text(value)[0] },
    { type: 'usage', usage: { inputTokens: inputTokens ?? options.messages.reduce((n, m) => n + estimateMessage(m), 0),
      outputTokens: 4, totalTokens: (inputTokens ?? options.messages.reduce((n, m) => n + estimateMessage(m), 0)) + 4 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}
export const failure = (code, message = code) => [{ type: 'finish', reason: { kind: 'error', failure: { code, message } } }];
export class Adapter extends LlmAdapter {
  requests = []; scripts = [];
  async resolveModel(provider, model) { return { provider, id: model, name: model,
    reasoning: { efforts: ['low', 'medium', 'high'].map(id => ({ id, name: id })) }, context: { contextWindow: model === Auto.SMALL ? Auto.SMALL_WINDOW : Auto.LARGE_WINDOW } }; }
  async *stream(options) {
    this.requests.push(options);
    const script = this.scripts.shift();
    if (!script) throw new Error('Fixture script exhausted');
    yield* typeof script === 'function' ? await script(options) : script;
  }
}
export async function harness({ config, root, resume, seed, setup, options, adapter = new Adapter() } = {}) {
  const ctx = new Context();
  for (const plugin of [LlmRuntime, SessionStore, Projections, SystemPrompt, ToolRuntime, AgentRegistry, TokenMeter]) await ctx.plugin(plugin);
  if (root) await ctx.plugin(Persistence, { root, compression: 'none' });
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(Auto, config ?? {});
  ctx.llm.registerAdapter(['kimi-coding', 'fixture-other'], adapter);
  ctx.systemPrompt.section({ name: 'fixture-model-template', order: 1, text: 'Stable system. Provider={{provider}} Model={{model}}.' });
  await setup?.(ctx);
  const creation = { meta: { delegationDepth: 0 }, agentOptions: { provider: Auto.PROVIDER, model: Auto.LARGE, ...options },
    ...(seed ? { seed, meta: { isSeeded: true, delegationDepth: 0 }, inheritedEventCount: seed.length } : {}) };
  const handle = resume ? await ctx.agents.resume({ ...creation, resumeSessionId: SessionId(resume) })
    : await ctx.agents.create({ ...creation, sessionId: SessionId(crypto.randomUUID()) });
  const agent = handle.agent;
  return { ctx, agent, adapter, handle,
    state() { return ctx.sessionProjections.stateOf(agent.session, 'kimiAuto'); },
    events() { return agent.session.snapshotEvents(); },
    async send(scripts = [response()], prompt = 'fixture human request', expected = 'completed') {
      adapter.scripts.push(...scripts);
      agent.followup(createUserMessage({ content: text(prompt), source: { kind: 'user' } }));
      await agent.whenIdle();
      const end = agent.session.snapshotEvents().findLast(e => e.type === 'turn/end');
      assert.equal(end?.data.reason.kind, expected, JSON.stringify(end));
      return adapter.requests.at(-1);
    },
    async close() { await handle.dispose(); await ctx.fiber.dispose(); },
  };
}
