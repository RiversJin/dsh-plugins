import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { SOURCE } from './state.js';

const management = new Set(['trajectory_anchor', 'trajectory_read', 'trajectory_compact', 'trajectory_release']);
export interface AutoAnchorCandidate { assistantSeq: number; count: number; firstTool: string; }

/** Count completed native calls in visible, whole groups. PTC containers are
 * replaced by their leaf dispatches, so a wrapper never counts twice.
 * A completed human conversation round without any tool work separates two
 * tool stretches: the count restarts at the next tool group, so hours of chat
 * between two incidental calls never fall inside one retrospective anchor. */
export function automaticAnchorCandidate(events: readonly SessionEvent[], nodes: readonly number[], enabledAt: number): AutoAnchorCandidate | null {
  let boundary = enabledAt;
  for (const event of events) {
    if (event.seq <= boundary) continue;
    if (event.type === 'developer/message' && event.data.message.source.kind === SOURCE
      && event.data.message.source.form === 'anchor') boundary = event.seq;
    if (event.type === 'user/message' && event.data.source.kind === SOURCE
      && event.data.source.form === 'summary') boundary = event.seq;
  }
  const visible = new Set(nodes);
  const executed = new Set<string>();
  const results = new Map<string, number>();
  const nested = new Map<string, { id: string; parent: string; name: string }[]>();
  for (const event of events) {
    if (event.seq <= boundary) continue;
    if (event.type === 'tool/call') executed.add(event.data.callId);
    if (event.type === 'tool/result' && visible.has(event.seq)) results.set(event.data.message.toolCallId, event.seq);
    if (event.type === 'tool/ptc-dispatch') {
      const rows = nested.get(event.data.rootCallId) ?? [];
      rows.push({ id: event.data.subCallId, parent: event.data.parentCallId, name: event.data.name });
      nested.set(event.data.rootCallId, rows);
    }
  }
  let candidate: AutoAnchorCandidate | null = null;
  let human = false, tools = false;
  for (const event of events) {
    if (event.seq <= boundary) continue;
    if (event.type === 'turn/start') { human = false; tools = false; continue; }
    if (event.type === 'user/message' && event.data.source.kind === 'user') human = true;
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') tools = true;
    if (event.type === 'turn/end') {
      if (human && !tools && event.data.reason.kind === 'completed') candidate = null;
      continue;
    }
    if (!visible.has(event.seq)) continue;
    // Never propose a range crossing a system prompt or an unfinished group.
    if (event.type === 'system/message') { candidate = null; continue; }
    if (event.type !== 'assistant/message') continue;
    const calls = event.data.message.content.filter(block => block.type === 'tool-call');
    if (!calls.length) continue;
    if (calls.some(call => !executed.has(call.id) || (results.get(call.id) ?? -1) <= event.seq)) { candidate = null; continue; }
    const names = calls.flatMap(call => {
      const rows = nested.get(call.id);
      if (!rows?.length) return management.has(call.name) ? [] : [call.name];
      const parents = new Set(rows.map(row => row.parent));
      return rows.filter(row => !parents.has(row.id) && !management.has(row.name)).map(row => row.name);
    });
    if (!names.length) continue;
    candidate ??= { assistantSeq: event.seq, count: 0, firstTool: names[0]! };
    candidate.count += names.length;
  }
  return candidate;
}

export interface AnchorSpan { messages: number; userMessages: number; firstTime: number; lastTime: number; }

/** Describe what a retrospective anchor would cover: the visible messages from
 * its start through the end of the log, and the human messages among them. */
export function anchorSpan(events: readonly SessionEvent[], nodes: readonly number[], startSeq: number): AnchorSpan {
  const start = nodes.indexOf(startSeq);
  const covered = start < 0 ? [] : nodes.slice(start);
  const last = events.at(-1);
  let userMessages = 0;
  for (const seq of covered) {
    const event = events[seq];
    if (event?.type === 'user/message' && event.data.source.kind === 'user') userMessages++;
  }
  return { messages: covered.length, userMessages,
    firstTime: events[startSeq]?.time ?? last?.time ?? Date.now(), lastTime: last?.time ?? Date.now() };
}

function clock(time: number): string {
  return new Date(time).toLocaleString('sv-SE', { timeZoneName: 'short' });
}

export function describeSpan(span: AnchorSpan): string {
  const minutes = Math.max(0, Math.round((span.lastTime - span.firstTime) / 60_000));
  const duration = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  return `It covers ${span.messages} context messages from ${clock(span.firstTime)} to ${clock(span.lastTime)} (${duration}), including ${span.userMessages} user messages. A trajectory_compact summary replaces everything in this range, so carry forward the conversation inside it, not only the tool work.`;
}
