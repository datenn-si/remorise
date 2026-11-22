import { categoryLabel, provenanceLabel } from '../../lib/labels';
import { formatDateTime } from '../../lib/format';
import type { Memory } from '../../types/memory';

export function MemoryList({
  memories,
  loading,
  onOpen,
}: {
  memories: Memory[];
  loading: boolean;
  onOpen: (id: number) => void;
}) {
  if (loading && memories.length === 0) {
    return <p className="text-sm text-muted">記憶を読み込んでいます。</p>;
  }
  if (memories.length === 0) {
    return <p className="text-sm text-muted">表示できる記憶はありません。</p>;
  }

  return (
    <ul className="space-y-2">
      {memories.map((memory) => (
        <li key={memory.id}>
          <button
            type="button"
            onClick={() => onOpen(memory.id)}
            className="w-full cursor-pointer rounded-2xl border border-line bg-panel px-4 py-3 text-left hover:border-gold"
          >
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="rounded-full border border-line px-2 py-0.5">
                {categoryLabel(memory.category)}
              </span>
              <span>重要度 {memory.importance}/5</span>
              <span>{memory.status === 'forgotten' || !memory.is_active ? '忘却' : '有効'}</span>
              <span>出自 {provenanceLabel(memory.provenance)}</span>
              {memory.provisional && <span>仮置き</span>}
              <time dateTime={memory.content_updated_at ?? memory.created_at}>
                {formatDateTime(memory.content_updated_at ?? memory.created_at)}
              </time>
            </span>
            <p className="mt-2 line-clamp-3 whitespace-pre-wrap leading-relaxed">
              {memory.content}
            </p>
          </button>
        </li>
      ))}
    </ul>
  );
}
