/** Remove DSH's internal prefix, then use the same eight-character form as QQ. */
export function shortSessionId(sessionId: string): string {
  const normalized = sessionId.startsWith('session-')
    ? sessionId.slice('session-'.length)
    : sessionId;
  return normalized.slice(0, 8);
}
