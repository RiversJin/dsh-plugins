import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import {
  createDeveloperMessage, isAgentLoopRequest, markAgentLoopRequest,
  type GenerateOptions, type LlmCallConfig, type LlmFailure, type Message,
} from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
import { renderPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt';
import { estimateToolsTokens } from '@deepseek-ai/dsh-token-meter/estimate';
import type {} from '@deepseek-ai/dsh-token-meter';
import type {} from '@deepseek-ai/dsh-compaction-basic';
import z from '@deepseek-ai/schemastery';
import { z as stateSchema } from 'zod';

export const name = 'dsh-kimi-auto';
export const inject = ['agents', 'llm', 'tokenMeter', 'sessionProjections', 'systemPrompt'];
export const PROVIDER = 'kimi-coding';
export const SMALL = 'k3-256k';
export const LARGE = 'k3';
export const SMALL_WINDOW = 262_144;
export const LARGE_WINDOW = 1_048_576;
export type Tier = typeof SMALL | typeof LARGE;

export interface PluginConfig {
  enabled?: boolean;
  upgradePromptTokens?: number;
  downgradePromptTokens?: number;
  reserveTokens?: number;
  safetyTokens?: number;
}
export interface ResolvedConfig {
  enabled: boolean;
  upgradePromptTokens: number;
  downgradePromptTokens: number;
  reserveTokens: number;
  safetyTokens: number;
}
export const Config: z<PluginConfig> = z.object({
  enabled: z.boolean().default(true),
  upgradePromptTokens: z.natural().min(1).max(SMALL_WINDOW - 1).default(253_952),
  downgradePromptTokens: z.natural().min(1).max(SMALL_WINDOW - 1).default(196_608),
  reserveTokens: z.natural().min(1).max(SMALL_WINDOW - 1).default(4_096),
  safetyTokens: z.natural().min(1).max(SMALL_WINDOW - 1).default(4_096),
});

export function resolveConfig(config: PluginConfig = {}): ResolvedConfig {
  const result = {
    enabled: config.enabled ?? true,
    upgradePromptTokens: config.upgradePromptTokens ?? 253_952,
    downgradePromptTokens: config.downgradePromptTokens ?? 196_608,
    reserveTokens: config.reserveTokens ?? 4_096,
    safetyTokens: config.safetyTokens ?? 4_096,
  };
  for (const key of ['upgradePromptTokens', 'downgradePromptTokens', 'reserveTokens', 'safetyTokens'] as const) {
    if (!Number.isSafeInteger(result[key]) || result[key] <= 0 || result[key] >= SMALL_WINDOW) {
      throw new Error(`dsh-kimi-auto: invalid ${key}`);
    }
  }
  if (result.downgradePromptTokens >= result.upgradePromptTokens
    || result.reserveTokens + result.safetyTokens >= SMALL_WINDOW) {
    throw new Error('dsh-kimi-auto: downgrade threshold must be below upgrade threshold and headroom must fit');
  }
  return result;
}

export function isK3(provider: unknown, model: unknown): model is Tier {
  return provider === PROVIDER && (model === SMALL || model === LARGE);
}
type Reason = 'initial' | 'upgrade' | 'downgrade' | 'overflow' | 'video';
export interface RouteState {
  model: Tier;
  promptTokens: number;
  reason: Reason;
  /** Refuse the failed small-tier size again until the prompt shrinks materially. */
  overflowPromptTokens: number | null;
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:dsh-kimi-auto': { kind: 'plugin:dsh-kimi-auto'; form: 'route'; decision: RouteState };
  }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { kimiAuto: RouteState | null; }
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Optional logical target for pressure compaction, separate from the wire tier. */
    'compaction/pressure-target'(
      payload: { agent: Agent; target: Pick<LlmCallConfig, 'provider' | 'model'>; signal?: AbortSignal },
      next: () => Promise<Pick<LlmCallConfig, 'provider' | 'model'>>,
    ): Promise<Pick<LlmCallConfig, 'provider' | 'model'>>;
  }
}
export const routingProjection: ProjectionDefinition<'kimiAuto'> = {
  key: 'kimiAuto', stateVersion: 1,
  stateSchema: stateSchema.object({
    model: stateSchema.enum([SMALL, LARGE]), promptTokens: stateSchema.number().int().nonnegative(),
    reason: stateSchema.enum(['initial', 'upgrade', 'downgrade', 'overflow', 'video']),
    overflowPromptTokens: stateSchema.number().int().nonnegative().nullable(),
  }).nullable(),
  init: () => null,
  apply(state, event) {
    if (event.type !== 'developer/message' || event.data.message.source.kind !== 'plugin:dsh-kimi-auto') return state;
    return event.data.message.source.decision;
  },
};

export interface RoutingInput {
  promptTokens: number;
  maxTokens?: number;
  previous: RouteState | null;
  hasVideo?: boolean;
}
/** Pure hysteresis policy; an explicit output reservation can only promote sooner. */
export function chooseTier(input: RoutingInput, config: ResolvedConfig): Tier {
  const { promptTokens, previous } = input;
  if (!Number.isFinite(promptTokens) || promptTokens < 0 || input.hasVideo) return LARGE;
  const reservation = Math.max(config.reserveTokens, input.maxTokens ?? 0);
  const upper = Math.min(config.upgradePromptTokens, SMALL_WINDOW - reservation - config.safetyTokens);
  const hysteresis = config.upgradePromptTokens - config.downgradePromptTokens;
  const learned = previous?.overflowPromptTokens == null ? Infinity : previous.overflowPromptTokens - hysteresis;
  if (promptTokens >= upper || promptTokens >= learned) return LARGE;
  if (previous?.model === LARGE && promptTokens > Math.min(config.downgradePromptTokens, upper - hysteresis)) return LARGE;
  return SMALL;
}

/** Only a provider-confirmed capacity failure justifies changing the paid tier. */
export function isSmallContextOverflow(failure: LlmFailure): boolean {
  if (failure.code === 'CONTEXT_WINDOW_EXCEEDED') return true;
  return /\bk3-256k\s+supports\s+only\s+256\s*k\s+context\b/i.test(failure.message);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}

/**
 * The two K3 tiers share a replay protocol. pi-ai otherwise strips signed
 * thinking when their IDs differ. Normalize only adapter-private identity in
 * the transport copy; preserve every content block, signature, and raw event.
 * Unknown/fallback models and invalid replay envelopes retain native behavior.
 */
export function compatibleK3History(messages: GenerateOptions['messages'], target: Tier): GenerateOptions['messages'] {
  let changed = false;
  const result = messages.map(message => {
    if (message.role !== 'assistant' || !isK3(message.source.provider, message.source.model)) return message;
    const replay = object(message.source.replayState), response = object(replay?.['response']);
    if (!replay || !response || response['kind'] !== 'pi-ai' || response['version'] !== 2
      || response['api'] !== 'anthropic-messages' || response['provider'] !== PROVIDER
      || response['model'] !== message.source.model || !Array.isArray(replay['blocks'])
      || (response['responseModel'] !== undefined && !isK3(PROVIDER, response['responseModel']))) return message;
    if (message.source.model === target && (response['responseModel'] === undefined || response['responseModel'] === target)) return message;
    changed = true;
    return freeze({ ...message, source: {
      ...message.source, model: target,
      replayState: { ...replay, response: { ...response, model: target,
        ...(response['responseModel'] === undefined ? {} : { responseModel: target }),
      } },
    } }) as Message;
  });
  return changed ? freeze(result) : messages;
}

/** Pending text has no server usage anchor yet; price UTF-8 and new images conservatively. */
function pendingPrice(message: Message, estimate: (message: Message) => number): number {
  const text = message.content.reduce((sum, block) => sum + ('text' in block && typeof block.text === 'string'
    ? Buffer.byteLength(block.text, 'utf8') : 0), 0);
  const images = message.content.filter(block => block.type === 'image' && block.offloaded !== true).length;
  return Math.max(estimate(message), Math.ceil(text / 3) + 4 + images * 16_384);
}
function includesVideo(messages: readonly Message[]): boolean {
  return messages.some(message => message.content.some(block => {
    const raw = object(block), attachment = object(raw?.['attachment']);
    return raw?.['type'] === 'video' || (typeof attachment?.['mediaType'] === 'string'
      && attachment['mediaType'].startsWith('video/'));
  }));
}
interface PendingStep { turn: number; step: number; messages: readonly Message[]; admitted: boolean; }

export function apply(ctx: Context, config: PluginConfig = {}): void {
  const resolved = resolveConfig(config);
  ctx.sessionProjections.register(routingProjection);
  if (!resolved.enabled) return;
  const assemblies = new WeakMap<Agent, PromptAssembly>();
  const pending = new WeakMap<Agent, PendingStep>();
  const estimates = new WeakMap<Agent, number>();
  const decisions = new WeakMap<Agent, RouteState>();
  const delegated = new WeakSet<GenerateOptions>();
  const admissions = new WeakMap<Agent, () => void>();
  const scopedAgents = new WeakSet<Agent>();
  const admissionDisposers = new Set<() => void>();
  ctx.effect(() => () => { for (const dispose of admissionDisposers) dispose(); admissionDisposers.clear(); });
  const stateOf = (session: Session): RouteState | null => ctx.sessionProjections.stateOf(session, 'kimiAuto') ?? null;
  const record = (agent: Agent, turn: number, step: number, decision: RouteState): void => {
    agent.session.append('developer/message', { turn, step,
      message: createDeveloperMessage({ content: [], source: { kind: 'plugin:dsh-kimi-auto', form: 'route', decision } }),
    }, { surfaceOp: 'append' });
  };

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next();
    const output = isK3(assembly.variables['provider'], assembly.variables['model'])
      ? { ...assembly, variables: { ...assembly.variables, model: LARGE } } : assembly;
    if (context.agent) {
      const agent = context.agent;
      assemblies.set(agent, output);
      // Entry points install their own prepended model-selection notice hook,
      // and the web session controller installs it lazily on the first UI pick,
      // which may happen long after this agent's first step. Prepended hooks run
      // newest-first, so a hook installed later would run outside this wrapper
      // and its notice would never be seen here (2026-10-22: eight
      // "[model changed: k3-256k → k3]" notices in one night). Re-register on
      // every assembly, which immediately precedes each pre-step, so this
      // wrapper is always the newest and sees the final batch.
      admissions.get(agent)?.();
      const dispose = agent.ctx.on('agent/pre-step', async ({ turn, step, signal }, next) => {
        const decision = await next();
        if (decision.kind === 'reject' || signal.aborted) return decision;
        const selected = assemblies.get(agent)?.variables, previous = agent.session.requestHeader()?.config;
        const sameFamily = isK3(selected?.['provider'], selected?.['model']) && isK3(previous?.provider, previous?.model);
        const messages = sameFamily ? decision.messages.filter(message => message.source.kind !== 'model-selection') : decision.messages;
        pending.set(agent, { turn, step, messages, admitted: false });
        return messages === decision.messages ? decision : { ...decision, messages };
      }, { prepend: true });
      const release = () => { dispose(); admissionDisposers.delete(release); if (admissions.get(agent) === release) admissions.delete(agent); };
      admissions.set(agent, release);
      admissionDisposers.add(release);
      if (!scopedAgents.has(agent)) {
        scopedAgents.add(agent);
        agent.ctx.effect(() => () => admissions.get(agent)?.());
      }
    }
    return output;
  }, { prepend: true });

  ctx.on('agent/request', async ({ agent, turn, step, signal }, next) => {
    decisions.delete(agent);
    const proposal = await next();
    if (signal.aborted || !isK3(proposal.provider, proposal.model)) return proposal;
    const measurement = ctx.tokenMeter.measure(agent.session);
    const assembly = assemblies.get(agent), batch = pending.get(agent);
    const additions = batch?.turn === turn && batch.step === step && !batch.admitted ? batch.messages : [];
    // Keep the real usage anchor from the latest request across the equivalent
    // tier change. Repricing with a different model ID would lose that anchor.
    let total = measurement.totalTokens;
    if (measurement.baseline.kind !== 'usage') total = Math.ceil(total * 1.3);
    const lastUsage = measurement.baseline.kind === 'usage'
      ? agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message' && event.data.stream.some(entry => entry.type === 'chunk' && entry.chunk.type === 'usage'))?.seq
      : undefined;
    for (const node of measurement.nodes) {
      if (lastUsage !== undefined && node.seq <= lastUsage) continue;
      const event = agent.session.eventAt(node.seq);
      const message = event === undefined ? null : agent.session.deriveEventMessage(event);
      if (message) total += Math.max(0, pendingPrice(message, m => ctx.tokenMeter.estimateMessage(m))
        - node.tokens * (measurement.baseline.kind === 'usage' ? 1 : 1.3));
    }
    total += additions.reduce((sum, message) => sum + pendingPrice(message, m => ctx.tokenMeter.estimateMessage(m)), 0);
    if (assembly) {
      const oldHeader = agent.session.requestHeader();
      total += Math.max(0, estimateToolsTokens({ config: proposal, tools: assembly.tools }) - estimateToolsTokens(oldHeader));
      const oldSystem = agent.session.deriveMessages().find(message => message.role === 'system');
      const oldText = oldSystem?.content.reduce((text, block) => text + ('text' in block ? block.text : ''), '') ?? '';
      total += Math.max(0, Math.ceil((Buffer.byteLength(renderPrompt(assembly), 'utf8') - Buffer.byteLength(oldText, 'utf8')) / 3));
    }
    const previous = stateOf(agent.session), video = includesVideo([...agent.session.deriveMessages(), ...additions]);
    const promptTokens = Math.ceil(total);
    estimates.set(agent, promptTokens);
    const model = chooseTier({ promptTokens, previous, hasVideo: video,
      ...(proposal.maxTokens === undefined ? {} : { maxTokens: proposal.maxTokens }) }, resolved);
    if (previous === null || previous.model !== model) {
      decisions.set(agent, { model, promptTokens,
        reason: video ? 'video' : previous === null ? 'initial' : model === LARGE ? 'upgrade' : 'downgrade',
        overflowPromptTokens: previous?.overflowPromptTokens ?? null,
      });
    }
    if (batch?.turn === turn && batch.step === step) batch.admitted = true;
    return model === proposal.model ? proposal : { ...proposal, model };
  }, { prepend: true });

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type !== 'start') return;
    const decision = decisions.get(agent);
    if (!decision) return;
    decisions.delete(agent);
    record(agent, frame.turn, frame.step, decision);
  });

  ctx.on('agent/request-error', async ({ agent, turn, step, provider, failure, signal }, next) => {
    const current = agent.session.requestHeader()?.config;
    if (signal.aborted || provider !== PROVIDER || current?.model !== SMALL || !isSmallContextOverflow(failure)) return next();
    const lastAttempt = agent.session.snapshotEvents().findLast(event => event.type === 'assistant/attempt');
    // Do not replay an attempt that already emitted model content or tool input.
    if (lastAttempt?.type === 'assistant/attempt' && lastAttempt.data.stream.some(entry => entry.type !== 'chunk'
      || (entry.chunk.type !== 'finish' && entry.chunk.type !== 'usage'))) return next();
    const promptTokens = estimates.get(agent) ?? Math.ceil(ctx.tokenMeter.measure(agent.session).totalTokens);
    const previous = stateOf(agent.session);
    record(agent, turn, step, { model: LARGE, promptTokens, reason: 'overflow',
      overflowPromptTokens: Math.min(previous?.overflowPromptTokens ?? Infinity, promptTokens),
    });
    return { kind: 'retry' };
  }, { prepend: true });

  ctx.on('compaction/pressure-target', async (_payload, next) => {
    const target = await next();
    return isK3(target.provider, target.model) ? { ...target, model: LARGE } : target;
  });

  ctx.on('llm/stream', async function* (options, next) {
    if (delegated.has(options) || !isK3(options.provider, options.model)) { yield* next(); return; }
    const messages = compatibleK3History(options.messages, options.model);
    if (messages === options.messages) { yield* next(); return; }
    // History is already immutable. Runtime objects such as AbortSignal must
    // retain their mutable internals for SDK cancellation and timeout wiring.
    const forwarded = Object.freeze({ ...options, messages });
    if (isAgentLoopRequest(options)) markAgentLoopRequest(forwarded);
    delegated.add(forwarded);
    try { yield* this.stream(forwarded); } finally { delegated.delete(forwarded); }
  }, { prepend: true });

  ctx.logger.info(`Kimi K3 automatic tiers: promote before ${resolved.upgradePromptTokens}, demote at ${resolved.downgradePromptTokens} prompt tokens`);
}

export default { name, inject, Config, apply };
