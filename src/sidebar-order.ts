export interface SidebarSessionSummary {
  id: string;
  displayTitle: string;
  origin?: 'subagent';
  blank: boolean;
  updatedAt: number;
}

export interface SidebarSessionList {
  ids: readonly string[];
  byId: Readonly<Record<string, SidebarSessionSummary>>;
  current?: string;
}

export interface SidebarWorkspace {
  workspaceId: string;
  sessionIds: readonly string[];
}

export interface SidebarView {
  groupBy?: 'workspace' | 'flat';
  groupExpansion?: Readonly<Record<string, boolean>>;
  sessionOrderByAccount?: Readonly<Record<string, readonly string[]>>;
}

const FLAT_ACCOUNT = '__flat_session_order__';

function reconcile(base: readonly string[], stored?: readonly string[]): string[] {
  if (stored === undefined) return [...base];
  const available = new Set(base);
  const included = new Set<string>();
  const result: string[] = [];
  for (const id of stored) {
    if (!available.has(id) || included.has(id)) continue;
    result.push(id);
    included.add(id);
  }
  for (const id of base) {
    if (!included.has(id)) result.push(id);
  }
  return result;
}

function byRecency(list: SidebarSessionList, a: string, b: string): number {
  const delta = (list.byId[b]?.updatedAt ?? 0) - (list.byId[a]?.updatedAt ?? 0);
  return delta === 0 ? a.localeCompare(b) : delta;
}

/** Reproduce the ordinary sidebar's visible session-row order. */
export function visibleSidebarSessionIds(
  list: SidebarSessionList,
  workspaces: readonly SidebarWorkspace[],
  archivedSessionIds: readonly string[],
  view: SidebarView,
): string[] {
  const archived = new Set(archivedSessionIds);
  const visible = (id: string): boolean => {
    const session = list.byId[id];
    return session !== undefined
      && session.origin !== 'subagent'
      && !archived.has(id)
      && (!session.blank || id === list.current);
  };
  const orders = view.sessionOrderByAccount ?? {};

  if (view.groupBy === 'flat') {
    const base = list.ids.filter(visible).sort((a, b) => byRecency(list, a, b));
    return reconcile(base, orders[FLAT_ACCOUNT]).filter(visible);
  }

  const result: string[] = [];
  const accounted = new Set<string>();
  for (const workspace of workspaces) {
    for (const id of workspace.sessionIds) {
      if (list.byId[id] !== undefined) accounted.add(id);
    }
    if (view.groupExpansion?.[workspace.workspaceId] !== true) continue;
    result.push(...reconcile(workspace.sessionIds, orders[workspace.workspaceId]).filter(visible));
  }

  if (view.groupExpansion?.[''] === true) {
    const stray = list.ids.filter((id) => !accounted.has(id) && visible(id));
    const ordered = orders[''] === undefined
      ? stray.sort((a, b) => byRecency(list, a, b))
      : reconcile(stray, orders['']);
    result.push(...ordered);
  }
  return result;
}
