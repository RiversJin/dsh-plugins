import { deriveEventMessage, type SessionEvent } from '@deepseek-ai/dsh-session';
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm';
import type { ArchiveDocument } from './archive.js';
import { SOURCE } from './state.js';

function clock(time: number): string {
  return new Date(time).toLocaleString('sv-SE', { timeZoneName: 'short' });
}

function renderBlock(block: ContentBlock, names: Map<string, string>): string {
  switch (block.type) {
    case 'text': return block.text;
    case 'reasoning': return `[thinking]\n${block.text}`;
    case 'tool-call': names.set(block.id, block.name); return `[tool call ${block.name} ${block.id}]\n${block.arguments}`;
    case 'image': return '[image]';
    case 'file': return '[file attachment]';
    case 'tool-addition': return `[tool added: ${block.toolName}]`;
    case 'tool-removal': return `[tool removed: ${block.toolName}]`;
    default: return `[${(block as { type: string }).type}]`;
  }
}

function describeSpeaker(message: Message, names: Map<string, string>): string {
  const source = message.source as { kind: string; form?: string };
  const origin = source.form ? `${source.kind}/${source.form}` : source.kind;
  switch (message.role) {
    case 'user': return source.kind === 'user' ? 'user' : `user-role message from ${origin}`;
    case 'assistant': return 'assistant';
    case 'tool': return `tool result ${names.get(message.toolCallId) ?? ''} ${message.toolCallId}${message.isError ? ' · ERROR' : ''}`.replace(/\s+/g, ' ');
    case 'developer': return `developer message from ${origin}`;
    case 'system': return 'system';
    default: return (message as { role: string }).role;
  }
}

/** Render an archive as a readable transcript of the messages that were in
 * context when it was compacted: visible text, reasoning, tool calls with
 * arguments, tool results with explicit error marks, and trajectory anchor
 * records. Provider replay metadata, reasoning signatures, request headers and
 * step boundaries are omitted; the archive file keeps every original event. */
export function renderTranscript(document: ArchiveDocument): string {
  const events = new Map<number, SessionEvent>(document.events.map(event => [event.seq, event]));
  const first = document.events[0], last = document.events.at(-1);
  const names = new Map<string, string>();
  const lines: string[] = [
    `Trajectory archive ${document.id} · anchor ${JSON.stringify(document.anchor.label)} (${document.anchor.kind}, ${document.anchor.id})`,
    `${document.surfaceSeqs.length} context messages from ${document.events.length} events, seq ${first?.seq ?? '?'}–${last?.seq ?? '?'}, ${first ? clock(first.time) : '?'} – ${last ? clock(last.time) : '?'}.`,
    'Each entry is "## <seq> · <time> · <speaker>" followed by its content. Failed tool results are marked ERROR. Provider replay metadata, reasoning signatures, request headers and step boundaries are omitted here; the archive file keeps every original event.',
  ];
  for (const seq of document.surfaceSeqs) {
    const event = events.get(seq);
    if (!event) { lines.push('', `## ${seq} · (message rewritten after this range; its event is not in this archive)`); continue; }
    const message = deriveEventMessage(event);
    if (!message) {
      if (event.type === 'developer/message' && event.data.message.source.kind === SOURCE && event.data.message.source.form === 'anchor') {
        const source = event.data.message.source;
        const anchor = source.anchor ? `${source.anchor.kind} anchor ${JSON.stringify(source.anchor.label)} ${source.anchor.id} from seq ${source.anchor.startSeq}` : 'anchor cleared';
        const suspended = source.suspendedWorkAnchor ? `; work ${JSON.stringify(source.suspendedWorkAnchor.label)} ${source.suspendedWorkAnchor.id} kept underneath` : '';
        lines.push('', `## ${seq} · ${clock(event.time)} · trajectory`, `[${anchor}${suspended}]`);
      }
      continue;
    }
    const speaker = describeSpeaker(message, names);
    const body = message.content.map(block => renderBlock(block, names)).filter(text => text.length).join('\n');
    lines.push('', `## ${seq} · ${clock(event.time)} · ${speaker}`, body.length ? body : '[empty]');
  }
  return lines.join('\n');
}
