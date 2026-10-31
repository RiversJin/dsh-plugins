import type { Agent } from '@deepseek-ai/dsh-agent';
import { deriveEventMessage, type SessionEvent } from '@deepseek-ai/dsh-session';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { Anchor } from './state.js';

export interface Position { turn: number; step: number; assistantSeq: number; }
/** Nested PTC calls use their root assistant message, keeping the whole call group intact. */
export function executionPosition(events: readonly SessionEvent[], exec: ToolRunContext): Position {
  const call = events.findLast(event => event.type === 'tool/call' && event.data.callId === exec.rootCallId);
  if (call?.type !== 'tool/call') throw new Error('Trajectory tools require an active agent tool call.');
  const assistant = events.findLast(event => event.type === 'assistant/message'
    && event.data.turn === call.data.turn && event.data.step === call.data.step
    && event.data.message.content.some(block => block.type === 'tool-call' && block.id === exec.rootCallId));
  if (!assistant) throw new Error('Could not locate the enclosing assistant tool-call message.');
  return { turn: call.data.turn, step: call.data.step, assistantSeq: assistant.seq };
}

export interface CompactionPlan { surfaceSeqs: number[]; events: readonly SessionEvent[]; }
/** Select only a contiguous, completed call range; the current call stays outside. */
export function planCompaction(agent: Agent, anchor: Anchor, position: Position, events: readonly SessionEvent[]): CompactionPlan {
  const nodes: readonly number[] = agent.session.surface.nodes;
  const start = nodes.indexOf(anchor.startSeq), end = nodes.indexOf(position.assistantSeq);
  if (start < 0) throw new Error('This anchor was removed by another context rewrite. Create a new anchor.');
  if (end <= start) throw new Error('There is no completed trajectory after this anchor yet. Receive the tool results in another model request before compacting.');
  const surfaceSeqs = nodes.slice(start, end);
  const calls = new Set<string>(), results = new Set<string>();
  for (const seq of surfaceSeqs) {
    const event = events[seq];
    if (!event) throw new Error('Session history changed while selecting the trajectory.');
    if (event.type === 'system/message') throw new Error('The trajectory cannot replace a system prompt.');
    const message = deriveEventMessage(event);
    if (message?.role === 'assistant') for (const block of message.content) {
      if (block.type === 'tool-call') calls.add(block.id);
    }
    if (message?.role === 'tool') results.add(message.toolCallId);
  }
  if ([...calls].some(id => !results.has(id)) || [...results].some(id => !calls.has(id))) {
    throw new Error('This range would split a tool call from its result. Keep the anchor and retry after the call group completes.');
  }
  return { surfaceSeqs: [...surfaceSeqs], events: events.slice(anchor.startSeq, position.assistantSeq) };
}
