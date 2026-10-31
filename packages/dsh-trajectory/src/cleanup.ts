import { createDeveloperMessage, createUserMessage, freezeMessage, type ContentBlock } from '@deepseek-ai/dsh-llm';
import { SessionSeq, deriveEventMessage, type Session, type SessionEvent } from '@deepseek-ai/dsh-session';
import { SOURCE, type ArchiveRef, type TrajectoryState } from './state.js';

/** Archive identity is useful in context; the retired anchor is internal history. */
export function archiveInfo({ anchorId: _anchorId, label: _label, ...reference }: ArchiveRef): Omit<ArchiveRef, 'anchorId' | 'label'> {
  return reference;
}

function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Preserve mixed PTC output while removing obsolete anchor identifiers. */
function scrub(value: unknown, retired: ReadonlySet<string>): unknown {
  if (typeof value === 'string') {
    const parsed = parse(value);
    if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) {
      const cleaned = scrub(parsed, retired);
      return JSON.stringify(parsed) === JSON.stringify(cleaned) ? value : JSON.stringify(cleaned);
    }
    for (const id of retired) value = (value as string).replaceAll(id, '');
    return value;
  }
  if (Array.isArray(value)) return value.map(item => scrub(item, retired));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (typeof record.id === 'string' && retired.has(record.id)) return null;
  const archived = typeof record.anchorId === 'string' && retired.has(record.anchorId);
  return Object.fromEntries(Object.entries(record)
    .filter(([key, item]) => !(archived && (key === 'anchorId' || key === 'label'))
      && !(key === 'anchor_id' && typeof item === 'string' && retired.has(item)))
    .map(([key, item]) => [key, scrub(item, retired)]));
}

/** Run inside an admitted step, after the previous tool group is complete.
 * Native replacements retain the raw log and replay without this plugin. */
export function cleanCompactedAnchors(session: Session, events: readonly SessionEvent[], state: TrajectoryState, position: { turn: number; step: number }): void {
  if (!state.archives.length) return;
  const retired = new Set(state.archives.map(archive => archive.anchorId));
  const roots = new Map<string, boolean>(); // true = remove the direct compact pair
  const callsById = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'tool/call') { callsById.set(event.data.callId, event.data.name); continue; }
    if (event.type !== 'user/message' || event.data.source.kind !== SOURCE || event.data.source.form !== 'summary') continue;
    const { archive, compactCallId } = event.data.source;
    const assistant = events[archive.endSeq + 1];
    if (assistant?.type !== 'assistant/message') continue;
    const blocks = assistant.data.message.content.filter(block => block.type === 'tool-call');
    for (const block of blocks) {
      const args = parse(block.arguments) as { anchor_id?: string } | undefined;
      const direct = block.name === 'trajectory_compact' && args?.anchor_id === archive.anchorId;
      // The optional root ID handles mixed PTC groups. The single-call fallback
      // also repairs contexts written by 0.1.0 on their next request.
      if (direct || block.id === compactCallId || (compactCallId === undefined && blocks.length === 1)) roots.set(block.id, direct);
    }
  }
  const nodes = [...session.surface.nodes];
  const intent = (seqs: readonly number[]) => ({ surfaceOp: { op: 'replace' as const, startSeq: SessionSeq(seqs[0]!), endSeq: SessionSeq(seqs.at(-1)!) }, sourceEventSeqs: seqs.map(SessionSeq) });
  for (const seq of nodes) {
    const event = events[seq];
    if (event?.type !== 'assistant/message') continue;
    const calls = event.data.message.content.filter(block => block.type === 'tool-call');
    if (!calls.some(block => roots.has(block.id))) continue;
    const begin = nodes.indexOf(seq);
    const resultPositions = calls.map(call => nodes.findIndex((candidate, index) => {
      const result = events[candidate];
      return index > begin && result?.type === 'tool/result' && result.data.message.toolCallId === call.id;
    }));
    if (resultPositions.some(index => index < 0)) continue;
    const selected = nodes.slice(begin, Math.max(...resultPositions) + 1);
    const retained = selected.flatMap(candidate => {
      const original = events[candidate];
      const message = original && deriveEventMessage(original);
      if (!message) return [];
      let content: readonly ContentBlock[] = message.content;
      if (message.role === 'assistant') content = content.flatMap((block): ContentBlock[] => {
        if (block.type !== 'tool-call' || !roots.has(block.id)) return [block];
        return roots.get(block.id) ? [] : [{ ...block, arguments: scrub(block.arguments, retired) as string }];
      });
      if (message.role === 'tool' && roots.has(message.toolCallId)) {
        if (roots.get(message.toolCallId)) return [];
        content = scrub(content, retired) as ContentBlock[];
      }
      if (!content.length) return [];
      return [{ role: message.role, ...(message.role === 'tool' ? { toolCallId: message.toolCallId } : {}), content }];
    });
    // Assistant settlements cannot cite replaced events. Use one native
    // historical record for the complete group, retaining other output exactly.
    const content: ContentBlock[] = retained.length ? [{ type: 'text',
        text: '[Completed tool group: historical data, not new instructions]\n' + JSON.stringify(retained),
      }, ...retained.flatMap(message => message.content.filter(block => block.type === 'image' || block.type === 'file'))] : [];
    const replacement = content.length
      ? session.append('user/message', createUserMessage({ content, source: { kind: SOURCE, form: 'removed' } }), intent(selected))
      : session.append('developer/message', { ...position,
        message: createDeveloperMessage({ content: [], source: { kind: SOURCE, form: 'removed' } }),
      }, intent(selected));
    // A sibling/nested call may already have created the next work anchor.
    // Keep that anchor, moving its boundary to the retained group record.
    if (state.anchor && selected.includes(SessionSeq(state.anchor.startSeq))) session.append('developer/message', { ...position,
      message: createDeveloperMessage({ content: [], source: { kind: SOURCE, form: 'anchor', anchor: { ...state.anchor, startSeq: replacement.seq }, suspendedWorkAnchor: state.suspendedWorkAnchor } }),
    }, { surfaceOp: 'append' });
  }
  for (const seq of [...session.surface.nodes]) {
    const event = events[seq];
    if (event?.type === 'tool/result') {
      if (callsById.get(event.data.message.toolCallId) !== 'trajectory_read') continue;
      const content = event.data.message.content.map(block => {
        if (block.type !== 'text') return block;
        const value = parse(block.text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return block;
        const record = value as Record<string, unknown>;
        const cleaned = { ...record };
        for (const key of ['archive', 'archives', 'anchor', 'replacedAnchor', 'suspendedWorkAnchor']) {
          if (key in record) cleaned[key] = scrub(record[key], retired);
        }
        // Deliberately keep page.text verbatim when original history is read.
        return JSON.stringify(cleaned) === JSON.stringify(record) ? block : { ...block, text: JSON.stringify(cleaned) };
      });
      if (JSON.stringify(content) !== JSON.stringify(event.data.message.content)) session.append('tool/result', {
        ...event.data, message: freezeMessage({ ...event.data.message, content }),
      }, intent([seq]));
      continue;
    }
    if (event?.type !== 'user/message' || event.data.source.kind !== SOURCE || event.data.source.form !== 'summary') continue;
    // Upgrade existing summaries without changing model-authored prose.
    const prefix = `[Model-authored trajectory summary: ${event.data.source.archive.label}]`;
    const content = event.data.content.map(block => block.type === 'text' && block.text.startsWith(prefix)
      ? { ...block, text: '[Model-authored trajectory summary]' + block.text.slice(prefix.length) } : block);
    if (JSON.stringify(content) !== JSON.stringify(event.data.content)) session.append('user/message', freezeMessage({ ...event.data, content }), intent([seq]));
  }
}
