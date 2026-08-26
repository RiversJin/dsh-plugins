import { useEffect } from 'react';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {
  SessionListState,
  WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client';
import { shortSessionId } from '../session-id.js';
import {
  visibleSidebarSessionIds,
  type SidebarView,
} from '../sidebar-order.js';
import { copyText } from './session-id.js';

export type SidebarSessionIdsProps = PropsRuntime<'sidebar.footer.action'>;

const VIEW_STORAGE_KEY = 'dsh.workspace.view.v5';
const SUFFIX_ATTR = 'data-dsh-session-id-suffix';

function readView(): SidebarView {
  try {
    return JSON.parse(localStorage.getItem(VIEW_STORAGE_KEY) ?? '{}') as SidebarView;
  } catch {
    return {};
  }
}

function removeSuffixes(root: ParentNode = document): void {
  root.querySelectorAll(`[${SUFFIX_ATTR}]`).forEach((node) => node.remove());
}

function titleElement(row: Element, title: string): HTMLSpanElement | undefined {
  const spans = Array.from(row.children).filter(
    (node): node is HTMLSpanElement => node instanceof HTMLSpanElement,
  );
  return spans.find((span) => span.textContent === title)
    ?? spans.find((span) => getComputedStyle(span).flexGrow === '1');
}

function appendSuffix(row: Element, sessionId: string, title: string): void {
  if (row.querySelector(`[${SUFFIX_ATTR}]`) !== null) return;
  const titleNode = titleElement(row, title);
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
  titleNode.append(' ', suffix);
}

function decorateRows(list: SessionListState, workspaces: WorkspaceListState): void {
  const tree = document.querySelector('[role="tree"]');
  if (tree === null) return;
  const rows = Array.from(tree.querySelectorAll('[role="treeitem"][aria-selected]'));
  const ids = visibleSidebarSessionIds(
    list,
    workspaces.items,
    workspaces.archivedSessionIds,
    readView(),
  );

  // A search result, a transition, or a future sidebar layout can change the
  // row set. Fail closed instead of ever putting the wrong ID beside a title.
  if (rows.length !== ids.length) return;
  rows.forEach((row, index) => {
    const id = ids[index];
    const session = id === undefined
      ? undefined
      : list.byId[id as keyof typeof list.byId];
    if (id !== undefined && session !== undefined && !session.blank) {
      appendSuffix(row, id, session.displayTitle);
    }
  });
}

export function SidebarSessionIds({ useSessions, useWorkspaces, wide }: SidebarSessionIdsProps): null {
  const list = useSessions((state) => state);
  const workspaces = useWorkspaces((state) => state);

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
        decorateRows(list, workspaces);
      });
    };
    decorate();

    const observer = new MutationObserver(decorate);
    const tree = document.querySelector('[role="tree"]');
    if (tree !== null) observer.observe(tree, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      removeSuffixes(tree ?? document);
    };
  }, [list, wide, workspaces]);

  return null;
}
