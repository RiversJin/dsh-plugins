import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FunctionDef } from './sandbox.js';

export interface State {
  version: 1;
  sessionId: string;
  revision: number;
  /** Null until the author sets one; nothing is rendered meanwhile. */
  template: string | null;
  functions: Record<string, FunctionDef>;
  updatedAt: number;
  lastRender?: { at: number; text?: string; error?: string };
}

export const emptyState = (sessionId: string): State => ({ version: 1, sessionId, revision: 0, template: null, functions: {}, updatedAt: 0 });

/** One JSON file per session, replaced atomically. */
export class StateStore {
  constructor(readonly dir: string) {}

  private path(sessionId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) throw new Error(`unsafe session id ${JSON.stringify(sessionId)}`);
    return join(this.dir, `${sessionId}.json`);
  }

  async load(sessionId: string): Promise<State> {
    let raw: string;
    try { raw = await readFile(this.path(sessionId), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(sessionId); throw error; }
    const parsed = JSON.parse(raw) as State;
    if (parsed.version !== 1 || parsed.sessionId !== sessionId) throw new Error(`tick-template state for ${sessionId} is not readable`);
    return { ...emptyState(sessionId), ...parsed, functions: { ...parsed.functions } };
  }

  async save(state: State): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.path(state.sessionId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
    await rename(temporary, target);
  }
}
