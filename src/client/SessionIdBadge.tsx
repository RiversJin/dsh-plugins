import { useEffect, useRef, useState } from 'react';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { shortSessionId } from '../session-id.js';
import { copyText } from './session-id.js';

export type SessionIdBadgeProps = PropsRuntime<'conversation.session.header.utilities'>;

export function SessionIdBadge({ sessionId }: SessionIdBadgeProps): JSX.Element {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimer = useRef<number>();
  const shortId = shortSessionId(sessionId);

  useEffect(() => () => {
    if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
  }, []);

  const copy = async (): Promise<void> => {
    if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
    try {
      await copyText(sessionId);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    resetTimer.current = window.setTimeout(() => setCopyState('idle'), 1400);
  };

  const label = copyState === 'copied'
    ? '已复制完整会话 ID'
    : copyState === 'failed'
      ? '复制失败'
      : `复制完整会话 ID：${sessionId}`;

  return (
    <button
      type="button"
      className="dsh-session-id"
      data-dsh-session-id={sessionId}
      data-copy-state={copyState}
      aria-label={label}
      title={label}
      onClick={() => void copy()}
    >
      <span className="dsh-session-id__mark" aria-hidden="true">#</span>
      <span className="dsh-session-id__value">
        {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : shortId}
      </span>
    </button>
  );
}
