import { useCallback, useEffect, useState } from 'react';
import { errorText } from '../lib/errors';
import { getMemory, listMemories } from '../services/memories';
import type { Memory } from '../types/memory';

/** Read-only memory browsing: list, search, and detail fetches only. */
export function useMemories() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [query, setQuery] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextQuery: string, inactive: boolean, signal?: AbortSignal) => {
    try {
      const list = await listMemories({
        query: nextQuery,
        includeInactive: inactive,
        signal,
      });
      if (signal?.aborted) return;
      setMemories(list);
      setError(null);
    } catch (caught) {
      if (signal?.aborted) return;
      const text = errorText(caught);
      if (text) setError(text);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void load('', false, abort.signal);
    return () => abort.abort();
  }, [load]);

  const search = useCallback(
    (nextQuery: string, inactive: boolean) => {
      setLoading(true);
      return load(nextQuery, inactive);
    },
    [load],
  );

  return {
    memories,
    query,
    setQuery,
    includeInactive,
    setIncludeInactive,
    loading,
    error,
    search,
    fetchMemory: getMemory,
  };
}
