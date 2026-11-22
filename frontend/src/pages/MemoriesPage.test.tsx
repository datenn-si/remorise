import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoriesPage } from './MemoriesPage';
import { getMemory, listMemories, searchMemories } from '../services/memories';
import type { Memory } from '../types/memory';

vi.mock('../services/memories', () => ({
  listMemories: vi.fn(),
  searchMemories: vi.fn(),
  getMemory: vi.fn(),
}));

// jsdom's <dialog> cannot really open modally; track openness only,
// which is all the visibility assertions below rely on.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
});

const mockedList = vi.mocked(listMemories);
const mockedSearch = vi.mocked(searchMemories);
const mockedGet = vi.mocked(getMemory);

const STATE_MEMORY: Memory = {
  id: 5,
  content: 'ユーザーは京都に住んでいる',
  category: 'state',
  importance: 3,
  status: 'active',
  is_active: true,
  provenance: 'explicit',
  keywords: ['京都'],
  specific_terms: ['京都市'],
  period_start: '2026-01-01T00:00:00+00:00',
  period_end: null,
  event_at: null,
  provisional: false,
  source_type: 'conversation',
  source_date: null,
  created_at: '2026-01-01T00:00:00+00:00',
  content_updated_at: '2026-01-01T00:00:00+00:00',
  content_update_source_type: 'conversation',
  content_update_provenance: 'explicit',
  last_accessed_at: null,
  last_recalled_at: null,
  reactivation_count: 0,
  last_restored_at: null,
  restoration_count: 0,
  last_reinforced_at: '2026-01-01T00:00:00+00:00',
};

function renderPage() {
  return render(
    <MemoryRouter>
      <MemoriesPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockedList.mockResolvedValue({ memories: [STATE_MEMORY], has_more: false });
  mockedSearch.mockResolvedValue([STATE_MEMORY]);
  mockedGet.mockResolvedValue(STATE_MEMORY);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MemoriesPage (read-only)', () => {
  it('shows the period, provenance, and terms in the detail view', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /京都に住んでいる/ }));

    expect(await screen.findByText('記憶の詳細')).toBeTruthy();
    expect(screen.getAllByText('状態').length).toBeGreaterThan(0);
    expect(screen.getByText('明示')).toBeTruthy();
    expect(screen.getByText(/京都市/)).toBeTruthy();
    expect(screen.getByText(/期間/)).toBeTruthy();
  });

  it('offers no editing, creation, or forgetting controls', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /京都に住んでいる/ }));
    await screen.findByText('記憶の詳細');

    expect(screen.queryByRole('button', { name: '保存する' })).toBeNull();
    expect(screen.queryByRole('button', { name: '削除する' })).toBeNull();
    expect(screen.queryByRole('button', { name: '追加する' })).toBeNull();
    expect(screen.queryByText('記憶を追加')).toBeNull();
    expect(document.querySelector('textarea')).toBeNull();
    expect(screen.queryByText('忘却した記憶も表示')).toBeNull();
  });

  it('reloads from the start when the filter or the query changes', async () => {
    renderPage();
    await screen.findByRole('button', { name: /京都に住んでいる/ });

    fireEvent.change(screen.getByLabelText('状態'), { target: { value: 'forgotten' } });
    await waitFor(() => {
      expect(mockedList).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'forgotten' }));
    });
    expect(mockedList.mock.lastCall?.[0]?.beforeId).toBeUndefined();

    fireEvent.change(screen.getByLabelText('検索'), { target: { value: '京都' } });
    fireEvent.click(screen.getByRole('button', { name: '検索' }));
    await waitFor(() => {
      expect(mockedSearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: '京都', status: 'forgotten' }),
      );
    });
  });
});
