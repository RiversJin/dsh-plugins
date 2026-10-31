import type {} from '@deepseek-ai/dsh-compaction-basic';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import { createDeveloperMessage, freezeMessage, type ToolSchema, type Message } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-session-query';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-token-meter';
import { z } from 'zod';

interface SummarizationInput { readonly messages: readonly Message[]; readonly tools?: readonly ToolSchema[]; }

export const name = 'dsh-context-cleanup';
export const inject = ['sessionProjections', 'sessionQuery', 'tokenMeter', 'systemPrompt'];
export const COLD_IDLE_MS = 5 * 60 * 60_000;
export const PROTECTED_TURNS = 2;
export const LIFETIME_NOTICE = '框架注入的记忆召回和时间读数是临时参考。记忆召回在 6 小时后移出，记忆召回与时间读数都不进入对话摘要或视觉归档。会话闲置满 5 小时后，下次发言前会清理旧召回、只保留最新时间读数，并剪枝最近 2 轮以外的长工具输出；没有最低 token 收益门槛。工具剪枝时也会清理旧时间读数。需要原始资料时请重新检索或读取，不要假设这些临时内容会永久留在上下文中。';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:dsh-context-cleanup': { kind: 'plugin:dsh-context-cleanup'; form: 'removed' };
  }
}
// The local basic-compaction patch exposes one shared input seam used by text,
// optical and fallback summaries. Keep this declaration for upstream typings.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'compaction/summarize-input'(payload: { agent: Agent; input: SummarizationInput; signal?: AbortSignal }, next: () => Promise<SummarizationInput>): Promise<SummarizationInput>;
  }
}

interface CleanupState {
  ended: { turn: number; time: number }[];
  open: { turn: number; idleMs: number; protectedTurns: number[] } | null;
  toolPruneSeq: number;
  compactSeq: number;
  cleanedSeq: number;
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { contextCleanup: CleanupState; }
}
export const cleanupProjection: ProjectionDefinition<'contextCleanup'> = {
  key: 'contextCleanup', stateVersion: 1,
  stateSchema: z.object({
    ended: z.array(z.object({ turn: z.number(), time: z.number() })),
    open: z.object({ turn: z.number(), idleMs: z.number(), protectedTurns: z.array(z.number()) }).nullable(),
    toolPruneSeq: z.number(), compactSeq: z.number(), cleanedSeq: z.number(),
  }),
  init: () => ({ ended: [], open: null, toolPruneSeq: -1, compactSeq: -1, cleanedSeq: -1 }),
  apply(state, event) {
    if (event.type === 'turn/start') return { ...state, open: {
      turn: event.data.turn,
      idleMs: state.ended.length ? Math.max(0, event.time - state.ended.at(-1)!.time) : 0,
      protectedTurns: state.ended.map(row => row.turn),
    } };
    if (event.type === 'turn/end') return { ...state, open: null,
      ended: [...state.ended, { turn: event.data.turn, time: event.time }].slice(-PROTECTED_TURNS) };
    if (event.type === 'tool/result' && event.surfaceOp !== 'append') return { ...state, toolPruneSeq: event.seq };
    if (event.type === 'compaction/end' && event.data.error === undefined) return { ...state, compactSeq: event.seq };
    if (event.type === 'developer/message' && event.data.message.source.kind === 'plugin:dsh-context-cleanup') return { ...state, cleanedSeq: event.seq };
    return state;
  },
};

/** Trust producer metadata only; a human quoting a clock or recall is untouched. */
export function transientKind(message: Message): 'time' | 'recall' | undefined {
  if (message.role !== 'user') return undefined;
  const source = message.source as { kind: string; form?: string; plugin?: string };
  if ((source.kind === 'time-context' || (source.kind === 'plugin' && source.plugin === 'time-context')) && source.form === 'snapshot') return 'time';
  if (source.kind === 'plugin:memory' && (source.form === 'recall' || source.form === 'recall-removed')) return 'recall';
  return undefined;
}

export function filterCompactionInput(input: SummarizationInput): SummarizationInput {
  return { ...input, messages: input.messages.filter(message => transientKind(message) === undefined) };
}

/** Native replacement protocol: preserve tool identity, rich blocks and raw log. */
export function pruneColdTools(
  session: Session, events: readonly SessionEvent[], protectedTurns: readonly number[],
  pruner: ToolResultPruner, estimate: (message: Message) => number,
): number {
  let count = 0;
  for (const seq of [...session.surface.nodes]) {
    const event = events[seq];
    if (event?.type !== 'tool/result' || protectedTurns.includes(event.data.turn)) continue;
    const original = event.data.message;
    const content = pruner.pruneContent(original.content);
    if (content === null) continue;
    session.append('compaction/prune', {
      shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount: estimate(original),
    });
    session.append('tool/result', { ...event.data, message: freezeMessage({ ...original, content }) }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
    });
    count++;
  }
  return count;
}

/** Empty developer replacements disappear from derived messages, unlike empty
 * user messages. Commit only inside an open step, before request admission. */
export function removeTransientContext(
  session: Session, events: readonly SessionEvent[], position: { turn: number; step: number },
  options: { recalls: boolean; keepLatestTime: boolean }, estimate: (message: Message) => number,
): number {
  const candidates = session.surface.nodes.flatMap(seq => {
    const event = events[seq];
    if (event?.type !== 'user/message') return [];
    const kind = transientKind(event.data);
    return kind === undefined ? [] : [{ seq, message: event.data, kind }];
  });
  const latestTime = options.keepLatestTime ? candidates.findLast(row => row.kind === 'time')?.seq : undefined;
  let count = 0;
  for (const { seq, message, kind } of candidates) {
    if ((kind === 'time' && seq === latestTime) || (kind === 'recall' && !options.recalls)) continue;
    session.append('compaction/prune', {
      shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount: estimate(message),
    });
    session.append('developer/message', { ...position, message: createDeveloperMessage({
      content: [], source: { kind: 'plugin:dsh-context-cleanup', form: 'removed' },
    }) }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
    count++;
  }
  return count;
}

export function apply(ctx: Context): void {
  ctx.sessionProjections.register(cleanupProjection);
  ctx.systemPrompt.section({ name, order: 80, text: LIFETIME_NOTICE });
  const checkedTurns = new WeakMap<Agent, number>();
  const pending = new WeakMap<Agent, { recalls: boolean; keepLatestTime: boolean }>();
  const processed = new WeakMap<Agent, number>();
  const stateOf = (agent: Agent) => ctx.sessionProjections.stateOf(agent.session, 'contextCleanup')!;
  const estimate = (message: Message) => ctx.tokenMeter.estimateMessage(message);
  const observe = (agent: Agent, signal: AbortSignal) => ctx.sessionQuery.observeSession(agent.session.id, { signal, projectionMode: 'none' });

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const before = stateOf(agent);
    const cold = step === 1 && before.open?.turn === turn && before.open.idleMs >= COLD_IDLE_MS;
    if (cold && checkedTurns.get(agent) !== turn && !signal.aborted) {
      const pruner = ctx.get('agentPresets')?.serviceFor(agent, 'toolResultPruner') ?? agent.ctx.get('toolResultPruner');
      if (pruner) {
        const observation = await observe(agent, signal);
        try {
          signal.throwIfAborted();
          pruneColdTools(agent.session, observation.events, before.open!.protectedTurns, pruner, estimate);
        } finally { observation[Symbol.dispose](); }
      }
      checkedTurns.set(agent, turn);
      pending.set(agent, { recalls: true, keepLatestTime: true });
    }
    const decision = await next();
    if (signal.aborted || decision.kind === 'reject') return decision;
    const state = stateOf(agent);
    const watermark = Math.max(state.cleanedSeq, processed.get(agent) ?? -1);
    const compacted = state.compactSeq > watermark;
    if (compacted || state.toolPruneSeq > watermark || pending.has(agent)) {
      pending.set(agent, {
        recalls: compacted || (pending.get(agent)?.recalls ?? false),
        // A newly prepared sample will be admitted after agent/request.
        keepLatestTime: !compacted && !decision.messages.some(message => transientKind(message) === 'time'),
      });
    }
    return decision;
  }, { prepend: true });

  ctx.on('agent/request', async ({ agent, turn, step, signal }, next) => {
    const config = await next();
    const options = pending.get(agent);
    if (!options || signal.aborted) return config;
    const observation = await observe(agent, signal);
    try {
      signal.throwIfAborted();
      removeTransientContext(agent.session, observation.events, { turn, step }, options, estimate);
      const state = stateOf(agent);
      processed.set(agent, Math.max(state.compactSeq, state.toolPruneSeq, state.cleanedSeq));
      pending.delete(agent);
    } finally { observation[Symbol.dispose](); }
    return config;
  }, { prepend: true });
  ctx.on('compaction/summarize-input', async (_payload, next) => filterCompactionInput(await next()), { prepend: true });
}
