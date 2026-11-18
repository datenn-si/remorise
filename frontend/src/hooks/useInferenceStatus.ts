import { useEffect, useRef, useState } from 'react';
import { getInferenceStatus } from '../services/chat';
import type { InferenceStatus } from '../types/chat';

export const INFERENCE_STATUS_POLL_MS = 2000;

export type InferenceStatusOptions = {
  /**
   * Called once each time the status settles back to idle after a
   * foreground turn was seen running. Background work observed in
   * between (for example the finished turn's extraction pass) does not
   * cancel the notification: the foreground turn is over either way.
   */
  onForegroundSettled?: () => void;
};

/**
 * Polls the backend's inference activity while mounted, so the chat page
 * can show the character as thinking while background work is using
 * inference (or a send is queued behind it). A failed poll keeps the
 * last known status; connectivity problems are reported by the health
 * check and the connection banner, not by this indicator.
 */
export function useInferenceStatus(options?: InferenceStatusOptions): InferenceStatus | null {
  const [status, setStatus] = useState<InferenceStatus | null>(null);
  const settledCallback = useRef(options?.onForegroundSettled);
  settledCallback.current = options?.onForegroundSettled;
  const sawForeground = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let current: InferenceStatus | null = null;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await getInferenceStatus();
        if (cancelled) return;
        // Most polls report the same status; writing it back would
        // re-render the whole chat page every two seconds for
        // nothing, so only an actual change reaches the state.
        if (
          current === null ||
          current.active !== next.active ||
          current.background_kind !== next.background_kind ||
          current.foreground_waiting !== next.foreground_waiting ||
          current.foreground_phase !== next.foreground_phase
        ) {
          current = next;
          setStatus(next);
        }
        if (next.active === 'foreground') {
          sawForeground.current = true;
        } else if (next.active === null && sawForeground.current) {
          sawForeground.current = false;
          settledCallback.current?.();
        }
      } catch {
        // Keep the last known status; see the docstring.
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), INFERENCE_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return status;
}
