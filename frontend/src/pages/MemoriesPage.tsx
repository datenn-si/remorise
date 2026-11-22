import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MemoryDetail } from '../components/memories/MemoryDetail';
import { MemoryList } from '../components/memories/MemoryList';
import { Banner } from '../components/common/Banner';
import { Modal } from '../components/common/Modal';
import { useMemories } from '../hooks/useMemories';
import { errorText } from '../lib/errors';
import { buttonClass, fieldClass } from '../lib/ui';
import type { Memory, MemoryStatusFilter } from '../types/memory';

/**
 * Memory browsing is read-only: memories are written, edited, and
 * forgotten by the front stage and the decay pass only, so this page
 * offers list, search, and detail display — no editing controls.
 */
export function MemoriesPage() {
  const memories = useMemories();
  const [selected, setSelected] = useState<Memory | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 120) {
      void memories.loadMore();
    }
  };

  // A short page never reaches the scroll threshold, so keep asking
  // for the next page until the list can scroll or there is no more.
  const { hasMore, loading, loadingMore, loadMore } = memories;
  const memoryCount = memories.memories.length;
  useEffect(() => {
    const element = scroller.current;
    if (!element || !hasMore || loading || loadingMore) return;
    if (element.scrollHeight <= element.clientHeight + 1) void loadMore();
  }, [memoryCount, hasMore, loading, loadingMore, loadMore]);

  const openMemory = async (id: number) => {
    try {
      setSelected(await memories.fetchMemory(id));
      setDetailError(null);
    } catch (caught) {
      setDetailError(errorText(caught) || '記憶を読み込めませんでした。');
    }
  };

  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col overflow-hidden px-4">
      <header className="flex flex-wrap items-center gap-3 py-4">
        <Link to="/" className={buttonClass}>
          会話へ戻る
        </Link>
        <h1 className="text-lg">長期記憶</h1>
        <span className="ml-auto text-sm text-muted">閲覧専用</span>
      </header>

      {memories.error && <Banner tone="error" text={memories.error} />}
      {detailError && (
        <Banner tone="error" text={detailError} onDismiss={() => setDetailError(null)} />
      )}

      <form
        className="mb-4 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          scroller.current?.scrollTo?.(0, 0);
          void memories.search(memories.query, memories.status);
        }}
      >
        <label className="min-w-48 flex-1 text-sm">
          <span className="mb-1 block text-muted">検索</span>
          <input
            value={memories.query}
            className={fieldClass}
            onChange={(event) => memories.setQuery(event.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">状態</span>
          <select
            className={`${fieldClass} cursor-pointer`}
            value={memories.status}
            onChange={(event) => {
              scroller.current?.scrollTo?.(0, 0);
              void memories.search(memories.query, event.target.value as MemoryStatusFilter);
            }}
          >
            <option value="all">すべて</option>
            <option value="active">有効</option>
            <option value="forgotten">忘却</option>
          </select>
        </label>
        <button type="submit" className={buttonClass} disabled={memories.loading}>
          検索
        </button>
      </form>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto pb-6 pr-4" onScroll={onScroll}>
        <MemoryList
          memories={memories.memories}
          loading={memories.loading}
          onOpen={(id) => void openMemory(id)}
        />
        {memories.loadingMore && (
          <p className="py-3 text-center text-sm text-muted">記憶を読み込んでいます。</p>
        )}
      </div>

      <Modal open={selected !== null} title="記憶の詳細" onClose={() => setSelected(null)}>
        {selected && <MemoryDetail key={selected.id} memory={selected} />}
      </Modal>
    </div>
  );
}
