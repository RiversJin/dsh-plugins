import { z } from 'zod';
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

export const SOURCE = 'plugin:dsh-trajectory' as const;
export const anchorSchema = z.object({
  id: z.string().uuid(), label: z.string(), kind: z.enum(['work', 'review']),
  startSeq: z.number().int().nonnegative(), createdAt: z.number(),
});
export type Anchor = z.infer<typeof anchorSchema>;
export const archiveRefSchema = z.object({
  id: z.string().uuid(), ownerSessionId: z.string(), anchorId: z.string().uuid(), label: z.string(),
  startSeq: z.number().int().nonnegative(), endSeq: z.number().int().nonnegative(),
  createdAt: z.number(), firstEventTime: z.number(), lastEventTime: z.number(),
  eventCount: z.number().int().positive(), messageCount: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u), bytes: z.number().int().positive(),
});
export type ArchiveRef = z.infer<typeof archiveRefSchema>;
export const readRangeSchema = z.object({
  workAnchorId: z.string().uuid(), archiveId: z.string().uuid(), ownerSessionId: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u), start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(), totalChars: z.number().int().nonnegative(),
});
export type ReadRange = z.infer<typeof readRangeSchema>;
const coverageSchema = readRangeSchema.extend({
  backingSeq: z.number().int().nonnegative(), format: z.enum(['raw', 'summary']),
  summaryArchiveId: z.string().uuid().optional(),
});
export type ReadCoverage = z.infer<typeof coverageSchema>;
const pendingReadSchema = z.object({ rootCallId: z.string(), metadataSeq: z.number().int().nonnegative(), ranges: z.array(readRangeSchema) });
export interface TrajectoryState {
  anchor: Anchor | null; suspendedWorkAnchor: Anchor | null; archives: ArchiveRef[];
  readCoverage: ReadCoverage[]; pendingReads: z.infer<typeof pendingReadSchema>[];
}

export function workAnchor(state: TrajectoryState): Anchor | null {
  return state.anchor?.kind === 'work' ? state.anchor : state.suspendedWorkAnchor;
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:dsh-trajectory':
      | { kind: typeof SOURCE; form: 'anchor'; anchor: Anchor | null; suspendedWorkAnchor?: Anchor | null }
      | { kind: typeof SOURCE; form: 'summary'; archive: ArchiveRef; compactCallId?: string; readRanges?: ReadRange[] }
      | { kind: typeof SOURCE; form: 'read'; rootCallId: string; ranges: ReadRange[] }
      | { kind: typeof SOURCE; form: 'removed' }
      | { kind: typeof SOURCE; form: 'auto-anchor-enabled'; fromSeq: number }
      | { kind: typeof SOURCE; form: 'auto-anchor-notice'; anchorId?: string }
      | { kind: typeof SOURCE; form: 'closure-request'; anchorIds: string[]; taskId: string; requestedAt: number };
  }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { trajectory: TrajectoryState; }
}

/** Metadata rides native, replayable messages, so logs remain readable without this plugin. */
export function foldTrajectory(state: TrajectoryState, event: SessionEvent): TrajectoryState {
  let next = state;
  // Coverage is useful only while its raw result or summary remains in context.
  // Retry/replacement removes that evidence; a trajectory summary explicitly
  // carries forward the ranges whose backing messages it replaces.
  if (event.surfaceOp && event.surfaceOp !== 'append') {
    const coveredSeq = (seq: number) => event.sourceEventSeqs?.includes(seq as SessionEvent['seq']);
    const covered = (anchor: Anchor | null) => anchor !== null && coveredSeq(anchor.startSeq);
    const suspended = covered(state.suspendedWorkAnchor) ? null : state.suspendedWorkAnchor;
    next = { ...state,
      anchor: covered(state.anchor) ? suspended : state.anchor,
      suspendedWorkAnchor: covered(state.anchor) ? null : suspended,
      readCoverage: state.readCoverage.filter(row => !coveredSeq(row.backingSeq)),
      pendingReads: state.pendingReads.filter(row => !coveredSeq(row.metadataSeq)),
    };
  }
  if (event.type === 'developer/message' && event.data.message.source.kind === SOURCE) {
    const source = event.data.message.source;
    if (source.form === 'anchor') next = { ...next, anchor: anchorSchema.nullable().parse(source.anchor),
      suspendedWorkAnchor: anchorSchema.nullable().parse(source.suspendedWorkAnchor ?? null) };
    if (source.form === 'read') next = { ...next, pendingReads: [...next.pendingReads,
      { rootCallId: source.rootCallId, metadataSeq: event.seq, ranges: z.array(readRangeSchema).parse(source.ranges) }] };
  }
  if (event.type === 'tool/result') {
    const matching = next.pendingReads.filter(row => row.rootCallId === event.data.message.toolCallId);
    if (matching.length) next = { ...next,
      pendingReads: next.pendingReads.filter(row => row.rootCallId !== event.data.message.toolCallId),
      readCoverage: event.data.message.isError ? next.readCoverage : [...next.readCoverage,
        ...matching.flatMap(group => group.ranges.map(range => ({ ...range, backingSeq: event.seq, format: 'raw' as const })))],
    };
  }
  if (event.type === 'user/message' && event.data.source.kind === SOURCE) {
    const source = event.data.source;
    if (source.form === 'summary') {
      const archive = archiveRefSchema.parse(source.archive);
      const completed = state.anchor?.id === archive.anchorId;
      const anchor = completed ? state.suspendedWorkAnchor : next.anchor;
      const covered = anchor !== null && event.sourceEventSeqs?.some(seq => seq === anchor.startSeq);
      // A work anchor and its first review may begin in the same native tool
      // group. The review summary becomes the start of that continuing work;
      // keep its identity, and keep whole tool calls/results together.
      const sharedStart = completed && state.anchor?.kind === 'review' && anchor?.startSeq === state.anchor.startSeq;
      const resumed = covered ? sharedStart && anchor ? { ...anchor, startSeq: event.seq } : null : anchor;
      next = { ...next, anchor: resumed, suspendedWorkAnchor: completed ? null : next.suspendedWorkAnchor,
        archives: [...next.archives.filter(row => row.id !== archive.id), archive],
        readCoverage: [...next.readCoverage, ...z.array(readRangeSchema).parse(source.readRanges ?? []).map(range => ({
          ...range, backingSeq: event.seq, format: 'summary' as const, summaryArchiveId: archive.id,
        }))],
      };
    }
  }
  if (next === state) return state;
  const work = workAnchor(next);
  return { ...next,
    readCoverage: next.readCoverage.filter(row => row.workAnchorId === work?.id),
    pendingReads: next.pendingReads.map(group => ({ ...group, ranges: group.ranges.filter(row => row.workAnchorId === work?.id) }))
      .filter(group => group.ranges.length),
  };
}

export const trajectoryProjection: ProjectionDefinition<'trajectory'> = {
  key: 'trajectory', stateVersion: 3,
  stateSchema: z.object({ anchor: anchorSchema.nullable(), suspendedWorkAnchor: anchorSchema.nullable().default(null), archives: z.array(archiveRefSchema),
    readCoverage: z.array(coverageSchema).default([]), pendingReads: z.array(pendingReadSchema).default([]) }),
  init: () => ({ anchor: null, suspendedWorkAnchor: null, archives: [], readCoverage: [], pendingReads: [] }), apply: foldTrajectory,
};
