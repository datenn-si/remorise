import { useEffect, useState } from 'react';
import { getHealth } from '../services/api';

export const HEALTH_POLL_MS = 2000;
const HEALTH_FAILURE_LIMIT = 3;
const HEALTH_TIMEOUT_MS = 5000;

export function useHealth(version: number): boolean | null {
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    let failures = 0;
    let inFlight = false;
    const check = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await getHealth(AbortSignal.any([abort.signal, AbortSignal.timeout(HEALTH_TIMEOUT_MS)]));
        if (!abort.signal.aborted) {
          failures = 0;
          setOnline(true);
        }
      } catch {
        if (!abort.signal.aborted && ++failures >= HEALTH_FAILURE_LIMIT) setOnline(false);
      } finally {
        inFlight = false;
      }
    };
    void check();
    const timer = setInterval(() => void check(), HEALTH_POLL_MS);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [version]);

  return online;
}
