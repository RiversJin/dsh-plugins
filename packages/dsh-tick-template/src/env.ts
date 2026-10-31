import type { Env } from './sandbox.js';

/** "1d 2h 3m 4s" → minutes (integer, floor). Undefined when nothing matches. */
export function durationMinutes(text: string): number | undefined {
  let seconds = 0, matched = false;
  for (const m of text.matchAll(/(\d+)\s*([dhms])/g)) {
    matched = true;
    const n = Number(m[1]);
    seconds += m[2] === 'd' ? n * 86400 : m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
  }
  return matched ? Math.floor(seconds / 60) : undefined;
}

/** Parse the dsh-schedule time_passing body. Unknown lines are ignored; a changed format yields a sparse Env. */
export function parseNotification(text: string): Env {
  const env: Env = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim(), value = line.slice(colon + 1).trim();
    if (key === 'Current time') env.clock = value;
    else if (key === 'Time spent quiet') { const v = durationMinutes(value); if (v !== undefined) env.quietMinutes = v; }
    else if (key === 'Time since the previous time notification') { const v = durationMinutes(value); if (v !== undefined) env.sincePreviousMinutes = v; }
    else if (/^Time since .* last message$/.test(key)) { const v = durationMinutes(value); if (v !== undefined) env.sinceHumanMinutes = v; }
  }
  return env;
}
