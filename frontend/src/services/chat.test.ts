import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiUrl } from './api';
import { parseChatEvent, streamResend, type ChatStreamEvent } from './chat';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streamResend', () => {
  it('posts to the resend endpoint and streams its events', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start\ndata: {"message_id": 7}\n\n'));
        controller.enqueue(encoder.encode('event: token\ndata: {"content": "やあ"}\n\n'));
        controller.enqueue(encoder.encode('event: message_end\ndata: {"message_id": 7}\n\n'));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const events: ChatStreamEvent[] = [];
    await streamResend(new AbortController().signal, (event) => events.push(event));

    expect(fetchMock).toHaveBeenCalledWith(
      apiUrl('/api/chat/resend'),
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
    expect(events).toEqual([
      { type: 'message_start', messageId: 7 },
      { type: 'token', content: 'やあ' },
      { type: 'message_end', messageId: 7 },
    ]);
  });
});

describe('parseChatEvent', () => {
  it('reads token and usage events, and rejects the removed tool events', () => {
    expect(parseChatEvent({ event: 'token', data: '{"content":"こんにちは"}' })).toEqual({
      type: 'token',
      content: 'こんにちは',
    });
    // Reply generation has no tools: tool events are not part of
    // the stream contract and parse as invalid.
    expect(
      parseChatEvent({
        event: 'tool_start',
        data: '{"tool_call_id":"call-1","name":"search_memories"}',
      }),
    ).toEqual({ type: 'invalid' });
    expect(parseChatEvent({ event: 'tool_end', data: '{"tool_call_id":"call-1"}' })).toEqual({
      type: 'invalid',
    });
    expect(
      parseChatEvent({
        event: 'usage',
        data: '{"prompt_tokens":20,"completion_tokens":3,"total_tokens":23}',
      }),
    ).toEqual({ type: 'usage', promptTokens: 20, completionTokens: 3, totalTokens: 23 });
    expect(parseChatEvent({ event: 'token', data: 'not-json' })).toEqual({ type: 'invalid' });
  });

  it('reads character state and terminal events', () => {
    const analysis = {
      emotion: {
        primary: 'happy',
        intensity: 0.8,
        secondary: null,
        secondary_intensity: 0,
        mood: '嬉しい',
      },
      affinity: { delta: 2, reason: '親切な会話' },
    };
    expect(parseChatEvent({ event: 'state_analysis', data: JSON.stringify(analysis) })).toEqual({
      type: 'state_analysis',
      analysis,
    });
    const state = {
      emotion: 'happy',
      intensity: 0.4,
      secondary_emotion: null,
      secondary_intensity: 0,
      mood: '明るい',
      affinity: 55,
      last_emotion_update: '2026-10-31T00:00:00Z',
      updated_at: '2026-10-31T00:00:00Z',
    };
    expect(
      parseChatEvent({
        event: 'character_state',
        data: JSON.stringify(state),
      }),
    ).toMatchObject({ type: 'character_state', state: { emotion: 'happy', affinity: 55 } });
    expect(
      parseChatEvent({
        event: 'character_state',
        data: JSON.stringify({ ...state, intensity: 1.1 }),
      }),
    ).toEqual({ type: 'invalid' });
    expect(parseChatEvent({ event: 'error', data: '{"code":"generation_failed"}' })).toEqual({
      type: 'error',
      code: 'generation_failed',
    });
    expect(parseChatEvent({ event: 'message_end', data: '{"message_id":3}' })).toEqual({
      type: 'message_end',
      messageId: 3,
    });
  });
});
