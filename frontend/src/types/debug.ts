/**
 * Debug-mode reads. The debug API is read-only apart from the
 * archived-history purge: jobs are summary jobs only (memory work
 * happens in the front stage now), and a job's `result` is always
 * null.
 */
export type DebugJob = {
  id: number;
  kind: 'summary';
  start_message_id: number;
  end_message_id: number;
  conversation_epoch: number;
  status: string;
  attempts: number;
  error: string | null;
  result: null;
  created_at: string;
  updated_at: string;
};

/** A summary row from `GET /api/debug/history` (body text included). */
export type DebugSummary = {
  id: number;
  content: string;
  start_message_id: number;
  end_message_id: number;
  active: boolean;
  archived: boolean;
  created_at: string;
};

export type PipelineStatus = {
  epoch: number;
  summarized_until_message_id: number | null;
  unsummarized_messages: number;
  pending_jobs: number;
  running_jobs: number;
};
