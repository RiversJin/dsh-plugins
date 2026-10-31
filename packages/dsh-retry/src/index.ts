import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CommandResult } from '@deepseek-ai/dsh-commands';
import { createDeveloperMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import {
  deriveEventMessage,
  SessionSeq,
  type Session,
  type SessionEvent,
} from '@deepseek-ai/dsh-session';

export const name = 'dsh-retry';
export const inject = ['commands', 'sessions', 'sessionPersistence'];
import type {} from '@deepseek-ai/dsh-session-persistence';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:dsh-retry': { kind: 'plugin:dsh-retry'; form: 'reset' };
  }
}

export type RetryPlanFailureCode =
  | 'no-request'
  | 'no-completed-turn'
  | 'target-not-latest';

export interface RetryPlanFailure {
  ok: false;
  code: RetryPlanFailureCode;
}

export interface RetryPlan {
  ok: true;
  startSeq: number;
  endSeq: number;
  sourceEventSeqs: number[];
  userMessage: UserMessage;
  userMessages: UserMessage[];
  latestAssistantMessageId?: string;

}

export type RetryPlanResult = RetryPlan | RetryPlanFailure;

function directUserMessage(event: SessionEvent | undefined): UserMessage | undefined {
  if (event === undefined) return undefined;
  const message = deriveEventMessage(event);
  if (message?.role !== 'user' || message.source.kind !== 'user') return undefined;
  return message as UserMessage;
}

/** Recover input claimed before adapter preparation failed to admit user/message. */
function claimedInputs(events: readonly SessionEvent[], afterSeq: number): UserMessage[] {
  const lanes: Record<string, UserMessage[]> = { 'next-turn': [], 'next-step': [] };
  const claimed: UserMessage[] = [];
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue;
    const { target, start, removedCount, inserted } = event.data;
    const removed = lanes[target]!.splice(start, removedCount ?? 0, ...inserted);
    if (event.seq > afterSeq) claimed.push(...removed.filter(message => message.source.kind === 'user'));
  }
  return claimed;
}

/**
 * Select the latest whole-turn request on the active model surface. Original
 * steering remains part of that request; old synthetic retries are accepted
 * only through their explicit plugin source, never by guessing an older turn.
 */
export function planRetry(
  events: readonly SessionEvent[],
  surfaceNodes: readonly number[],
  targetMessageId?: string,
): RetryPlanResult {
  let lastBoundary: SessionEvent<'turn/start' | 'turn/end'> | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'turn/start' && event?.type !== 'turn/end') continue;
    lastBoundary = event;
    break;
  }
  if (lastBoundary?.type !== 'turn/end') {
    return { ok: false, code: 'no-completed-turn' };
  }

  const turnStart = events.findLast(event => event.type === 'turn/start');
  let requestIndex = surfaceNodes.findIndex(seq => seq > (turnStart?.seq ?? -1)
    && directUserMessage(events[seq]!) !== undefined);
  if (requestIndex < 0) {
    const latestEvents = events.filter(event => event.seq > (turnStart?.seq ?? -1));
    const legacyRetry = latestEvents.some(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin:dsh-retry');
    if (!legacyRetry) {
      const inputs = claimedInputs(events, turnStart?.seq ?? -1);
      if (inputs.length && !latestEvents.some(event => directUserMessage(event))) {
        if (targetMessageId !== undefined) return { ok: false, code: 'target-not-latest' };
        const previous = (inputs[0]!.source as UserMessage['source'] & {
          dshRetry?: { startSeq: number; endSeq: number };
        }).dshRetry;
        if (previous && Number.isSafeInteger(previous.startSeq) && Number.isSafeInteger(previous.endSeq)) {
          const first = surfaceNodes.indexOf(SessionSeq(previous.startSeq));
          const last = surfaceNodes.indexOf(SessionSeq(previous.endSeq));
          if (first >= 0 && last >= first) return { ok: true, ...previous,
            sourceEventSeqs: [...surfaceNodes.slice(first, last + 1)], userMessage: inputs[0]!, userMessages: inputs };
        }
        return { ok: true, startSeq: -1, endSeq: -1, sourceEventSeqs: [], userMessage: inputs[0]!, userMessages: inputs };
      }
      return { ok: false, code: 'no-request' };
    }
    // Compatibility for old retries whose human replacement preceded turn/start.
    for (let index = surfaceNodes.length - 1; index >= 0; index--) {
      if (directUserMessage(events[surfaceNodes[index]!]) !== undefined) {
        requestIndex = index;
        break;
      }
    }
  }
  const userMessage = requestIndex < 0 ? undefined
    : directUserMessage(events[surfaceNodes[requestIndex]!]!);
  if (requestIndex < 0 || userMessage === undefined) {
    return { ok: false, code: 'no-request' };
  }

  const requestSeq = surfaceNodes[requestIndex];
  if (requestSeq === undefined || lastBoundary.seq < requestSeq) {
    return { ok: false, code: 'no-completed-turn' };
  }

  let latestAssistantMessageId: string | undefined;
  for (let index = surfaceNodes.length - 1; index >= requestIndex; index -= 1) {
    const seq = surfaceNodes[index];
    if (seq === undefined) continue;
    const event = events[seq];
    if (event === undefined) continue;
    const message = deriveEventMessage(event);
    if (message?.role === 'assistant') {
      latestAssistantMessageId = message.id;
      break;
    }
  }
  if (targetMessageId !== undefined && latestAssistantMessageId !== targetMessageId) {
    return { ok: false, code: 'target-not-latest' };
  }

  const sourceEventSeqs = surfaceNodes.slice(requestIndex);
  const endSeq = sourceEventSeqs.at(-1);
  if (endSeq === undefined) return { ok: false, code: 'no-request' };

  const userMessages = sourceEventSeqs.flatMap(seq => {
    const message = directUserMessage(events[seq]!);
    return message === undefined ? [] : [message];
  });

  return {
    ok: true,
    startSeq: requestSeq,
    endSeq,
    sourceEventSeqs: [...sourceEventSeqs],
    userMessage,
    ...(latestAssistantMessageId === undefined ? {} : { latestAssistantMessageId }),
    userMessages,
  };
}

/**
 * Retract the superseded attempt inside the replay's first open step. Empty
 * developer content is a native deletion marker: deriveMessages omits it, so
 * neither this marker nor any retry instruction reaches the model.
 */
export function commitRetrySurface(
  session: Session, plan: RetryPlan, position: { turn: number; step: number },
): number {
  const marker = { turn: position.turn, step: position.step,
    message: createDeveloperMessage({ content: [], source: { kind: 'plugin:dsh-retry' as const, form: 'reset' as const } }) };
  if (!plan.sourceEventSeqs.length) return session.append('developer/message', marker, { surfaceOp: 'append' }).seq;
  const first = session.surface.nodes.indexOf(SessionSeq(plan.startSeq));
  const last = session.surface.nodes.indexOf(SessionSeq(plan.endSeq));
  if (first < 0 || last < first) throw new Error('会话上下文已变化，请重新尝试重试。');
  const sourceEventSeqs = session.surface.nodes.slice(first, last + 1);
  return session.append('developer/message', marker, {
    surfaceOp: { op: 'replace', startSeq: SessionSeq(plan.startSeq), endSeq: SessionSeq(plan.endSeq) },
    sourceEventSeqs: [...sourceEventSeqs],
  }).seq;
}

export function replayInput(message: UserMessage, plan: RetryPlan): UserMessage {
  // Preserve attachments and producer metadata, changing only the admission id.
  const { id: _id, role: _role, ...input } = message;
  return createUserMessage({ ...input, source: { ...input.source,
    dshRetry: { startSeq: plan.startSeq, endSeq: plan.endSeq } } });
}

export function parseRetryInput(rawInput: string): { targetMessageId?: string } | undefined {
  const parts = rawInput.trim().split(/\s+/u).filter(Boolean);
  // Old force aliases remain accepted, but no longer change behavior.
  const targets = parts.filter(part => part !== 'force' && part !== '--force');
  if (targets.length > 1) return undefined;
  return targets[0] === undefined ? {} : { targetMessageId: targets[0] };
}

function planFailure(result: RetryPlanFailure): CommandResult {
  switch (result.code) {
    case 'no-request':
      return { kind: 'error', text: '找不到可重新生成的用户请求。' };
    case 'no-completed-turn':
      return { kind: 'error', text: '当前会话仍在运行，暂时不能重试。' };
    case 'target-not-latest':
      return { kind: 'error', text: '只能重新生成当前最后一条回答。' };
  }
}

export async function retryAgent(
  ctx: Context,
  agent: Agent,
  targetMessageId: string | undefined,
  requestSignal: AbortSignal,
): Promise<CommandResult> {
  if (agent.status !== 'idle') return { kind: 'error', text: '当前会话仍在运行，暂时不能重试。' };

  let release: (() => void) | undefined;
  try {
    const prepared = await agent.runMaintenance(async maintenanceSignal => {
      const signal = AbortSignal.any([requestSignal, maintenanceSignal]);
      signal.throwIfAborted();
      if ((agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0)) return { kind: 'error' as const, text: '会话有排队消息，请先处理或移除后再重试。' };
      const through = agent.session.seq;
      await ctx.sessions.flush(agent.session);
      const handle = await ctx.sessionPersistence.open(agent.session.id, 'read', { signal });
      const events: SessionEvent[] = [];
      try {
        for (let offset = 0; offset < through;) {
          signal.throwIfAborted();
          const page = await handle.read(offset, Math.min(512, through - offset), { signal });
          if (page.events.length === 0) throw new Error('会话历史尚未完整保存');
          events.push(...page.events);
          offset += page.events.length;
        }
      } finally { await handle.close(); }
      signal.throwIfAborted();
      const plan = planRetry(events, agent.session.surface.nodes, targetMessageId);
      if (!plan.ok) return planFailure(plan);
      // A waiting user input must not become part of the replay while we read.
      if ((agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0)) return { kind: 'error' as const, text: '读取期间收到新消息，请先处理后再重试。' };
      const replay = plan.userMessages.map(message => replayInput(message, plan));
      const admitted = Promise.withResolvers<number>();
      // Handle early failures without ever leaving a rejected promise unobserved.
      void admitted.promise.catch(() => {});
      let reset = false;
      const disposers: (() => void)[] = [];
      release = () => { for (const dispose of disposers.splice(0)) dispose(); };
      disposers.push(agent.ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        if (decision.kind !== 'enter' || !decision.messages.some(message => message.id === replay[0]!.id)) return decision;
        // Steering received during the original turn remains part of the same
        // user request, in order; it must not be discarded by a whole-turn retry.
        return { ...decision, messages: decision.messages.flatMap(message =>
          message.id === replay[0]!.id ? replay : [message]) };
      }));
      disposers.push(agent.ctx.on('agent/request', async (payload, next) => {
        const config = await next();
        if (reset) return config;
        payload.signal.throwIfAborted();
        const seq = commitRetrySurface(agent.session, plan, payload);
        reset = true;
        admitted.resolve(seq);
        return config;
      }));
      disposers.push(agent.ctx.on('agent/error', ({ error }) => { if (!reset) admitted.reject(error); }));
      disposers.push(agent.ctx.on('agent/status', ({ status }) => {
        if (status === 'idle' && !reset) admitted.reject(new Error('重试在生成开始前结束，旧回答已保留。'));
      }));
      agent.followup(replay[0]!);
      return { admitted: admitted.promise, reject: admitted.reject };
    });
    if (!('admitted' in prepared)) return prepared;
    void agent.whenIdle().then(() => prepared.reject(new Error('重试在生成开始前结束，旧回答已保留。')), prepared.reject);
    const sourceEventSeq = await prepared.admitted;
    return { kind: 'success', sourceEventSeq: SessionSeq(sourceEventSeq), text: '已从原用户请求重新开始本轮生成。' };
  } catch (error) {
    return { kind: 'error', text: requestSignal.aborted ? '重试请求已取消。'
      : `无法开始重试：${error instanceof Error ? error.message : String(error)}` };
  } finally { release?.(); }
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.commands.register({
    name: 'retry',
    description: '从原用户请求重新执行本轮生成',
    handler: invocation => {
      const parsed = parseRetryInput(invocation.rawInput);
      if (parsed === undefined) {
        return {
          kind: 'error',
          text: '用法：/retry',
        };
      }
      return retryAgent(
        ctx,
        invocation.agent,
        parsed.targetMessageId,
        invocation.signal,
      );
    },
  }), 'dsh-retry: command');
}
