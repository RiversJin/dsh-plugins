import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import { SidebarSessionIds } from './SidebarSessionIds.js';

export const inject = ['slots'];

const STYLE_ID = 'dsh-session-id-style';

function installStyle(): () => void {
  document.getElementById(STYLE_ID)?.remove();
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .dsh-session-id__sidebar-suffix {
      display: inline;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--dsw-alias-label-caption);
      font: inherit;
      font-family: var(--ds-font-family-code, ui-monospace, monospace);
      font-variant-numeric: tabular-nums;
      cursor: pointer;
      transition: color .12s;
    }
    .dsh-session-id__sidebar-suffix:hover {
      color: var(--dsw-alias-state-business-primary);
    }
    .dsh-session-id__sidebar-suffix:focus-visible {
      outline: 1.5px solid var(--dsw-alias-state-business-primary);
      outline-offset: 1px;
      border-radius: 3px;
    }
  `;
  document.head.appendChild(style);
  return () => style.remove();
}

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyle, 'dsh-session-id: style');
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'session-id-decorator',
    order: 100,
  }, SidebarSessionIds));
}
