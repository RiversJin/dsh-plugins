import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import Projections from '@deepseek-ai/dsh-session-projection';
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import * as Trajectory from '../lib/index.js';

export const text = value => [{ type: 'text', text: value }];
export const output = { schema: { type: 'json' }, render: (_args, value) => text(JSON.stringify(value)) };
export const respond = value => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: text(value)[0] },
  { type: 'finish', reason: { kind: 'stop' } },
];
export function calls(...requests) {
  return [...requests.flatMap(([name, args], index) => [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(crypto.randomUUID()), name, arguments: JSON.stringify(args) } },
  ]), { type: 'finish', reason: { kind: 'tool-calls' } }];
}
class Adapter extends LlmAdapter {
  requests = []; scripts = [];
  async resolveModel(provider, model) { return { provider, id: model, name: model }; }
  async *stream(options) {
    this.requests.push(options);
    const script = this.scripts.shift();
    if (!script) throw new Error('Fixture script exhausted');
    yield* typeof script === 'function' ? await script(options) : script;
  }
}
class Query extends SessionQueryEngine { name = 'fixture-session-query'; }
export async function harness({ archiveDir, root, resume, setup, scoped = false, autoAnchorToolCalls = 0, autoAnchorReminderTurns = 0, autoAnchorReminderMinutes = 0 } = {}) {
  const ctx = new Context();
  for (const plugin of [LlmRuntime, SessionStore, Projections, SystemPrompt, ToolRuntime, AgentRegistry, Query]) await ctx.plugin(plugin);
  if (root) await ctx.plugin(Persistence, { root, compression: 'none' });
  await ctx.plugin(AgentLoop, { agents: [] });
  const trajectoryConfig = { archiveDir, autoAnchorToolCalls, autoAnchorReminderTurns, autoAnchorReminderMinutes };
  if (!scoped) await ctx.plugin(Trajectory, trajectoryConfig);
  const adapter = new Adapter(); ctx.llm.registerAdapter(['mock'], adapter);
  ctx.tools.register(defineTool({ name: 'fixture', description: 'test', parameters: { value: { type: 'string', required: true } }, output, async execute(args) { return args.value; } }));
  await setup?.(ctx);
  const options = { agentOptions: { provider: 'mock', model: 'test' }, ...(scoped ? { setup: async agentCtx => { await agentCtx.plugin(Trajectory, trajectoryConfig); } } : {}) };
  const handle = resume ? await ctx.agents.resume({ ...options, resumeSessionId: SessionId(resume) }) : await ctx.agents.create({ ...options, sessionId: SessionId(crypto.randomUUID()) });
  const agent = handle.agent;
  return { ctx, agent, adapter, handle,
    state() { return ctx.sessionProjections.stateOf(agent.session, 'trajectory'); },
    events() { return agent.session.snapshotEvents(); },
    async send(scripts, prompt = 'fixture human request') {
      adapter.scripts.push(...scripts);
      agent.followup(createUserMessage({ content: text(prompt), source: { kind: 'user' } })); await agent.whenIdle();
      const end = agent.session.snapshotEvents().findLast(e => e.type === 'turn/end');
      assert.equal(end?.data.reason.kind, 'completed', JSON.stringify(end));
    },
    async tool(name, args) {
      const start = agent.session.seq;
      await this.send([calls([name, args]), respond('fixture answer')]);
      const event = agent.session.snapshotEvents().slice(start).findLast(e => e.type === 'tool/result' && e.surfaceOp === 'append');
      assert.ok(event);
      const raw = event.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return { error: event.data.message.isError === true, raw, value: event.data.message.isError ? null : JSON.parse(raw) };
    },
    async close() { await handle.dispose(); await ctx.fiber.dispose(); },
  };
}
