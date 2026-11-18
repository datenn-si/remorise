import type { Memory } from '../types/memory';
import { request } from './api';

/** Memories are read-only from the client (writes happen in the front stage only). */
export function listMemories(
  options: {
    query?: string;
    includeInactive?: boolean;
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<Memory[]> {
  const params = new URLSearchParams();
  const query = options.query?.trim();
  if (query) params.set('query', query);
  if (options.includeInactive) params.set('include_inactive', 'true');
  params.set('limit', String(options.limit ?? 100));
  return request<Memory[]>(`/api/memories?${params.toString()}`, { signal: options.signal });
}

export function getMemory(id: number, signal?: AbortSignal): Promise<Memory> {
  return request<Memory>(`/api/memories/${id}`, { signal });
}
