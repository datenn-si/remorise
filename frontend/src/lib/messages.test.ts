import { describe, expect, it } from 'vitest';
import { toDisplayMessages } from './messages';
import type { HistoryMessage } from '../types/chat';

const frontStageRecord = {
  keywords: ['京都'],
  reminds: false,
  emotion: {
    primary: 'happy',
    intensity: 0.8,
    secondary: null,
    secondary_intensity: 0,
    mood: '嬉しい',
  },
  affinity: { delta: 2, reason: '親切な会話' },
};

function message(overrides: Partial<HistoryMessage>): HistoryMessage {
  return {
    id: 1,
    role: 'user',
    content: 'hello',
    tool_calls: null,
    tool_call_id: null,
    metadata: null,
    created_at: '2026-10-31T00:00:00Z',
    ...overrides,
  };
}

describe('toDisplayMessages', () => {
  it('hides tool traffic and empty tool-only replies', () => {
    const visible = toDisplayMessages([
      message({ id: 1, role: 'user', content: '旅行の話' }),
      message({
        id: 2,
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call-1', function: { name: 'search_memories', arguments: '{"query":"旅行"}' } },
        ],
      }),
      message({ id: 3, role: 'tool', content: '{"query":"旅行"}', tool_call_id: 'call-1' }),
      message({
        id: 4,
        role: 'assistant',
        content: '覚えてるよ',
        tool_calls: [{ id: 'call-1' }],
        metadata: { note: 'visible' },
      }),
    ]);
    expect(visible.map((item) => item.content)).toEqual(['旅行の話', '覚えてるよ']);
    expect(visible[1]?.metadata).toEqual({ note: 'visible' });
    expect(visible[1]?.tools).toEqual([
      {
        id: 'call-1',
        name: 'search_memories',
        arguments: '{"query":"旅行"}',
        result: '{"query":"旅行"}',
      },
    ]);
    expect(visible.map((item) => item.content).join('\n')).not.toContain('search_memories');
  });

  it('extracts validated state analysis from assistant history metadata', () => {
    const visible = toDisplayMessages([
      message({
        role: 'assistant',
        content: 'こんにちは',
        metadata: {
          state_analysis: {
            emotion: {
              primary: 'happy',
              intensity: 0.8,
              secondary: null,
              secondary_intensity: 0,
              mood: '嬉しい',
            },
            affinity: { delta: 2, reason: '親切な会話' },
          },
        },
      }),
    ]);

    expect(visible[0]?.stateAnalysis?.affinity).toEqual({ delta: 2, reason: '親切な会話' });
  });

  it('marks the last user message as dangling when no reply follows it', () => {
    const visible = toDisplayMessages([
      message({ id: 1, role: 'user', content: '質問' }),
      message({ id: 2, role: 'assistant', content: '回答' }),
      message({ id: 3, role: 'user', content: '次の質問' }),
    ]);
    expect(visible[1]?.dangling).toBeUndefined();
    expect(visible[2]?.dangling).toBe(true);
  });

  it('treats a tool-call tail as unanswered but an empty saved reply as answered', () => {
    const withTools = toDisplayMessages([
      message({ id: 1, role: 'user', content: '今何時？' }),
      message({ id: 2, role: 'assistant', content: '', tool_calls: [{ id: 'call-1' }] }),
      message({ id: 3, role: 'tool', content: '12:00', tool_call_id: 'call-1' }),
    ]);
    expect(withTools).toHaveLength(1);
    expect(withTools[0]?.dangling).toBe(true);

    const emptyReply = toDisplayMessages([
      message({ id: 1, role: 'user', content: '質問' }),
      message({ id: 2, role: 'assistant', content: '' }),
    ]);
    expect(emptyReply).toHaveLength(1);
    expect(emptyReply[0]?.dangling).toBeUndefined();
  });

  it('extracts the front-stage record from user history metadata', () => {
    const visible = toDisplayMessages([
      message({
        id: 1,
        role: 'user',
        content: '質問',
        metadata: { front_stage: frontStageRecord },
      }),
      message({
        id: 2,
        role: 'user',
        content: '壊れた記録',
        metadata: { front_stage: { keywords: '京都' } },
      }),
    ]);
    expect(visible[0]?.frontStage?.keywords).toEqual(['京都']);
    expect(visible[0]?.frontStage?.affinity.delta).toBe(2);
    expect(visible[1]?.frontStage).toBeUndefined();
  });

  it('extracts the pipeline records from assistant history metadata', () => {
    const visible = toDisplayMessages([
      message({
        role: 'assistant',
        content: '覚えてるよ',
        metadata: {
          memory_search: {
            searches: [{ terms: ['京都', '旅行'], pointing: false, result: 'hit' }],
            disclosed: [{ id: 7, content: 'ユーザーは京都旅行を計画している', delivery: 'hit' }],
            recalled_ids: [],
            restored_ids: [],
            created_ids: [],
            notification_terms: [],
            ask_back_ids: [],
          },
          summary: { id: 3, start_message_id: 1, end_message_id: 9 },
        },
      }),
      message({
        id: 2,
        role: 'assistant',
        content: '壊れたメタデータ',
        metadata: { memory_search: { keywords: '京都' }, summary: { id: 'x' } },
      }),
    ]);

    expect(visible[0]?.memorySearch?.searches[0]?.terms).toEqual(['京都', '旅行']);
    expect(visible[0]?.memorySearch?.disclosed[0]?.id).toBe(7);
    expect(visible[0]?.summary).toEqual({ id: 3, start_message_id: 1, end_message_id: 9 });
    expect(visible[1]?.memorySearch).toBeUndefined();
    expect(visible[1]?.summary).toBeUndefined();
  });

  it('marks archived rows and never leaves an archived turn dangling', () => {
    const visible = toDisplayMessages([
      message({ id: 1, role: 'user', content: '古い質問', archived: true }),
      message({ id: 2, role: 'assistant', content: '古い返答', archived: true }),
      message({ id: 3, role: 'user', content: '無効化された質問', archived: true }),
    ]);
    // All three rows render (debug loads include them), marked as
    // archived; the unanswered archived user message at the tail is
    // not dangling — it is out of the conversation, not awaiting a
    // reply, and must not offer a resend.
    expect(visible.map((row) => row.archived)).toEqual([true, true, true]);
    expect(visible.every((row) => row.dangling === undefined)).toBe(true);
  });

  it('judges dangling on the active tail even with archived rows loaded', () => {
    const visible = toDisplayMessages([
      message({ id: 1, role: 'user', content: '昔の質問', archived: true }),
      message({ id: 2, role: 'user', content: '答えのない質問' }),
    ]);
    expect(visible[1]?.dangling).toBe(true);
    expect(visible[0]?.dangling).toBeUndefined();
  });
});
