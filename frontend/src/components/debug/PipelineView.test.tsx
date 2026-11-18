import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PipelineView } from './PipelineView';
import type { DebugJob, PipelineStatus } from '../../types/debug';

const status: PipelineStatus = {
  epoch: 2,
  summarized_until_message_id: 12,
  unsummarized_messages: 6,
  pending_jobs: 1,
  running_jobs: 0,
};

const jobs: DebugJob[] = [
  {
    id: 5,
    kind: 'summary',
    start_message_id: 13,
    end_message_id: 18,
    conversation_epoch: 2,
    status: 'pending',
    attempts: 0,
    error: null,
    result: null,
    created_at: '2026-11-08T10:00:00Z',
    updated_at: '2026-11-08T10:00:00Z',
  },
  {
    id: 3,
    kind: 'summary',
    start_message_id: 1,
    end_message_id: 9,
    conversation_epoch: 1,
    status: 'failed',
    attempts: 3,
    error: 'llm_error',
    result: null,
    created_at: '2026-11-08T08:00:00Z',
    updated_at: '2026-11-08T08:10:00Z',
  },
];

describe('PipelineView', () => {
  it('shows the summarized position and the job counts', () => {
    const { container } = render(<PipelineView status={status} jobs={jobs} />);
    const text = container.textContent ?? '';
    expect(text).toContain('要約済みの境界');
    expect(text).toContain('メッセージ #12 まで');
    expect(text).toContain('未要約メッセージ');
    expect(text).toContain('6 件');
    expect(text).toContain('待機中のジョブ');
    expect(text).toContain('待機中');
    expect(text).toContain('失敗');
    expect(text).toContain('llm_error');
    expect(text).not.toContain('未抽出');
  });

  it('handles an empty pipeline', () => {
    const { container } = render(
      <PipelineView
        status={{ ...status, summarized_until_message_id: null, unsummarized_messages: 0 }}
        jobs={[]}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('まだ要約はありません');
    expect(text).toContain('ジョブはまだありません');
  });
});
