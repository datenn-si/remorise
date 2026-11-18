import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArchivePurgePanel } from '../components/debug/ArchivePurgePanel';
import { PipelineView } from '../components/debug/PipelineView';
import { Banner } from '../components/common/Banner';
import { getPipelineStatus, listDebugJobs } from '../services/debug';
import { errorText } from '../lib/errors';
import { buttonClass } from '../lib/ui';
import type { DebugJob, PipelineStatus } from '../types/debug';

export function PipelinePage() {
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [jobs, setJobs] = useState<DebugJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextStatus, nextJobs] = await Promise.all([getPipelineStatus(), listDebugJobs()]);
      setStatus(nextStatus);
      setJobs(nextJobs);
      setError(null);
    } catch (caught) {
      setError(errorText(caught) || 'パイプラインの状態を読み込めませんでした。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    document.title = 'パイプライン — Remorise';
  }, []);

  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col overflow-hidden px-4">
      <header className="flex flex-wrap items-center gap-3 py-4">
        <Link to="/" className={buttonClass}>
          会話へ戻る
        </Link>
        <h1 className="text-lg">パイプライン</h1>
        <button
          type="button"
          className={`${buttonClass} ml-auto`}
          disabled={loading}
          onClick={() => void load()}
        >
          更新
        </button>
      </header>

      {error && <Banner tone="error" text={error} onDismiss={() => setError(null)} />}

      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        {loading && !status ? (
          <p className="text-sm text-muted">パイプラインの状態を読み込んでいます。</p>
        ) : null}
        {status ? <PipelineView status={status} jobs={jobs} /> : null}
        <div className="mt-8 border-t border-line pt-6">
          <ArchivePurgePanel />
        </div>
      </div>
    </div>
  );
}
