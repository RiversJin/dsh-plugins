import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

/** Hard bounds every render and every accepted definition must respect. */
export interface Limits {
  /** Wall-clock budget for one expression or one function probe. */
  timeoutMs: number;
  maxRenderChars: number;
  maxFileChars: number;
  maxSourceChars: number;
  maxTemplateChars: number;
  maxFunctions: number;
}

/** Facts parsed from the schedule notification, exposed to expressions. All optional. */
export interface Env {
  clock?: string;
  quietMinutes?: number;
  sincePreviousMinutes?: number;
  sinceHumanMinutes?: number;
}

export interface FunctionDef { source: string; definedAt: number; }
export interface Program { template: string; functions: Record<string, FunctionDef>; }

export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const EXPRESSION = /\\?\{\{([\s\S]+?)\}\}/g;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** Names the sandbox always provides; user functions may not shadow them. */
export const BUILTINS: readonly { name: string; signature: string; doc: string }[] = [
  { name: 'dice', signature: 'dice(count = 1, sides = 6)', doc: 'Sum of count rolls of a sides-sided die.' },
  { name: 'd', signature: 'd(sides)', doc: 'One roll: integer in 1..sides.' },
  { name: 'rand', signature: 'rand(min, max)', doc: 'Uniform integer in [min, max].' },
  { name: 'chance', signature: 'chance(p)', doc: 'true with probability p (0..1).' },
  { name: 'pick', signature: 'pick(...items) / pick(array)', doc: 'One item chosen uniformly.' },
  { name: 'shuffle', signature: 'shuffle(array)', doc: 'A shuffled copy.' },
  { name: 'date', signature: "date(format = 'YYYY-MM-DD HH:mm')", doc: 'Current time in the configured time zone. Tokens: YYYY MM DD HH mm ss ddd (weekday).' },
  { name: 'weekday', signature: 'weekday()', doc: 'Weekday in Chinese, e.g. 周一.' },
  { name: 'hour', signature: 'hour() / minute()', doc: 'Current hour (0-23) / minute in the configured time zone.' },
  { name: 'file', signature: 'file(path, fallback?)', doc: 'Text of a file under an allowed root (relative paths resolve against the first root), truncated to the size limit. Missing file: fallback if given, else an error.' },
  { name: 'env', signature: 'env / clock / quietMinutes / sincePreviousMinutes / sinceHumanMinutes', doc: 'Facts from the time notification; each may be undefined.' },
];

function assertFinite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${what} must be a finite number`);
  return value;
}

/** Deterministic-enough pieces of a timestamp in one zone. */
function parts(now: number, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(now))) out[part.type] = part.value;
  return out;
}

export function formatDate(now: number, timeZone: string, format: string): string {
  const p = parts(now, timeZone);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday ?? '');
  const table: Record<string, string> = {
    YYYY: p.year ?? '', MM: p.month ?? '', DD: p.day ?? '', HH: p.hour ?? '', mm: p.minute ?? '', ss: p.second ?? '',
    ddd: WEEKDAYS[weekday] ?? p.weekday ?? '',
  };
  return format.replace(/YYYY|MM|DD|HH|mm|ss|ddd/g, token => table[token] ?? token);
}

export class Sandbox {
  constructor(readonly limits: Limits, readonly fileRoots: readonly string[], readonly timeZone: string, readonly random: () => number = Math.random) {}

  private readFile(path: unknown, fallback?: unknown): string {
    if (typeof path !== 'string' || !path) throw new TypeError('file(path) needs a path');
    if (!this.fileRoots.length) throw new Error('file() is disabled: no fileRoots configured');
    const base = this.fileRoots[0]!;
    const full = isAbsolute(path) ? resolve(path) : resolve(base, path);
    if (!this.fileRoots.some(root => full === root || full.startsWith(root.endsWith(sep) ? root : root + sep))) throw new Error(`file(): ${path} is outside the allowed roots`);
    let text: string;
    try { text = readFileSync(full, 'utf8'); }
    catch (error) {
      if (fallback !== undefined) return String(fallback);
      throw new Error(`file(): cannot read ${path}: ${(error as Error).message}`);
    }
    return text.length > this.limits.maxFileChars ? `${text.slice(0, this.limits.maxFileChars)}\n…(truncated at ${this.limits.maxFileChars} chars)` : text;
  }

  /** Globals every expression sees. */
  private builtins(env: Env, now: number): Record<string, unknown> {
    const random = this.random;
    const int = (min: number, max: number) => Math.floor(random() * (max - min + 1)) + min;
    const d = (sides: unknown) => { const n = Math.floor(assertFinite(sides, 'sides')); if (n < 1) throw new RangeError('sides must be >= 1'); return int(1, n); };
    return {
      d,
      dice: (count: unknown = 1, sides: unknown = 6) => { const c = Math.floor(assertFinite(count, 'count')); if (c < 1 || c > 1000) throw new RangeError('count must be 1..1000'); let sum = 0; for (let i = 0; i < c; i++) sum += d(sides); return sum; },
      rand: (min: unknown, max: unknown) => { const lo = Math.ceil(assertFinite(min, 'min')), hi = Math.floor(assertFinite(max, 'max')); if (hi < lo) throw new RangeError('max must be >= min'); return int(lo, hi); },
      chance: (p: unknown) => random() < assertFinite(p, 'p'),
      pick: (...items: unknown[]) => { const list = items.length === 1 && Array.isArray(items[0]) ? items[0] as unknown[] : items; if (!list.length) throw new RangeError('pick() needs at least one item'); return list[int(0, list.length - 1)]; },
      shuffle: (list: unknown) => { if (!Array.isArray(list)) throw new TypeError('shuffle() needs an array'); const copy = [...list]; for (let i = copy.length - 1; i > 0; i--) { const j = int(0, i); [copy[i], copy[j]] = [copy[j], copy[i]]; } return copy; },
      date: (format: unknown = 'YYYY-MM-DD HH:mm') => formatDate(now, this.timeZone, String(format)),
      weekday: () => formatDate(now, this.timeZone, 'ddd'),
      hour: () => Number(formatDate(now, this.timeZone, 'HH')),
      minute: () => Number(formatDate(now, this.timeZone, 'mm')),
      file: (path: unknown, fallback?: unknown) => this.readFile(path, fallback),
      env: { ...env },
      clock: env.clock, quietMinutes: env.quietMinutes, sincePreviousMinutes: env.sincePreviousMinutes, sinceHumanMinutes: env.sinceHumanMinutes,
    };
  }

  /** Compile one function source; returns the function value (host side) after checking it is one. */
  compileFunction(context: vm.Context, name: string, source: string): (...args: unknown[]) => unknown {
    if (!NAME_PATTERN.test(name)) throw new Error(`function name ${JSON.stringify(name)} must match ${NAME_PATTERN}`);
    if (BUILTINS.some(b => b.name === name) || ['env', 'clock', 'quietMinutes', 'sincePreviousMinutes', 'sinceHumanMinutes', 'minute'].includes(name)) throw new Error(`${name} is a builtin and cannot be redefined`);
    if (typeof source !== 'string' || !source.trim()) throw new Error(`function ${name}: empty source`);
    if (source.length > this.limits.maxSourceChars) throw new Error(`function ${name}: source is ${source.length} chars, limit ${this.limits.maxSourceChars}`);
    if (/\n/.test(source.trim())) throw new Error(`function ${name}: one line only`);
    let script: vm.Script;
    try { script = new vm.Script(`(${source})`, { filename: `fn:${name}` }); }
    catch (error) { throw new Error(`function ${name}: syntax error: ${(error as Error).message}`); }
    const value = script.runInContext(context, { timeout: this.limits.timeoutMs });
    if (typeof value !== 'function') throw new Error(`function ${name}: source must evaluate to a function, e.g. () => d(6)`);
    return value as (...args: unknown[]) => unknown;
  }

  /** A fresh context holding builtins, env and every user function (defined in insertion order). */
  context(program: Program, env: Env, now: number): vm.Context {
    const context = vm.createContext(this.builtins(env, now), { name: 'tick-template' });
    for (const [name, def] of Object.entries(program.functions)) context[name] = this.compileFunction(context, name, def.source);
    return context;
  }

  evaluate(context: vm.Context, expression: string): unknown {
    const script = new vm.Script(`(${expression}\n)`, { filename: 'expr' });
    return script.runInContext(context, { timeout: this.limits.timeoutMs });
  }

  render(program: Program, env: Env, now: number): string {
    if (program.template.length > this.limits.maxTemplateChars) throw new Error(`template is ${program.template.length} chars, limit ${this.limits.maxTemplateChars}`);
    const context = this.context(program, env, now);
    const text = program.template.replace(EXPRESSION, (match, expression: string) => {
      if (match.startsWith('\\')) return match.slice(1);
      let value: unknown;
      try { value = this.evaluate(context, expression); }
      catch (error) { throw new Error(`{{${expression.trim()}}}: ${(error as Error).message}`); }
      return stringify(value);
    });
    if (text.length > this.limits.maxRenderChars) throw new Error(`rendered ${text.length} chars, limit ${this.limits.maxRenderChars}`);
    return text;
  }
}

export function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'function') throw new TypeError('expression returned a function; call it');
  if (typeof value === 'symbol') return value.toString();
  return JSON.stringify(value) ?? '';
}
