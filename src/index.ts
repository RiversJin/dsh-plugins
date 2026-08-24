/**
 * Host half of dsh-session-id.
 *
 * The feature is entirely browser-side. This no-op Cordis entry gives the DSH
 * bundle loader a stable row from which it can discover the package client.
 */
import type { Context } from '@deepseek-ai/cordis';

export const name = 'dsh-session-id';

export function apply(_ctx: Context): void {
  // Intentionally empty: the client entry owns the UI registration.
}
