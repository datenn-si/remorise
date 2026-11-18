import { formatDateTime } from '../../lib/format';
import { jobKindLabel, jobStatusLabel } from '../../lib/labels';
import type { DebugJob, PipelineStatus } from '../../types/debug';

export function PipelineView({ status, jobs }: { status: PipelineStatus; jobs: DebugJob[] }) {
  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-base">要約の進み具合</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted">要約済みの境界</dt>
          <dd className="text-ink">
            {status.summarized_until_message_id !== null
              ? `メッセージ #${status.summarized_until_message_id} まで`
              : 'まだ要約はありません'}
          </dd>
          <dt className="text-muted">未要約メッセージ</dt>
          <dd className="text-ink">{status.unsummarized_messages} 件</dd>
          <dt className="text-muted">待機中のジョブ</dt>
          <dd className="text-ink">{status.pending_jobs} 件</dd>
          <dt className="text-muted">実行中のジョブ</dt>
          <dd className="text-ink">{status.running_jobs} 件</dd>
          <dt className="text-muted">会話の世代</dt>
          <dd className="text-ink">{status.epoch}</dd>
        </dl>
        <p className="mt-2 text-xs text-muted">
          ここに表示されるバックグラウンドジョブは要約だけです。
        </p>
      </section>
      <section>
        <h2 className="mb-2 text-base">バックグラウンドジョブ</h2>
        {jobs.length === 0 ? (
          <p className="text-sm text-muted">ジョブはまだありません。</p>
        ) : (
          <ol className="space-y-2">
            {jobs.map((job) => (
              <JobItem key={job.id} job={job} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function JobItem({ job }: { job: DebugJob }) {
  return (
    <li className="rounded-xl border border-line bg-panel/40 px-3 py-2 text-sm">
      <p>
        <span className="text-ink">
          #{job.id} {jobKindLabel(job.kind)}
        </span>
        <span className="ml-2">{jobStatusLabel(job.status)}</span>
      </p>
      <p className="mt-1 text-xs text-muted">
        対象メッセージ #{job.start_message_id} – #{job.end_message_id} ・ 世代{' '}
        {job.conversation_epoch} ・ 試行 {job.attempts} 回 ・ 登録 {formatDateTime(job.created_at)}{' '}
        ・ 更新 {formatDateTime(job.updated_at)}
      </p>
      {job.error ? <p className="mt-1 text-xs text-danger">{job.error}</p> : null}
    </li>
  );
}
