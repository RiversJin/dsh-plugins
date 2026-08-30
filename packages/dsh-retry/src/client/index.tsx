import type {
  ClientContext,
  ConversationNode,
  ConversationSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export const inject = ['slots', 'sessions'];

const STYLE_ID = 'dsh-retry-style';

type RetryActionProps = PropsRuntime<'conversation.chat.assistant-actions'>;

function installStyle(): () => void {
  document.getElementById(STYLE_ID)?.remove();
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .dsh-retry__action {
      width: 24px;
      height: 24px;
      display: inline-grid;
      place-items: center;
      padding: 0;
      border: 0;
      border-radius: 5px;
      background: transparent;
      color: var(--dsw-alias-label-secondary);
      font: inherit;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      transition: color .12s, background-color .12s;
    }
    .dsh-retry__action:hover:not(:disabled) {
      color: var(--dsw-alias-label-primary);
      background: var(--dsw-alias-interactive-bg-hover);
    }
    .dsh-retry__action:focus-visible {
      outline: 1.5px solid var(--dsw-alias-state-business-primary);
      outline-offset: 1px;
    }
    .dsh-retry__action:disabled {
      opacity: .45;
      cursor: default;
    }
    .dsh-retry__removed-marker {
      display: none;
    }
    [data-chat-flow-kind="assistant-step"][data-dsh-retry-removed="true"],
    [data-chat-flow-kind="turn-tail"][data-dsh-retry-removed="true"] {
      display: none;
    }
  `;
  document.head.appendChild(style);
  return () => style.remove();
}

function latestAssistantId(snapshot: ConversationSnapshot): string | undefined {
  for (let index = snapshot.nodes.length - 1; index >= 0; index -= 1) {
    const node = snapshot.nodes[index];
    if (node?.kind === 'assistant' && node.messageId !== undefined) {
      return node.messageId;
    }
  }
  return undefined;
}

function isSuperseded(nodes: readonly ConversationNode[], messageId: string): boolean {
  let latestAssistant: string | undefined;
  for (const node of nodes) {
    if (node.kind === 'assistant' && node.messageId !== undefined) {
      latestAssistant = node.messageId;
      continue;
    }
    if (
      node.kind === 'command'
      && node.name === 'retry'
      && node.outcome?.kind === 'success'
      && latestAssistant === messageId
    ) return true;
  }
  return false;
}

function priorAssistantRow(marker: HTMLElement): HTMLElement | undefined {
  const tail = marker.closest<HTMLElement>('[data-chat-flow-kind="turn-tail"]');
  let row = tail?.previousElementSibling;
  while (row instanceof HTMLElement) {
    if (row.dataset.chatFlowKind === 'assistant-step') return row;
    if (row.dataset.chatFlowKind === 'turn-tail') return undefined;
    row = row.previousElementSibling;
  }
  return undefined;
}

function retryAction(ctx: ClientContext) {
  return function RetryAction({ messageId, sessionId, useSession }: RetryActionProps) {
    const latest = useSession(snapshot => latestAssistantId(snapshot));
    const superseded = useSession(snapshot => isSuperseded(snapshot.nodes, messageId));
    const running = useSession(snapshot => snapshot.running);
    const removed = useSession(snapshot => snapshot.removed);
    const [pending, setPending] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const markerRef = useRef<HTMLSpanElement>(null);

    useLayoutEffect(() => {
      const marker = markerRef.current;
      if (!superseded || marker === null) return undefined;
      const tail = marker.closest<HTMLElement>('[data-chat-flow-kind="turn-tail"]');
      const row = priorAssistantRow(marker);
      if (tail === null || row === undefined) return undefined;
      tail.dataset.dshRetryRemoved = 'true';
      row.dataset.dshRetryRemoved = 'true';
      return () => {
        delete tail.dataset.dshRetryRemoved;
        delete row.dataset.dshRetryRemoved;
      };
    }, [superseded]);

    const run = useCallback(async () => {
      const session = ctx.sessions.binding(sessionId)?.session;
      if (session === undefined) {
        setFailure('会话当前不可用');
        return;
      }
      setPending(true);
      setFailure(null);
      try {
        const result = await session.command(`/retry ${messageId}`);
        if (!result.ok) setFailure(result.error.message);
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        setPending(false);
      }
    }, [ctx, messageId, sessionId]);

    if (superseded) {
      return (
        <span
          ref={markerRef}
          className="dsh-retry__removed-marker"
          aria-hidden="true"
        />
      );
    }
    if (latest !== messageId) return null;
    const label = failure ?? '重新生成上一轮回答';
    return (
      <button
        type="button"
        className="dsh-retry__action"
        aria-label={label}
        title={label}
        disabled={running || removed || pending}
        onClick={() => { void run(); }}
      >
        ↻
      </button>
    );
  };
}

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyle, 'dsh-retry: style');
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'retry',
    order: 20,
  }, retryAction(ctx)));
}
