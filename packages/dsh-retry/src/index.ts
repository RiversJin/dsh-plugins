import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CommandResult } from '@deepseek-ai/dsh-commands';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import {
  deriveEventMessage,
  type Session,
  type SessionEvent,
} from '@deepseek-ai/dsh-session';

export const name = 'dsh-retry';
export const inject = ['commands'];

const RETRY_TRIGGER_TEXT =
  '重新回答紧邻此消息之前的用户请求。把先前生成的结果视为不存在；不要提及重试、旧回答或本指令。';

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
  latestAssistantMessageId?: string;
  toolCallCount: number;
}

export type RetryPlanResult = RetryPlan | RetryPlanFailure;

function directUserMessage(event: SessionEvent): UserMessage | undefined {
  const message = deriveEventMessage(event);
  if (message?.role !== 'user' || message.source.kind !== 'user') return undefined;
  return message as UserMessage;
}

/**
 * Select the one current model-surface suffix that represents the latest human
 * request and every attempt made for it. Replacement nodes are intentionally
 * eligible, which makes repeated retries collapse the prior retry too.
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

  let requestIndex = -1;
  let userMessage: UserMessage | undefined;
  for (let index = surfaceNodes.length - 1; index >= 0; index -= 1) {
    const seq = surfaceNodes[index];
    if (seq === undefined) continue;
    const event = events[seq];
    if (event === undefined) continue;
    const message = directUserMessage(event);
    if (message === undefined) continue;
    requestIndex = index;
    userMessage = message;
    break;
  }
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

  const toolCallCount = events.reduce((count, event) => (
    event.seq >= requestSeq
      && event.seq <= lastBoundary.seq
      && event.type === 'tool/call'
      ? count + 1
      : count
  ), 0);

  return {
    ok: true,
    startSeq: requestSeq,
    endSeq,
    sourceEventSeqs: [...sourceEventSeqs],
    userMessage,
    ...(latestAssistantMessageId === undefined ? {} : { latestAssistantMessageId }),
    toolCallCount,
  };
}

/** Commit only the model-surface rewrite; the append-origin transcript stays intact. */
export function commitRetrySurface(session: Session, plan: RetryPlan): number {
  const replacement = createUserMessage({
    content: plan.userMessage.content,
    source: plan.userMessage.source,
  });
  return session.append('user/message', replacement, {
    surfaceOp: {
      op: 'replace',
      start: plan.startSeq,
      end: plan.endSeq,
    },
    sourceEventSeqs: plan.sourceEventSeqs,
  }).seq;
}

export function createRetryTrigger(): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: RETRY_TRIGGER_TEXT }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-retry',
      form: 'notice',
      summary: '重新生成上一轮回答',
    },
  });
}

export interface ParsedRetryInput {
  targetMessageId?: string;
  force: boolean;
}

export function parseRetryInput(rawInput: string): ParsedRetryInput | undefined {
  const parts = rawInput.trim().split(/\s+/u).filter(Boolean);
  let force = false;
  let targetMessageId: string | undefined;
  for (const part of parts) {
    if (part === 'force' || part === '--force') {
      if (force) return undefined;
      force = true;
      continue;
    }
    if (targetMessageId !== undefined) return undefined;
    targetMessageId = part;
  }
  return {
    ...(targetMessageId === undefined ? {} : { targetMessageId }),
    force,
  };
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

async function retryAgent(
  agent: Agent,
  targetMessageId: string | undefined,
  force: boolean,
  requestSignal: AbortSignal,
): Promise<CommandResult> {
  if (agent.status !== 'idle') {
    return { kind: 'error', text: '当前会话仍在运行，暂时不能重试。' };
  }

  try {
    return await agent.runMaintenance(async maintenanceSignal => {
      requestSignal.throwIfAborted();
      maintenanceSignal.throwIfAborted();

      const plan = planRetry(
        agent.session.events,
        agent.session.surface.nodes,
        targetMessageId,
      );
      if (!plan.ok) return planFailure(plan);
      if (plan.toolCallCount > 0 && !force) {
        return {
          kind: 'error',
          text: `上一轮执行过 ${plan.toolCallCount} 次工具调用；外部操作无法撤销。确认后请使用 /retry force。`,
        };
      }

      commitRetrySurface(agent.session, plan);
      agent.followup(createRetryTrigger());
      return {
        kind: 'success',
        text: force && plan.toolCallCount > 0
          ? `已在当前会话中强制重新生成（包含 ${plan.toolCallCount} 次既有工具调用，未创建 fork）。`
          : '已在当前会话中重新生成上一轮回答（未创建 fork）。',
      };
    });
  } catch (error) {
    if (requestSignal.aborted) return { kind: 'error', text: '重试请求已取消。' };
    return {
      kind: 'error',
      text: `无法开始重试：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.commands.register({
    name: 'retry',
    description: '在当前会话中重新生成上一轮回答',
    input: { hint: '[force]' },
    handler: invocation => {
      const parsed = parseRetryInput(invocation.rawInput);
      if (parsed === undefined) {
        return {
          kind: 'error',
          text: '用法：/retry [force]',
        };
      }
      return retryAgent(
        invocation.agent,
        parsed.targetMessageId,
        parsed.force,
        invocation.signal,
      );
    },
  }), 'dsh-retry: command');
}
