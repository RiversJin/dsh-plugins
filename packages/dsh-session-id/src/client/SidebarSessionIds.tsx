import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import { useEffect } from 'react';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { shortSessionId } from '../session-id.js';
import { copyText } from './session-id.js';

export type SidebarSessionIdsProps = PropsRuntime<'sidebar.footer.action'>;

const SUFFIX_ATTR = 'data-dsh-session-id-suffix';

function removeSuffixes(root: ParentNode = document): void {
  root.querySelectorAll(`[${SUFFIX_ATTR}]`).forEach((node) => node.remove());
}

function titleElement(row: Element): HTMLSpanElement | undefined {
  const spans = Array.from(row.children).filter(
    (node): node is HTMLSpanElement => node instanceof HTMLSpanElement,
  );
  return spans.find((span) => getComputedStyle(span).flexGrow === '1');
}

function appendSuffix(row: Element, sessionId: string): void {
  const existing = row.querySelector(`[${SUFFIX_ATTR}]`);
  if (existing?.getAttribute(SUFFIX_ATTR) === sessionId) return;
  existing?.remove();
  const titleNode = titleElement(row);
  if (titleNode === undefined) return;

  const suffix = document.createElement('button');
  suffix.type = 'button';
  suffix.className = 'dsh-session-id__sidebar-suffix';
  suffix.setAttribute(SUFFIX_ATTR, sessionId);
  suffix.textContent = `(${shortSessionId(sessionId)})`;
  suffix.title = `复制完整会话 ID：${sessionId}`;
  suffix.setAttribute('aria-label', suffix.title);
  suffix.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const original = suffix.textContent;
    void copyText(sessionId).then(() => {
      suffix.textContent = '(已复制)';
    }, () => {
      suffix.textContent = '(复制失败)';
    }).finally(() => {
      window.setTimeout(() => {
        if (suffix.isConnected) suffix.textContent = original;
      }, 1400);
    });
  });
  // The native title clips overflowing content and scrolls on hover. Keep the
  // copy button in its own flex cell so long titles cannot hide its hit target.
  titleNode.after(suffix);
}

function decorateRows(list: SessionListState): void {
  const tree = document.querySelector('[role="tree"]');
  if (tree === null) return;
  // New host rows expose their identity directly, including search and reordered rows.
  for (const row of tree.querySelectorAll<HTMLElement>('[role="treeitem"][data-row-key^="session:"]')) {
    const id = row.dataset.rowKey?.slice('session:'.length);
    const session = id === undefined ? undefined : list.byId[id as keyof typeof list.byId];
    if (id && session !== undefined && !session.blank) appendSuffix(row, id);
    else removeSuffixes(row);
  }
}

export function SidebarSessionIds({ wide, useSessions }: SidebarSessionIdsProps): null {
  const list = useSessions((state: SessionListState) => state);
  useEffect(() => {
    if (!wide) {
      removeSuffixes();
      return;
    }

    let frame: number | undefined;
    const decorate = (): void => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        decorateRows(list);
      });
    };
    decorate();

    const observer = new MutationObserver(records => {
      if (records.some(record => record.target instanceof Element && record.target.closest('[role="tree"]') !== null
        || [...record.addedNodes].some(node => node instanceof Element && (node.matches('[role="tree"]') || node.querySelector('[role="tree"]') !== null)))) decorate();
    });
    const tree = document.querySelector('[role="tree"]');
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-row-key'] });
    return () => {
      observer.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      removeSuffixes(tree ?? document);
    };
  }, [list, wide]);

  return null;
}
