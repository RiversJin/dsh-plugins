import type { Env, Program, Sandbox } from './sandbox.js';
import { NAME_PATTERN, stringify } from './sandbox.js';

export type ProbeEnvName = 'full' | 'empty' | 'partial';
/** One distinct render from the dry run, labelled with the probe environment that produced it,
 * so a blank or "?" render is recognizably the empty-notification probe rather than a defect. */
export interface Sample { env: ProbeEnvName; text: string; }
export interface Verdict {
  ok: boolean;
  /** Up to three distinct renders from the dry run (ok only), each tagged with its probe environment. */
  samples: Sample[];
  error?: string;
  trials: number;
}

/** Environments the dry run alternates between: a full notification, an empty one (no facts parsed) and a partial one. */
export const PROBE_ENVS: readonly { name: ProbeEnvName; env: Env }[] = [
  { name: 'full', env: { clock: '2026-10-19 11:08:12 (Asia/Singapore)', quietMinutes: 60, sincePreviousMinutes: 946, sinceHumanMinutes: 61 } },
  { name: 'empty', env: {} },
  { name: 'partial', env: { clock: '2026-10-19 21:29:01 (Asia/Singapore)', quietMinutes: 60, sincePreviousMinutes: 60 } },
];

/** Compile every function, probe zero-arity ones, and render the whole template repeatedly.
 * Pure apart from file() reads. Never throws: every problem lands in `error`. */
export function dryRun(sandbox: Sandbox, program: Program, trials: number, now = Date.now()): Verdict {
  const names = Object.keys(program.functions);
  if (names.length > sandbox.limits.maxFunctions) return { ok: false, samples: [], trials: 0, error: `${names.length} functions defined, limit ${sandbox.limits.maxFunctions}` };
  for (const name of names) if (!NAME_PATTERN.test(name)) return { ok: false, samples: [], trials: 0, error: `function name ${JSON.stringify(name)} must match ${NAME_PATTERN}` };
  const samples: Sample[] = [];
  let done = 0;
  try {
    for (let i = 0; i < trials; i++) {
      const { name: envName, env } = PROBE_ENVS[i % PROBE_ENVS.length]!;
      const context = sandbox.context(program, env, now + i * 61_000);
      // Zero-arity functions are probed directly so a broken helper is caught even before the template uses it.
      for (const name of names) {
        const fn = context[name] as (...args: unknown[]) => unknown;
        if (fn.length !== 0) continue;
        let value: unknown;
        try { value = sandbox.evaluate(context, `${name}()`); }
        catch (error) { throw new Error(`function ${name}(): ${(error as Error).message}`); }
        const text = stringify(value);
        if (text.length > sandbox.limits.maxRenderChars) throw new Error(`function ${name}() returned ${text.length} chars, limit ${sandbox.limits.maxRenderChars}`);
      }
      const rendered = sandbox.render(program, env, now + i * 61_000);
      if (samples.length < 3 && !samples.some(sample => sample.text === rendered)) samples.push({ env: envName, text: rendered });
      done++;
    }
  } catch (error) {
    return { ok: false, samples, trials: done, error: (error as Error).message };
  }
  return { ok: true, samples, trials: done };
}
