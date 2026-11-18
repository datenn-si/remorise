import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchivePurgePanel } from './ArchivePurgePanel';
import { purgeArchivedHistory } from '../../services/debug';

vi.mock('../../services/debug', () => ({
  purgeArchivedHistory: vi.fn(),
}));

const mockedPurge = vi.mocked(purgeArchivedHistory);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ArchivePurgePanel', () => {
  it('purges only after a cutoff is entered and confirmed', async () => {
    mockedPurge.mockResolvedValue({ purged_messages: 3, purged_summaries: 1 });
    render(<ArchivePurgePanel />);

    const run = screen.getByRole('button', { name: 'ここ以前を削除' }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('基準点（メッセージ ID）'), {
      target: { value: '5' },
    });
    expect(run.disabled).toBe(false);
    fireEvent.click(run);
    expect(mockedPurge).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '本当に削除する' }));
    await waitFor(() => expect(mockedPurge).toHaveBeenCalledWith(5));
    expect(await screen.findByText(/メッセージ 3 件、要約 1 件を物理削除しました/)).toBeTruthy();
  });

  it('can back out of the confirm step without calling the purge', () => {
    render(<ArchivePurgePanel />);
    fireEvent.change(screen.getByLabelText('基準点（メッセージ ID）'), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ここ以前を削除' }));
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(mockedPurge).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'ここ以前を削除' })).toBeTruthy();
  });
});
