import type { Memory, MemoryPage, MemoryStatusFilter } from '../types/memory';
import { request } from './api';

const LIST_LIMIT = 50;
// The search engine used to clamp every caller at 50. This passes the
// API's own maximum through, so a search can return that many.
const SEARCH_LIMIT = 100;

/** Memories are read-only from the client (writes happen in the front stage only). */
export function listMemories(
  options: {
    status?: MemoryStatusFilter;
    beforeId?: number;
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<MemoryPage> {
  const params = new URLSearchParams();
  params.set('status', options.status ?? 'active');
  params.set('limit', String(options.limit ?? LIST_LIMIT));
  if (options.beforeId != null) params.set('before_id', String(options.beforeId));
  return request<MemoryPage>(`/api/memories?${params.toString()}`, { signal: options.signal });
}

export function searchMemories(options: {
  query: string;
  status?: MemoryStatusFilter;
  limit?: number;
  signal?: AbortSignal;
}): Promise<Memory[]> {
  const params = new URLSearchParams();
  params.set('query', options.query);
  params.set('status', options.status ?? 'active');
  params.set('limit', String(options.limit ?? SEARCH_LIMIT));
  return request<Memory[]>(`/api/memories/search?${params.toString()}`, { signal: options.signal });
}

export function getMemory(id: number, signal?: AbortSignal): Promise<Memory> {
  return request<Memory>(`/api/memories/${id}`, { signal });
}
