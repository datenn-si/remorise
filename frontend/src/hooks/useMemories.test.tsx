import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listMemories, searchMemories } from '../services/memories';
import type { Memory } from '../types/memory';
import { useMemories } from './useMemories';

vi.mock('../services/memories', () => ({
  listMemories: vi.fn(),
  searchMemories: vi.fn(),
  getMemory: vi.fn(),
}));

const mockedList = vi.mocked(listMemories);
const mockedSearch = vi.mocked(searchMemories);

function memory(id: number): Memory {
  return {
    id,
    content: `記憶${id}`,
    category: 'state',
    importance: 3,
    status: 'active',
    is_active: true,
    provenance: 'explicit',
    keywords: [],
    specific_terms: [],
    period_start: null,
    period_end: null,
    event_at: null,
    provisional: false,
    source_type: 'conversation',
    source_date: null,
    created_at: '2026-01-01T00:00:00+00:00',
    content_updated_at: null,
    content_update_source_type: null,
    content_update_provenance: null,
    last_accessed_at: null,
    last_recalled_at: null,
    reactivation_count: 0,
    last_restored_at: null,
    restoration_count: 0,
    last_reinforced_at: '2026-01-01T00:00:00+00:00',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useMemories', () => {
  it('appends the next id-desc page and stops when the filter changes', async () => {
    mockedList
      .mockResolvedValueOnce({ memories: [memory(3), memory(2)], has_more: true })
      .mockResolvedValueOnce({ memories: [memory(1)], has_more: false })
      .mockResolvedValue({ memories: [memory(4)], has_more: false });

    const { result } = renderHook(() => useMemories());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.memories.map((row) => row.id)).toEqual([3, 2]);

    await act(async () => {
      await result.current.loadMore();
    });
    expect(mockedList).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'active', beforeId: 2 }),
    );
    expect(result.current.memories.map((row) => row.id)).toEqual([3, 2, 1]);
    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      await result.current.search('', 'all');
    });
    expect(mockedList.mock.lastCall?.[0]).toMatchObject({ status: 'all' });
    expect(mockedList.mock.lastCall?.[0]?.beforeId).toBeUndefined();
    expect(result.current.memories.map((row) => row.id)).toEqual([4]);
  });

  it('searches once in relevance order and does not page that result', async () => {
    mockedList.mockResolvedValue({ memories: [memory(1)], has_more: true });
    mockedSearch.mockResolvedValue([memory(9), memory(4)]);

    const { result } = renderHook(() => useMemories());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const listCalls = mockedList.mock.calls.length;

    await act(async () => {
      await result.current.search('京都', 'forgotten');
    });
    expect(mockedSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: '京都', status: 'forgotten' }),
    );
    expect(result.current.memories.map((row) => row.id)).toEqual([9, 4]);
    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      await result.current.loadMore();
    });
    expect(mockedList).toHaveBeenCalledTimes(listCalls);
    expect(mockedSearch).toHaveBeenCalledTimes(1);
  });
});
