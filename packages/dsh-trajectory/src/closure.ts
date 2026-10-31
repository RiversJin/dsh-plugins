import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { SOURCE, type Anchor, type TrajectoryState } from './state.js';

export interface ClosureReceipt { anchorIds: string[]; taskId: string; requestedAt: number; }
export interface TrajectoryClosure { request(agent: Agent, reason: string): Promise<ClosureReceipt | undefined>; }
interface ClosureSchedule {
  catalog(): Promise<{ id: string; sessionId: string; title: string; prompt: string; scheduledAt: string }[]>;
  create(sessionId: Agent['session']['id'], request: { title: string; after_seconds: number; prompt: string }): Promise<{ id: string; scheduledAt: string }>;
}

function source(event: SessionEvent | undefined) {
  return event?.type === 'user/message' ? event.data.source : event?.type === 'developer/message' ? event.data.message.source : undefined;
}

export function isAutomaticAnchor(events: readonly SessionEvent[], anchor: Anchor): boolean {
  return events.some((event, index) => {
    const notice = source(event);
    if (notice?.kind !== SOURCE || notice.form !== 'auto-anchor-notice') return false;
    const previous = source(events[index - 1]);
    return notice.anchorId === anchor.id || (previous?.kind === SOURCE && previous.form === 'anchor' && previous.anchor?.id === anchor.id);
  });
}

/** Only completed human conversation rounds count. Any actual tool call resets
 * the consecutive quiet-round count; scheduled messages do not add rounds. */
export function toolFreeTurns(events: readonly SessionEvent[], anchor: Anchor): number {
  let human = false, tools = false, count = 0;
  for (const event of events) {
    if (event.type === 'turn/start') { human = false; tools = false; }
    if (event.type === 'user/message' && event.data.source.kind === 'user') human = true;
    if (event.seq < anchor.startSeq) continue;
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') { tools = true; count = 0; }
    if (event.type === 'turn/end' && human && !tools && event.data.reason.kind === 'completed') count++;
  }
  return count;
}

/** Both automatic-anchor and dream prompts use this one durable request path.
 * One anchor identity receives at most one delivery, including across restarts. */
export function closureService(ctx: Context, stateOf: (agent: Agent) => TrajectoryState): TrajectoryClosure {
  const queues = new WeakMap<Agent, Promise<ClosureReceipt | undefined>>();
  return { request(agent, reason) {
    const prior = queues.get(agent) ?? Promise.resolve(undefined);
    const job = prior.catch(() => undefined).then(async () => {
      const state = stateOf(agent), anchors = [state.anchor, state.suspendedWorkAnchor].filter((a): a is Anchor => a !== null);
      if (!anchors.length) return undefined;
      const anchorIds = anchors.map(a => a.id).sort();
      const observation = await ctx.sessionQuery.observeSession(agent.session.id, { signal: new AbortController().signal, projectionMode: 'none' });
      let known: ClosureReceipt | undefined;
      try {
        for (const event of observation.events) {
          const row = source(event);
          if (row?.kind === SOURCE && row.form === 'closure-request' && row.anchorIds.some(id => anchorIds.includes(id)))
            known = { anchorIds: row.anchorIds, taskId: row.taskId, requestedAt: row.requestedAt };
        }
      } finally { observation[Symbol.dispose](); }
      if (known && anchorIds.every(id => known!.anchorIds.includes(id))) return known;
      const schedule = ctx.get('schedule') as ClosureSchedule | undefined;
      if (!known && !schedule) throw new Error('Trajectory closure reminders require the schedule service');
      if (!known) {
        // Also adopt requests written by the previous dream-handoff release.
        const existing = (await schedule!.catalog()).find(row => row.sessionId === agent.id
          && /^(锚点收束|梦前收束) /u.test(row.title) && anchorIds.some(id => row.prompt.includes(id)));
        const task = existing ?? await schedule!.create(agent.session.id, {
          title: `锚点收束 ${anchorIds.join(' ')}`.slice(0, 120), after_seconds: 1,
          prompt: `[主会话锚点收束请求]\n${reason}\n当前锚点：${JSON.stringify(anchors)}。\n请由你本人实际调用 trajectory 工具完成收束：可先 trajectory_read 核对状态；若有查阅层，先总结或释放查阅，再收束底层工作锚点。用真实 anchor_id 调用 trajectory_compact，亲自保存这一段的经历、重要内容和未完事项。收到工具成功结果、确认锚点清空后结束这轮，不要只口头说已收束，也不要新开锚点。若有待进行的夜间整理，系统会接着执行，无需另行启动或修改配置。这组锚点只投递这一次请求，不会重复催促。`,
        });
        const queuedAt = Date.parse(task.scheduledAt) - 1000;
        known = { anchorIds, taskId: task.id, requestedAt: Number.isFinite(queuedAt) ? queuedAt : Date.now() };
      }
      const receipt = { ...known, anchorIds: [...new Set([...known.anchorIds, ...anchorIds])].sort() };
      await agent.runMaintenance(async signal => {
        signal.throwIfAborted();
        agent.session.append('user/message', createUserMessage({ content: [], source: { kind: SOURCE, form: 'closure-request', ...receipt } }), { surfaceOp: 'append' });
        if (!await ctx.sessions.flush(agent.session)) throw new Error('Anchor closure receipt was not durably flushed');
      });
      return receipt;
    });
    queues.set(agent, job);
    void job.finally(() => { if (queues.get(agent) === job) queues.delete(agent); }).catch(() => undefined);
    return job;
  } };
}
