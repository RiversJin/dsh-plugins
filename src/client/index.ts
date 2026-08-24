import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import { SessionIdBadge } from './SessionIdBadge.js';

export const inject = ['slots'];

const STYLE_ID = 'dsh-session-id-style';

function installStyle(): () => void {
  document.getElementById(STYLE_ID)?.remove();
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .dsh-session-id {
      box-sizing: border-box;
      height: 26px;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 0 8px;
      border: 1px solid var(--dsw-alias-border-l2);
      border-radius: 999px;
      background: transparent;
      color: var(--dsw-alias-label-tertiary);
      font: var(--dsw-font-xxs-12);
      font-variant-numeric: tabular-nums;
      cursor: pointer;
      transition: color .12s, background-color .12s, border-color .12s;
    }
    .dsh-session-id:hover {
      color: var(--dsw-alias-label-secondary);
      background: var(--dsw-alias-interactive-bg-hover);
      border-color: var(--dsw-alias-border-l3);
    }
    .dsh-session-id:focus-visible {
      outline: 2px solid var(--dsw-alias-state-business-primary);
      outline-offset: 2px;
    }
    .dsh-session-id[data-copy-state="copied"] {
      color: var(--dsw-alias-state-success-primary);
    }
    .dsh-session-id[data-copy-state="failed"] {
      color: var(--dsw-alias-state-error-primary);
    }
    .dsh-session-id__mark {
      color: var(--dsw-alias-label-caption);
    }
    .dsh-session-id__value {
      font-family: var(--ds-font-family-code, ui-monospace, monospace);
      white-space: nowrap;
    }
  `;
  document.head.appendChild(style);
  return () => style.remove();
}

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyle, 'dsh-session-id: style');
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'session-id',
    order: 10,
  }, SessionIdBadge));
}
