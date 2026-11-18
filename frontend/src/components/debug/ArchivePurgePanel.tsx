import { useState } from 'react';
import { errorText } from '../../lib/errors';
import { buttonClass, dangerButtonClass, fieldClass } from '../../lib/ui';
import { purgeArchivedHistory, type PurgeResult } from '../../services/debug';

/**
 * Manual purge of archived history, as a prefix cut: the operator
 * names a cutoff message id and only invalidated rows at or before
 * it are physically deleted (archived messages with id <= cutoff,
 * archived summaries whose covered range ends at or before it).
 * Active content is never touched, and there is no way to pick a
 * single item — this panel is the only manual purge surface, and it
 * lives on a debug-gated page.
 */
export function ArchivePurgePanel() {
  const [cutoff, setCutoff] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PurgeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = Number(cutoff);
  const valid = cutoff.trim() !== '' && Number.isInteger(parsed) && parsed >= 1;

  const run = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await purgeArchivedHistory(parsed);
      setResult(outcome);
      setConfirming(false);
    } catch (caught) {
      setError(errorText(caught) || '物理削除に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2 className="mb-2 text-base">アーカイブの物理削除</h2>
      <p className="text-sm text-muted">
        無効化済み（アーカイブ）の履歴だけを、基準点以前について物理削除します。指定したメッセージ
        ID 以前の無効化済みメッセージと、対象範囲がその ID 以前で終わる無効化済み要約が対象です。
        有効なものは基準点以前でも削除されません。個別の削除はできません。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="text-sm text-muted" htmlFor="purge-cutoff">
          基準点（メッセージ ID）
        </label>
        <input
          id="purge-cutoff"
          type="number"
          min={1}
          step={1}
          className={`${fieldClass} w-32`}
          value={cutoff}
          disabled={busy}
          onChange={(event) => {
            setCutoff(event.target.value);
            setConfirming(false);
            setResult(null);
          }}
        />
        {confirming ? (
          <>
            <button
              type="button"
              className={dangerButtonClass}
              disabled={busy}
              onClick={() => void run()}
            >
              本当に削除する
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              やめる
            </button>
          </>
        ) : (
          <button
            type="button"
            className={buttonClass}
            disabled={!valid || busy}
            onClick={() => setConfirming(true)}
          >
            ここ以前を削除
          </button>
        )}
      </div>
      {result ? (
        <p className="mt-2 text-sm text-ink">
          メッセージ {result.purged_messages} 件、要約 {result.purged_summaries}{' '}
          件を物理削除しました。
        </p>
      ) : null}
      {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
    </section>
  );
}
