import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { parseNotification } from './env.js';
import { BUILTINS, Sandbox, type Env, type Limits, type Program } from './sandbox.js';
import { StateStore, type State } from './state.js';
import { dryRun, type Verdict } from './validate.js';

export * from './sandbox.js';
export * from './validate.js';
export * from './env.js';
export * from './state.js';

export const name = 'dsh-tick-template';
export const inject = ['tools'];

export interface Options extends Limits {
  toolName: string;
  dataDir: string;
  fileRoots: string[];
  timeZone: string;
  trials: number;
  header: string;
}

export const Config: Schema<Partial<Options>> = Schema.object({
  toolName: Schema.string().default('tick_template').description('Name of the tool offered to the author.'),
  dataDir: Schema.string().default('').description('Directory holding one JSON state file per session; default ~/.dsh/tick-template.'),
  fileRoots: Schema.array(Schema.string()).default([]).description('Directories file() may read from; empty disables file().'),
  timeZone: Schema.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  trials: Schema.number().min(1).max(500).step(1).default(20).description('Dry-run renders required before a change is accepted.'),
  header: Schema.string().default('[Tick template]').description('First line of the rendered block appended to each time notification.'),
  timeoutMs: Schema.number().min(5).max(5000).step(1).default(50),
  maxRenderChars: Schema.number().min(1).step(1).default(3000),
  maxFileChars: Schema.number().min(1).step(1).default(4000),
  maxSourceChars: Schema.number().min(1).step(1).default(300),
  maxTemplateChars: Schema.number().min(1).step(1).default(2000),
  maxFunctions: Schema.number().min(1).step(1).default(20),
});

const SOURCE = 'plugin:dsh-tick-template';
const output = { schema: { type: 'json' as const }, render: (_: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 1) }] };

const TOOL_DESCRIPTION = [
  'Shape the text appended to every [Time passing] notification you receive. The template is rendered by the system right before delivery, so values like dice rolls are already decided when you wake up: no tool call needed to roll.',
  'Syntax: any {{expression}} inside the template is a JavaScript expression evaluated in a small sandbox (write \\{{ for a literal). Builtins: dice(count, sides), d(sides), rand(min, max), chance(p), pick(...items), shuffle(array), date(format), weekday(), hour(), minute(), file(path, fallback?), plus env facts clock / quietMinutes / sincePreviousMinutes / sinceHumanMinutes (each may be undefined).',
  'You may define your own one-line helper functions (action=define, e.g. name="mood", source="() => pick(\'静\', \'闹\', \'懒\')") and use them in the template. Every change is dry-run many times first; it is accepted only when every render finishes within the time limit without throwing and within the size limit. A rejected change leaves the previous version in place.',
  'Actions: show (current template, functions, builtins, last render), preview (render now without saving; optional template override), set_template (text), define (name, source), remove (name), clear (drop the template; functions stay).',
].join(' ');

export class TickTemplate {
  readonly config: Options;
  readonly sandbox: Sandbox;
  readonly store: StateStore;
  private readonly edits = new Map<string, Promise<unknown>>();

  constructor(readonly ctx: Context, options: Partial<Options>) {
    const defaults: Options = { toolName: 'tick_template', dataDir: '', fileRoots: [], timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, trials: 20, header: '[Tick template]', timeoutMs: 50, maxRenderChars: 3000, maxFileChars: 4000, maxSourceChars: 300, maxTemplateChars: 2000, maxFunctions: 20 };
    this.config = { ...defaults, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) } as Options;
    const roots = this.config.fileRoots.map(root => resolve(root));
    this.sandbox = new Sandbox(this.config, roots, this.config.timeZone);
    this.store = new StateStore(this.config.dataDir || join(homedir(), '.dsh', 'tick-template'));
  }

  program(state: State, template = state.template ?? ''): Program { return { template, functions: state.functions }; }

  /** Serialize edits per session; validation happens inside so two tool calls cannot interleave. */
  private edit<T>(sessionId: string, fn: (current: State) => Promise<{ state?: State; result: T }>): Promise<T> {
    const previous = this.edits.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const current = await this.store.load(sessionId);
      const outcome = await fn(current);
      if (outcome.state) await this.store.save(outcome.state);
      return outcome.result;
    });
    this.edits.set(sessionId, run);
    run.finally(() => { if (this.edits.get(sessionId) === run) this.edits.delete(sessionId); }).catch(() => undefined);
    return run;
  }

  verdictView(verdict: Verdict) { return { ok: verdict.ok, trials: verdict.trials, ...(verdict.error ? { error: verdict.error } : {}), samples: verdict.samples }; }

  summary(state: State) {
    return {
      revision: state.revision,
      template: state.template,
      functions: Object.entries(state.functions).map(([fnName, def]) => ({ name: fnName, source: def.source, definedAt: new Date(def.definedAt).toISOString() })),
      ...(state.lastRender ? { lastRender: state.lastRender } : {}),
    };
  }

  /** Attempt a candidate; accept only when the dry run passes. */
  private async propose(current: State, candidate: Pick<State, 'template' | 'functions'>, change: string): Promise<{ state?: State; result: Record<string, unknown> }> {
    const program: Program = { template: candidate.template ?? '', functions: candidate.functions };
    const verdict = dryRun(this.sandbox, program, this.config.trials);
    if (!verdict.ok) return { result: { accepted: false, change, ...this.verdictView(verdict), kept: this.summary(current) } };
    const state: State = { ...current, ...candidate, revision: current.revision + 1, updatedAt: Date.now() };
    return { state, result: { accepted: true, change, ...this.verdictView(verdict), now: this.summary(state) } };
  }

  /** Render for one live notification. Errors are reported in the appended text, never thrown into the step. */
  async renderFor(sessionId: string, notification: string): Promise<string | undefined> {
    const state = await this.store.load(sessionId);
    if (state.template === null) return undefined;
    const env = parseNotification(notification);
    let text: string;
    try { text = this.sandbox.render(this.program(state), env, Date.now()); }
    catch (error) {
      const message = (error as Error).message;
      this.ctx.logger.warn(`tick-template ${sessionId}: render failed: ${message}`);
      await this.remember(sessionId, { at: Date.now(), error: message });
      return `${this.config.header} render failed, template revision ${state.revision} unchanged: ${message}`;
    }
    await this.remember(sessionId, { at: Date.now(), text });
    return `${this.config.header}\n${text}`;
  }

  private remember(sessionId: string, lastRender: NonNullable<State['lastRender']>): Promise<void> {
    return this.edit(sessionId, async current => ({ state: { ...current, lastRender }, result: undefined }));
  }

  mount(): void {
    const { ctx } = this;
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next();
      if (decision.kind !== 'enter' || agent.session.header.origin === 'subagent') return decision;
      const index = decision.messages.findIndex(message => isTimeNotification(message));
      if (index < 0) return decision;
      const message = decision.messages[index]!;
      const body = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (body.includes(`\n${this.config.header}`)) return decision; // recovered delivery already carries a render
      const appended = await this.renderFor(agent.session.id, body);
      if (appended === undefined || signal.aborted) return decision;
      const replaced: UserMessage = { ...message, content: [...message.content, { type: 'text', text: appended }] };
      return { ...decision, messages: decision.messages.map((m, i) => (i === index ? replaced : m)) };
    });

    ctx.tools.register(defineTool({
      name: this.config.toolName, description: TOOL_DESCRIPTION,
      parameters: {
        action: { type: 'string', enum: ['show', 'preview', 'set_template', 'define', 'remove', 'clear'], required: true },
        template: { type: 'string', description: 'set_template: the new template. preview: optional template to try without saving.' },
        name: { type: 'string', description: 'define / remove: function name, [A-Za-z_][A-Za-z0-9_]*, up to 32 chars.' },
        source: { type: 'string', description: 'define: one-line JavaScript function expression, e.g. "() => d(6)" or "(n) => pick(...Array(n).keys())".' },
      }, output,
      execute: async (args, exec) => {
        const agent = exec.agent as Agent | undefined;
        if (!agent) throw new Error('An agent is required');
        if (agent.session.header.origin === 'subagent') throw new Error(`${this.config.toolName} is only available to the main session`);
        const sessionId = agent.session.id;
        switch (args.action) {
          case 'show': {
            const state = await this.store.load(sessionId);
            return json({ ...this.summary(state), builtins: BUILTINS, limits: { timeoutMs: this.config.timeoutMs, maxRenderChars: this.config.maxRenderChars, maxSourceChars: this.config.maxSourceChars, maxTemplateChars: this.config.maxTemplateChars, maxFunctions: this.config.maxFunctions, trials: this.config.trials }, fileRoots: this.sandbox.fileRoots });
          }
          case 'preview': {
            const state = await this.store.load(sessionId);
            const template = args.template ?? state.template;
            if (template === null || template === undefined) return json({ ok: false, error: 'no template yet; pass template= to preview one' });
            const verdict = dryRun(this.sandbox, this.program(state, template), 3);
            return json({ ...this.verdictView(verdict), saved: false });
          }
          case 'set_template': {
            if (typeof args.template !== 'string' || !args.template.trim()) throw new Error('set_template needs template');
            return json(await this.edit(sessionId, current => this.propose(current, { template: args.template!, functions: current.functions }, 'set_template')));
          }
          case 'define': {
            if (!args.name || typeof args.source !== 'string') throw new Error('define needs name and source');
            const fnName = args.name, source = args.source.trim();
            return json(await this.edit(sessionId, async current => {
              try { this.sandbox.compileFunction(this.sandbox.context(this.program(current, ''), {}, Date.now()), fnName, source); }
              catch (error) { return { result: { accepted: false, change: `define ${fnName}`, ok: false, trials: 0, error: (error as Error).message, samples: [], kept: this.summary(current) } }; }
              return this.propose(current, { template: current.template, functions: { ...current.functions, [fnName]: { source, definedAt: Date.now() } } }, `define ${fnName}`);
            }));
          }
          case 'remove': {
            if (!args.name) throw new Error('remove needs name');
            const fnName = args.name;
            return json(await this.edit(sessionId, async current => {
              if (!(fnName in current.functions)) return { result: { accepted: false, change: `remove ${fnName}`, ok: false, trials: 0, error: `no function named ${fnName}`, samples: [], kept: this.summary(current) } };
              const { [fnName]: _dropped, ...functions } = current.functions;
              return this.propose(current, { template: current.template, functions }, `remove ${fnName}`);
            }));
          }
          case 'clear':
            return json(await this.edit(sessionId, async current => {
              const state: State = { ...current, template: null, revision: current.revision + 1, updatedAt: Date.now() };
              return { state, result: { accepted: true, change: 'clear', now: this.summary(state) } };
            }));
          default:
            throw new Error(`unknown action ${String(args.action)}`);
        }
      },
    }));
    ctx.logger.info(`tick-template mounted: tool=${this.config.toolName}; fileRoots=${this.sandbox.fileRoots.join(',') || 'none'}; trials=${this.config.trials}; timeout=${this.config.timeoutMs}ms`);
  }
}

function isTimeNotification(message: UserMessage): boolean {
  const source = message.source as { kind?: string; notification?: string };
  return source.kind === 'schedule' && source.notification === 'time_passing';
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as never;

export function apply(ctx: Context, config: Partial<Options> = {}): void {
  new TickTemplate(ctx, config).mount();
}

export type { Env };
