import { categoryLabel, memorySourceLabel, provenanceLabel } from '../../lib/labels';
import { formatDateTime } from '../../lib/format';
import type { Memory } from '../../types/memory';

/**
 * Read-only detail view of one memory. Memories are written only by
 * the front stage; this view shows the row exactly as stored —
 * category, period or event time, provenance, provisional state,
 * and the lifecycle bookkeeping.
 */
export function MemoryDetail({ memory }: { memory: Memory }) {
  return (
    <div className="space-y-3">
      <p className="whitespace-pre-wrap leading-relaxed">{memory.content}</p>
      <dl className="space-y-1 text-sm">
        <Row term="カテゴリ" value={categoryLabel(memory.category)} />
        <Row
          term="状態"
          value={memory.status === 'forgotten' || !memory.is_active ? '忘却' : '有効'}
        />
        <Row term="重要度" value={`${memory.importance} / 5`} />
        <Row term="出自" value={provenanceLabel(memory.provenance)} />
        {memory.category === 'event' ? (
          <Row term="日時" value={formatDateTime(memory.event_at)} />
        ) : (
          <Row
            term="期間"
            value={`${formatDateTime(memory.period_start)} 〜 ${formatDateTime(memory.period_end)}`}
          />
        )}
        {memory.provisional && <Row term="時期" value="仮置き（時期不明・聞き返し対象）" />}
        <Row term="作成ソース" value={memorySourceLabel(memory.source_type, memory.provenance)} />
        <Row term="作成" value={formatDateTime(memory.created_at)} />
        <Row
          term="内容の更新ソース"
          value={memorySourceLabel(
            memory.content_update_source_type,
            memory.content_update_provenance,
          )}
        />
        <Row term="内容の更新" value={formatDateTime(memory.content_updated_at)} />
        <Row term="最終アクセス" value={formatDateTime(memory.last_accessed_at)} />
        <Row term="最終強化" value={formatDateTime(memory.last_reinforced_at)} />
        <Row term="最終想起" value={formatDateTime(memory.last_recalled_at)} />
        <Row term="想起回数" value={String(memory.reactivation_count)} />
        <Row term="最終復帰" value={formatDateTime(memory.last_restored_at)} />
        <Row term="復帰回数" value={String(memory.restoration_count)} />
      </dl>
      {memory.keywords.length > 0 && (
        <p className="text-sm">
          <span className="text-muted">キーワード </span>
          {memory.keywords.join('、')}
        </p>
      )}
      {memory.specific_terms.length > 0 && (
        <p className="text-sm">
          <span className="text-muted">具体語 </span>
          {memory.specific_terms.join('、')}
        </p>
      )}
    </div>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
      <dt className="text-muted">{term}</dt>
      <dd>{value}</dd>
    </div>
  );
}
