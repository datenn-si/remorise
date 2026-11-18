import { describe, expect, it } from 'vitest';
import { buildTimeline } from './timeline';
import type { DisplayMessage, FrontStageDebug, StateAnalysis } from '../types/chat';
import type { DebugJob, DebugSummary } from '../types/debug';

const analysis: StateAnalysis = {
  emotion: {
    primary: 'happy',
    intensity: 0.8,
    secondary: null,
    secondary_intensity: 0,
    mood: '嬉しい',
  },
  affinity: { delta: 2, reason: '親切な会話' },
};

const frontRecord: FrontStageDebug = { ...analysis, keywords: ['記録側'], reminds: false };

function user(overrides: Partial<DisplayMessage>): DisplayMessage {
  return {
    id: 'msg-1',
    role: 'user',
    content: 'こんにちは',
    createdAt: '2026-11-09T00:00:00Z',
    ...overrides,
  };
}

function assistant(overrides: Partial<DisplayMessage>): DisplayMessage {
  return {
    id: 'msg-2',
    role: 'assistant',
    content: 'やあ',
    createdAt: '2026-11-09T00:00:10Z',
    ...overrides,
  };
}

function summaryRow(overrides: Partial<DebugSummary>): DebugSummary {
  return {
    id: 3,
    content: '要約の本文',
    start_message_id: 1,
    end_message_id: 2,
    active: true,
    archived: false,
    created_at: '2026-11-09T00:00:09Z',
    ...overrides,
  };
}

function job(overrides: Partial<DebugJob>): DebugJob {
  return {
    id: 5,
    kind: 'summary',
    start_message_id: 1,
    end_message_id: 2,
    conversation_epoch: 1,
    status: 'done',
    attempts: 1,
    error: null,
    result: null,
    created_at: '2026-11-09T00:00:11Z',
    updated_at: '2026-11-09T00:00:20Z',
    ...overrides,
  };
}

function types(entries: ReturnType<typeof buildTimeline>): string[] {
  return entries.map((entry) => entry.type);
}

describe('buildTimeline', () => {
  it('orders a turn as user, front-stage block, reply, pipeline block', () => {
    const entries = buildTimeline(
      [
        user({}),
        assistant({
          stateAnalysis: analysis,
          memorySearch: {
            searches: [{ terms: ['京都'], pointing: false, result: 'no_hit' }],
            disclosed: [],
            recalled_ids: [],
            restored_ids: [],
            created_ids: [],
            notification_terms: [],
            ask_back_ids: [],
          },
          summary: { id: 3, start_message_id: 1, end_message_id: 2 },
        }),
      ],
      [job({})],
      [summaryRow({})],
    );
    // The turn runs user, front-stage block, reply, pipeline block;
    // the summary itself stands right after its covered range, which
    // ends at this reply — so after the turn's pipeline block.
    expect(types(entries)).toEqual(['message', 'front', 'message', 'pipeline', 'summary']);
    const placed = entries[4];
    expect(placed?.type === 'summary' && placed.summary.content).toBe('要約の本文');
    expect(placed?.type === 'summary' && placed.summary.created_at).toBe('2026-11-09T00:00:09Z');
    const front = entries[1];
    expect(front?.type === 'front' && front.block.keywords).toEqual(['京都']);
    expect(front?.type === 'front' && front.block.analysis).toEqual(analysis);
    const pipeline = entries[3];
    expect(pipeline?.type === 'pipeline' && pipeline.items.map((item) => item.type)).toEqual([
      'summary',
      'job_registered',
      'job_finished',
    ]);
    const created = pipeline?.type === 'pipeline' && pipeline.items[0];
    expect(created && created.type === 'summary' && created.summary.created_at).toBe(
      '2026-11-09T00:00:09Z',
    );
  });

  it('places summaries after their covered range, superseded ones included', () => {
    const entries = buildTimeline(
      [user({}), assistant({ summary: { id: 8, start_message_id: 5, end_message_id: 6 } })],
      [],
      [
        summaryRow({ id: 9, start_message_id: 7, end_message_id: 9, content: '新しい要約' }),
        summaryRow({ id: 4, start_message_id: 1, end_message_id: 4, content: '古い要約' }),
        summaryRow({ id: 6, start_message_id: 2, end_message_id: 3, active: false }),
      ],
    );
    // Only messages 1-2 are loaded, so every range ends at or before
    // the reply: all summaries land after the turn, ordered by the
    // end of their covered range.
    const placed = entries.filter((entry) => entry.type === 'summary');
    expect(placed.map((entry) => entry.type === 'summary' && entry.summary.id)).toEqual([
      6, 4, 8, 9,
    ]);
    // A summary known only from its metadata record is placed too,
    // with its body unavailable.
    const fromRecord = placed[2];
    expect(fromRecord?.type === 'summary' && fromRecord.summary.content).toBeNull();
    // The superseded summary stands as well, carrying its state.
    const superseded = placed[0];
    expect(superseded?.type === 'summary' && superseded.summary.active).toBe(false);
    expect(superseded?.type === 'summary' && superseded.summary.archived).toBe(false);
  });

  it('places a summary mid-conversation at the end of its range', () => {
    const entries = buildTimeline(
      [
        user({ id: 'msg-1' }),
        assistant({ id: 'msg-2' }),
        user({ id: 'msg-3', content: '次の質問' }),
        assistant({ id: 'msg-4', content: '次の返答' }),
      ],
      [],
      [summaryRow({ id: 5, start_message_id: 1, end_message_id: 2 })],
    );
    expect(types(entries)).toEqual(['message', 'message', 'summary', 'message', 'message']);
  });

  it('places a summary before the loaded messages when its range is not loaded', () => {
    // The range sits in an older page that has not been fetched:
    // the summary goes just before the oldest loaded message newer
    // than the range.
    const entries = buildTimeline(
      [user({ id: 'msg-10' }), assistant({ id: 'msg-11' })],
      [],
      [summaryRow({ id: 5, start_message_id: 1, end_message_id: 4 })],
    );
    expect(types(entries)).toEqual(['summary', 'message', 'message']);
  });

  it('marks an invalidated summary with its state', () => {
    const entries = buildTimeline(
      [user({}), assistant({})],
      [],
      [summaryRow({ id: 5, active: false, archived: true })],
    );
    const placed = entries.find((entry) => entry.type === 'summary');
    expect(placed?.type === 'summary' && placed.summary.archived).toBe(true);
    expect(placed?.type === 'summary' && placed.summary.active).toBe(false);
  });

  it('shows no pipeline block for a turn where nothing ran', () => {
    const entries = buildTimeline([user({}), assistant({ stateAnalysis: analysis })], []);
    expect(types(entries)).toEqual(['message', 'front', 'message']);
  });

  it('emits the front stage once, from the assistant record, when both sides have one', () => {
    const entries = buildTimeline(
      [
        user({ frontStage: frontRecord }),
        assistant({
          stateAnalysis: analysis,
          memorySearch: {
            searches: [{ terms: ['応答側'], pointing: false, result: 'no_hit' }],
            disclosed: [],
            recalled_ids: [],
            restored_ids: [],
            created_ids: [],
            notification_terms: [],
            ask_back_ids: [],
          },
        }),
      ],
      [],
    );
    const fronts = entries.filter((entry) => entry.type === 'front');
    expect(fronts).toHaveLength(1);
    expect(fronts[0]?.type === 'front' && fronts[0].block.keywords).toEqual(['応答側']);
  });

  it('surfaces the front stage from the user record for a dangling turn', () => {
    const entries = buildTimeline([user({ dangling: true, frontStage: frontRecord })], []);
    expect(types(entries)).toEqual(['message', 'front']);
    const front = entries[1];
    expect(front?.type === 'front' && front.block.analysis).toEqual(frontRecord);
    expect(front?.type === 'front' && front.block.keywords).toEqual(['記録側']);
    expect(front?.type === 'front' && front.block.search).toBeNull();
  });

  it('keeps a job whole in the block of the turn that was current at registration', () => {
    // Registered mid-turn (before the reply was saved), finished later:
    // both halves land in that turn's pipeline block, after the reply.
    const entries = buildTimeline(
      [user({}), assistant({})],
      [job({ created_at: '2026-11-09T00:00:05Z', updated_at: '2026-11-09T00:00:30Z' })],
    );
    expect(types(entries)).toEqual(['message', 'message', 'pipeline']);
    const pipeline = entries[2];
    expect(pipeline?.type === 'pipeline' && pipeline.items.map((item) => item.type)).toEqual([
      'job_registered',
      'job_finished',
    ]);
  });

  it('places jobs not tied to a turn at their time position', () => {
    // Before the visible history: a leading pipeline block.
    const early = buildTimeline(
      [user({}), assistant({})],
      [job({ id: 1, created_at: '2026-11-08T23:00:00Z', updated_at: '2026-11-08T23:01:00Z' })],
    );
    expect(types(early)).toEqual(['pipeline', 'message', 'message']);

    // An idle flush long after a dangling user message: a block right
    // after that message, not attached to any reply.
    const flushed = buildTimeline(
      [user({ dangling: true })],
      [job({ id: 9, created_at: '2026-11-09T00:30:00Z', updated_at: '2026-11-09T00:30:05Z' })],
    );
    expect(types(flushed)).toEqual(['message', 'pipeline']);
  });

  it('shows only the registration for a job that has not finished', () => {
    const entries = buildTimeline(
      [user({}), assistant({})],
      [job({ status: 'pending', result: null })],
    );
    const pipeline = entries.find((entry) => entry.type === 'pipeline');
    expect(pipeline?.type === 'pipeline' && pipeline.items.map((item) => item.type)).toEqual([
      'job_registered',
    ]);
  });
});
