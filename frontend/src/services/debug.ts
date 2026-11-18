import type { DebugJob, DebugSummary, PipelineStatus } from '../types/debug';
import { request } from './api';

/**
 * Debug-mode reads. Apart from the archived-history purge at the
 * bottom, nothing here writes: the debug API is read-only.
 */
export function listDebugJobs(limit = 50, signal?: AbortSignal): Promise<DebugJob[]> {
  return request<DebugJob[]>(`/api/debug/jobs?limit=${limit}`, { signal });
}

export function getDebugSummaries(signal?: AbortSignal): Promise<DebugSummary[]> {
  return request<{ summaries: DebugSummary[] }>('/api/debug/history', { signal }).then(
    (response) => response.summaries,
  );
}

export function getPipelineStatus(signal?: AbortSignal): Promise<PipelineStatus> {
  return request<PipelineStatus>('/api/debug/pipeline', { signal });
}

export type PurgeResult = {
  purged_messages: number;
  purged_summaries: number;
};

/**
 * Physically delete archived history up to a cutoff message id
 * (a prefix cut; the backend refuses anything else). This is the
 * one write the debug API allows.
 */
export function purgeArchivedHistory(throughMessageId: number): Promise<PurgeResult> {
  return request<PurgeResult>(`/api/debug/history/purge?through_message_id=${throughMessageId}`, {
    method: 'DELETE',
  });
}
