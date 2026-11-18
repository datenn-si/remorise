import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChat } from './useChat';
import { getHistory, streamChat, streamResend, type ChatStreamEvent } from '../services/chat';
import type { HistoryResponse } from '../types/chat';

vi.mock('../services/chat', () => ({
  getHistory: vi.fn(),
  streamChat: vi.fn(),
  streamResend: vi.fn(),
}));

const mockedGetHistory = vi.mocked(getHistory);
const mockedStreamChat = vi.mocked(streamChat);
const mockedStreamResend = vi.mocked(streamResend);

type Emit = (event: ChatStreamEvent) => void;

function controlledStream() {
  let emitFn: Emit | null = null;
  let endFn: (() => void) | null = null;
  const impl = (onEvent: Emit) => {
    emitFn = onEvent;
    return new Promise<void>((resolve) => {
      endFn = resolve;
    });
  };
  return {
    impl,
    emit(event: ChatStreamEvent) {
      emitFn?.(event);
    },
    end() {
      endFn?.();
    },
  };
}

const emptyHistory: HistoryResponse = { messages: [], has_more: false };

function historyMessage(id: number, role: string, content: string) {
  return {
    id,
    role,
    content,
    tool_calls: null,
    tool_call_id: null,
    metadata: null,
    created_at: '2026-11-09T00:00:00Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetHistory.mockResolvedValue(emptyHistory);
});

describe('useChat turn failures', () => {
  it('keeps the turn dangling and restores nothing when generation fails', async () => {
    const stream = controlledStream();
    mockedStreamChat.mockImplementation((_message, _signal, onEvent) => stream.impl(onEvent));
    const onTextRestore = vi.fn();
    const { result } = renderHook(() => useChat(vi.fn(), onTextRestore));
    await act(async () => {});

    let sendPromise!: Promise<string>;
    act(() => {
      sendPromise = result.current.send('こんにちは');
    });
    await act(async () => {});
    expect(result.current.messages.map((message) => message.content)).toEqual(['こんにちは']);
    expect(result.current.phase).not.toBe('idle');

    act(() => {
      stream.emit({ type: 'error', code: 'generation_failed' });
      stream.end();
    });
    await act(async () => {
      await sendPromise;
    });

    expect(result.current.phase).toBe('idle');
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      role: 'user',
      content: 'こんにちは',
      dangling: true,
    });
    expect(result.current.banner).toEqual({ tone: 'error', text: '応答の生成に失敗しました。' });
    expect(onTextRestore).not.toHaveBeenCalled();
  });

  it('keeps a reply that completed normally, without a banner', async () => {
    const exchange: HistoryResponse = {
      messages: [historyMessage(1, 'user', 'こんにちは'), historyMessage(2, 'assistant', 'やあ')],
      has_more: false,
    };
    mockedGetHistory.mockResolvedValueOnce(emptyHistory).mockResolvedValue(exchange);
    const stream = controlledStream();
    mockedStreamChat.mockImplementation((_message, _signal, onEvent) => stream.impl(onEvent));
    const onTextRestore = vi.fn();
    const { result } = renderHook(() => useChat(vi.fn(), onTextRestore));
    await act(async () => {});

    let sendPromise!: Promise<string>;
    act(() => {
      sendPromise = result.current.send('こんにちは');
    });
    await act(async () => {});

    act(() => {
      stream.emit({ type: 'token', content: 'やあ' });
      stream.emit({ type: 'message_end', messageId: 2 });
      stream.end();
    });
    await act(async () => {
      await sendPromise;
    });

    expect(result.current.messages.map((message) => message.content)).toEqual([
      'こんにちは',
      'やあ',
    ]);
    expect(result.current.banner).toBeNull();
    expect(onTextRestore).not.toHaveBeenCalled();
  });

  it('keeps a resent turn dangling when its generation fails', async () => {
    mockedGetHistory.mockResolvedValue({
      messages: [historyMessage(1, 'user', '前の文')],
      has_more: false,
    });
    const stream = controlledStream();
    mockedStreamResend.mockImplementation((_signal, onEvent) => stream.impl(onEvent));
    const onTextRestore = vi.fn();
    const { result } = renderHook(() => useChat(vi.fn(), onTextRestore));
    await act(async () => {});
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      id: 'msg-1',
      role: 'user',
      content: '前の文',
      dangling: true,
    });

    let resendPromise!: Promise<void>;
    act(() => {
      resendPromise = result.current.resend('msg-1');
    });
    await act(async () => {});

    act(() => {
      stream.emit({ type: 'error', code: 'generation_failed' });
      stream.end();
    });
    await act(async () => {
      await resendPromise;
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({ content: '前の文', dangling: true });
    expect(result.current.banner).toEqual({ tone: 'error', text: '応答の生成に失敗しました。' });
    expect(onTextRestore).not.toHaveBeenCalled();
  });

  it('loads older pages on demand and prepends them', async () => {
    mockedGetHistory
      .mockResolvedValueOnce({
        messages: [historyMessage(3, 'user', '三つ目'), historyMessage(4, 'assistant', '四つ目')],
        has_more: true,
      })
      .mockResolvedValueOnce({
        messages: [historyMessage(1, 'user', '一つ目'), historyMessage(2, 'assistant', '二つ目')],
        has_more: false,
      });
    const { result } = renderHook(() => useChat(vi.fn(), vi.fn()));
    await act(async () => {});
    expect(result.current.messages.map((message) => message.content)).toEqual(['三つ目', '四つ目']);
    expect(result.current.hasMoreHistory).toBe(true);

    await act(async () => {
      await result.current.loadOlderHistory();
    });
    expect(mockedGetHistory).toHaveBeenLastCalledWith(expect.objectContaining({ beforeId: 3 }));
    expect(result.current.messages.map((message) => message.content)).toEqual([
      '一つ目',
      '二つ目',
      '三つ目',
      '四つ目',
    ]);
    expect(result.current.hasMoreHistory).toBe(false);
  });
});
