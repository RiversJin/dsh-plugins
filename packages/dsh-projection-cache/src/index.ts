import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import {
  snapshotJsonValue,
  type Session,
  type SessionHeader,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import type {
  ProjectionCheckpoint,
  ProjectionSnapshot,
} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-persistence'
import {
  projectionCacheDomainSpec,
  type CheckpointIdentity,
  type CheckpointRecord,
} from '@deepseek-ai/dsh-session-projection-cache'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'

const DEFAULT_EXCLUDE_KEYS = ['contextHeaders', 'contextTimeline'] as const

export interface Config {
  writeEveryEvents: number
  writeIntervalMs: number
  excludeKeys?: string[]
}

export const Config: z<Config> = z.object({
  writeEveryEvents: z.natural().min(1).required(),
  writeIntervalMs: z.natural().min(1).required(),
  excludeKeys: z.array(z.string()).default([...DEFAULT_EXCLUDE_KEYS]),
})

interface DirtyState {
  pending: number
  timer: ReturnType<typeof setTimeout> | undefined
}

type ProjectionTable = KvTable<SessionId, CheckpointRecord>

/**
 * Return a new checkpoint containing only projections selected for durable
 * caching. Projection state remains owned by the registry and is never
 * mutated here.
 */
export function filterCheckpointRows(
  rows: ProjectionCheckpoint,
  excluded: ReadonlySet<string>,
): ProjectionCheckpoint {
  const filtered: ProjectionCheckpoint = {}
  for (const [key, row] of Object.entries(rows)) {
    if (!excluded.has(key)) filtered[key] = row
  }
  return filtered
}

function identityOf(header: SessionHeader): CheckpointIdentity {
  return {
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
  }
}

function identityMatches(left: CheckpointIdentity, right: CheckpointIdentity): boolean {
  return left.createdAt === right.createdAt && left.cwd === right.cwd
}

/**
 * Drop-in replacement for DSH's projection cache with one extra policy:
 * selected projection keys are omitted from durable checkpoints. Missing
 * rows are part of the upstream restore contract and force a full-log fold
 * when that cold session is opened.
 */
export class FilteredSessionProjectionCache extends Service {
  static inject = [
    'storageDomain',
    'sessionProjections',
    'sessionPersistence',
    'sessions',
  ]

  static Config = Config

  private table: ProjectionTable | undefined
  private readonly dirty = new Map<Session, DirtyState>()
  private readonly excluded: ReadonlySet<string>

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'sessionProjectionCache')
    this.excluded = new Set(config.excludeKeys ?? DEFAULT_EXCLUDE_KEYS)
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(projectionCacheDomainSpec)
    this.ctx.effect(
      () => () => domain.close(),
      'sessionProjectionCache.domainClose',
    )
    this.table = domain.table('sessions')
    this.installWritePath()
    this.ctx.logger.info(
      `projection cache persistence excludes: ${[...this.excluded].join(', ') || '(none)'}`,
    )
  }

  private recordFor(id: SessionId, expected: CheckpointIdentity): CheckpointRecord | undefined {
    const record = this.requireTable().get(id)
    if (record === undefined) return undefined
    return identityMatches(record.identity, expected) ? record : undefined
  }

  cachedSnapshot(meta: SessionHeader): ProjectionSnapshot | undefined {
    const record = this.recordFor(meta.id, identityOf(meta))
    if (record === undefined) return undefined
    const values = this.ctx.sessionProjections.viewCheckpoint(record.rows)
    const keys = Object.keys(values)
    if (keys.length === 0) return undefined
    return {
      asOfSeq: Math.min(...keys.map(key => record.rows[key]?.seq ?? -1)),
      values,
    }
  }

  async write(session: Session): Promise<void> {
    const rows = this.ctx.sessionProjections.checkpoint(session)
    this.markClean(session)
    if (this.ctx.sessions.get(session.id) === session) {
      await this.ctx.sessions.flush(session)
    }
    await this.put(session.id, identityOf(session.header), rows)
  }

  async coldSnapshot(id: SessionId, signal?: AbortSignal): Promise<ProjectionSnapshot> {
    const record = this.requireTable().get(id)
    const cached = record?.rows ?? {}
    const floor = this.ctx.sessionProjections.restoreFloor(cached)
    const persistence = this.ctx.sessionPersistence
    if (floor === undefined) {
      return {
        asOfSeq: (await persistence.readFrom(id, 0, signal)).events.at(-1)?.seq ?? -1,
        values: {},
      }
    }

    const tail = await persistence.readFrom(id, floor, signal)
    const related = record === undefined || identityMatches(record.identity, identityOf(tail.meta))
    let restored
    try {
      if (!related) throw new Error('unrelated log identity')
      restored = this.ctx.sessionProjections.restore(cached, tail.events, floor)
    } catch {
      const whole = await persistence.readFrom(id, 0, signal)
      restored = this.ctx.sessionProjections.restore({}, whole.events, 0)
    }
    await this.putSoft(id, identityOf(tail.meta), restored.checkpoint, 'cold-read write-back')
    return restored.snapshot
  }

  private installWritePath(): void {
    this.ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end') {
        void this.flushSoft(session, 'turn/end')
        return
      }
      const state = this.dirty.get(session) ?? { pending: 0, timer: undefined }
      this.dirty.set(session, state)
      state.pending += 1
      if (state.pending >= this.config.writeEveryEvents) {
        void this.flushSoft(session, 'count threshold')
        return
      }
      state.timer ??= setTimeout(() => {
        void this.flushSoft(session, 'interval')
      }, this.config.writeIntervalMs)
    })

    this.ctx.on('session/disposed', (session) => {
      void this.flushSoft(session, 'detach')
      this.markClean(session)
      this.dirty.delete(session)
    })

    this.ctx.effect(() => () => {
      for (const state of this.dirty.values()) {
        if (state.timer !== undefined) clearTimeout(state.timer)
      }
      this.dirty.clear()
    }, 'sessionProjectionCache.timers')
  }

  private async flushSoft(session: Session, trigger: string): Promise<void> {
    try {
      await this.write(session)
    } catch (error) {
      this.ctx.logger.warn(
        `session projection cache: ${trigger} write for "${session.id}" failed (cache stays stale): ${String(error)}`,
      )
    }
  }

  private markClean(session: Session): void {
    const state = this.dirty.get(session)
    if (state === undefined) return
    state.pending = 0
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  private async put(
    id: SessionId,
    identity: CheckpointIdentity,
    rows: ProjectionCheckpoint,
  ): Promise<void> {
    const selected = filterCheckpointRows(rows, this.excluded)
    const detached = snapshotJsonValue(selected)
    if (detached === undefined) {
      throw new TypeError(
        'projection checkpoint is not losslessly JSON-serializable (a unit state violates the plain-JSON contract)',
      )
    }
    await this.requireTable().put(id, {
      identity,
      rows: detached as CheckpointRecord['rows'],
    })
  }

  private async putSoft(
    id: SessionId,
    identity: CheckpointIdentity,
    rows: ProjectionCheckpoint,
    what: string,
  ): Promise<void> {
    try {
      await this.put(id, identity, rows)
    } catch (error) {
      this.ctx.logger.warn(
        `session projection cache: ${what} for "${id}" failed (cache stays stale): ${String(error)}`,
      )
    }
  }

  private requireTable(): ProjectionTable {
    if (this.table === undefined) {
      throw new Error('session projection cache is not initialized')
    }
    return this.table
  }
}

export default FilteredSessionProjectionCache
