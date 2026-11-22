import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '../lib/errors';
import { getMemory, listMemories, searchMemories } from '../services/memories';
import type { Memory, MemoryStatusFilter } from '../types/memory';

/** Read-only memory browsing: an id-desc list, or one relevance search. */
export function useMemories() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<MemoryStatusFilter>('active');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A reload from the start bumps this immediately, before React
  // re-renders, so a page already in flight cannot append onto the
  // new query or filter.
  const generation = useRef(0);
  const appliedQuery = useRef('');
  const reloading = useRef(false);
  const loadingMoreRef = useRef(false);

  const reload = useCallback(
    async (nextQuery: string, nextStatus: MemoryStatusFilter, signal?: AbortSignal) => {
      const ticket = ++generation.current;
      const trimmed = nextQuery.trim();
      appliedQuery.current = trimmed;
      reloading.current = true;
      loadingMoreRef.current = false;
      setStatus(nextStatus);
      setMemories([]);
      setHasMore(false);
      setLoadingMore(false);
      setLoading(true);
      try {
        if (trimmed) {
          const list = await searchMemories({ query: trimmed, status: nextStatus, signal });
          if (signal?.aborted || ticket !== generation.current) return;
          setMemories(list);
          setHasMore(false);
        } else {
          const page = await listMemories({ status: nextStatus, signal });
          if (signal?.aborted || ticket !== generation.current) return;
          setMemories(page.memories);
          setHasMore(page.has_more);
        }
        setError(null);
      } catch (caught) {
        if (signal?.aborted || ticket !== generation.current) return;
        const text = errorText(caught);
        if (text) setError(text);
      } finally {
        if (!signal?.aborted && ticket === generation.current) {
          reloading.current = false;
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    const abort = new AbortController();
    void reload('', 'active', abort.signal);
    return () => abort.abort();
  }, [reload]);

  const search = useCallback(
    (nextQuery: string, nextStatus: MemoryStatusFilter) => reload(nextQuery, nextStatus),
    [reload],
  );

  const loadMore = useCallback(async () => {
    if (
      reloading.current ||
      appliedQuery.current ||
      loadingMoreRef.current ||
      !hasMore ||
      loading
    ) {
      return;
    }
    const beforeId = memories.at(-1)?.id;
    if (beforeId == null) return;
    const ticket = generation.current;
    const nextStatus = status;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await listMemories({ status: nextStatus, beforeId });
      if (ticket !== generation.current) return;
      setMemories((current) => {
        const known = new Set(current.map((row) => row.id));
        return [...current, ...page.memories.filter((row) => !known.has(row.id))];
      });
      setHasMore(page.has_more);
      setError(null);
    } catch (caught) {
      if (ticket !== generation.current) return;
      const text = errorText(caught);
      if (text) setError(text);
    } finally {
      if (ticket === generation.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [hasMore, loading, memories, status]);

  return {
    memories,
    query,
    setQuery,
    status,
    loading,
    loadingMore,
    hasMore,
    error,
    search,
    loadMore,
    fetchMemory: getMemory,
  };
}
