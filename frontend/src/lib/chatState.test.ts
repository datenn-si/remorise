import { describe, expect, it } from 'vitest';
import {
  initialChatState,
  reduceChat,
  showsBackgroundThinking,
  showsRemoteSpeaking,
  type ChatAction,
  type ChatState,
} from './chatState';
import type { InferenceStatus } from '../types/chat';

const ready: ChatState = { ...initialChatState, loadingHistory: false };

function run(actions: ChatAction[], state: ChatState = ready): ChatState {
  return actions.reduce(reduceChat, state);
}

describe('reduceChat', () => {
  it('appends tokens and starts a new reply after a tool call', () => {
    const state = run([
      { type: 'send', localId: 'user-1', text: 'こんにちは' },
      { type: 'token', localId: 'a1', content: 'やあ' },
      { type: 'token', localId: 'ignored', content: '。' },
      { type: 'tool', id: 'call-1', name: 'search_memories', arguments: '{"keywords":["旅"]}' },
      { type: 'toolDone', id: 'call-1', result: '[]' },
      { type: 'token', localId: 'a2', content: '覚えてる' },
    ]);
    expect(state.phase).toBe('speaking');
    expect(state.messages.map((message) => message.content)).toEqual([
      'こんにちは',
      'やあ。',
      '覚えてる',
    ]);
    expect(state.messages[1]?.role).toBe('assistant');
    expect(state.messages.map((message) => message.content).join('\n')).not.toContain('keywords');
    expect(state.trace.tools).toEqual([
      { id: 'call-1', name: 'search_memories', arguments: '{"keywords":["旅"]}', result: '[]' },
    ]);
  });

  it('keeps a failed reply when a late finish arrives', () => {
    const state = run([
      { type: 'send', localId: 'user-1', text: 'こんにちは' },
      { type: 'token', localId: 'a1', content: '途中' },
      { type: 'streamError', text: '失敗' },
      { type: 'finish' },
    ]);
    expect(state.phase).toBe('idle');
    expect(state.messages[1]).toMatchObject({ content: '途中', status: 'failed' });
    expect(state.banner?.tone).toBe('error');
  });

  it('drops an optimistic message on conflict and keeps it when the server stored it', () => {
    const sent: ChatAction[] = [{ type: 'send', localId: 'user-1', text: 'こんにちは' }];
    expect(run([...sent, { type: 'httpError', status: 409, text: 'busy' }]).messages).toEqual([]);
    // Kept: the server stored the message before generation failed, so
    // it is dangling and can be resent.
    expect(run([...sent, { type: 'httpError', status: 503, text: 'down' }]).messages).toEqual([
      { id: 'user-1', role: 'user', content: 'こんにちは', dangling: true },
    ]);
  });

  it('flags the user message as dangling when a stream fails', () => {
    const failed = run([
      { type: 'send', localId: 'user-1', text: 'こんにちは' },
      { type: 'streamError', text: '失敗' },
    ]);
    expect(failed.messages[0]?.dangling).toBe(true);
  });

  it('starts a resend only for a dangling user message while idle', () => {
    const base: ChatState = {
      ...ready,
      messages: [{ id: 'msg-1', role: 'user', content: 'こんにちは', dangling: true }],
    };
    const state = run([{ type: 'resend', localId: 'msg-1' }], base);
    expect(state.phase).toBe('thinking');
    expect(state.pendingUserId).toBe('msg-1');
    expect(state.messages[0]?.dangling).toBeUndefined();

    const answered: ChatState = {
      ...ready,
      messages: [{ id: 'msg-1', role: 'user', content: 'こんにちは' }],
    };
    expect(run([{ type: 'resend', localId: 'msg-1' }], answered)).toBe(answered);
  });

  it('flags the message as dangling again when the resend stream fails', () => {
    const base: ChatState = {
      ...ready,
      messages: [{ id: 'msg-1', role: 'user', content: 'こんにちは', dangling: true }],
    };
    const state = run(
      [
        { type: 'resend', localId: 'msg-1' },
        { type: 'token', localId: 'a1', content: '途中' },
        { type: 'streamError', text: '失敗' },
      ],
      base,
    );
    expect(state.phase).toBe('idle');
    expect(state.messages[0]?.dangling).toBe(true);
    expect(state.messages[1]).toMatchObject({ content: '途中', status: 'failed' });
  });

  it('resendFailed returns to idle and swaps in a resynced transcript when given one', () => {
    const base: ChatState = {
      ...ready,
      messages: [{ id: 'msg-1', role: 'user', content: 'こんにちは', dangling: true }],
    };
    const failed = run(
      [
        { type: 'resend', localId: 'msg-1' },
        { type: 'resendFailed', text: '再送できませんでした。' },
      ],
      base,
    );
    expect(failed.phase).toBe('idle');
    expect(failed.banner?.text).toBe('再送できませんでした。');
    expect(failed.messages).toHaveLength(1);

    const resynced = run(
      [
        { type: 'resend', localId: 'msg-1' },
        {
          type: 'resendFailed',
          text: '再送できませんでした。',
          messages: [
            { id: 'msg-1', role: 'user', content: 'こんにちは' },
            { id: 'msg-2', role: 'assistant', content: 'やあ' },
          ],
        },
      ],
      base,
    );
    expect(resynced.messages.map((message) => message.content)).toEqual(['こんにちは', 'やあ']);
  });

  it('ignores a new send and a history swap while a reply is in progress', () => {
    const speaking = run([
      { type: 'send', localId: 'user-1', text: 'こんにちは' },
      { type: 'token', localId: 'a1', content: 'やあ' },
    ]);
    expect(run([{ type: 'send', localId: 'user-2', text: '次' }], speaking).messages).toHaveLength(
      2,
    );
    expect(
      run([{ type: 'replace', messages: [] }], speaking).messages.map((message) => message.content),
    ).toEqual(['こんにちは', 'やあ']);
  });

  it('replaces the transcript after the reply is saved', () => {
    const saved = run([
      { type: 'send', localId: 'user-1', text: 'こんにちは' },
      { type: 'token', localId: 'a1', content: 'やあ' },
      { type: 'finish' },
      { type: 'replace', messages: [{ id: 'msg-1', role: 'user', content: 'こんにちは' }] },
    ]);
    expect(saved.phase).toBe('idle');
    expect(saved.messages).toEqual([{ id: 'msg-1', role: 'user', content: 'こんにちは' }]);
  });
});

describe('showsBackgroundThinking', () => {
  const background: InferenceStatus = {
    active: 'background',
    background_kind: 'summary',
    foreground_waiting: false,
    foreground_phase: null,
  };
  const foreground: InferenceStatus = {
    active: 'foreground',
    background_kind: null,
    foreground_waiting: false,
    foreground_phase: 'speaking',
  };
  const idle: InferenceStatus = {
    active: null,
    background_kind: null,
    foreground_waiting: false,
    foreground_phase: null,
  };

  it('shows nothing before the first status arrives', () => {
    expect(showsBackgroundThinking(null, 'idle')).toBe(false);
  });

  it('shows thinking while background work uses inference and the page is idle', () => {
    expect(showsBackgroundThinking(background, 'idle')).toBe(true);
  });

  it('stays quiet for foreground use and for an idle lock', () => {
    expect(showsBackgroundThinking(foreground, 'idle')).toBe(false);
    expect(showsBackgroundThinking(idle, 'idle')).toBe(false);
  });

  it('shows thinking while a send is queued behind background work', () => {
    expect(showsBackgroundThinking({ ...background, foreground_waiting: true }, 'thinking')).toBe(
      true,
    );
  });

  it('never overrides an active turn phase', () => {
    expect(showsBackgroundThinking(background, 'speaking')).toBe(false);
    expect(showsBackgroundThinking(background, 'settling')).toBe(false);
  });
});

describe('showsRemoteSpeaking', () => {
  const speaking: InferenceStatus = {
    active: 'foreground',
    background_kind: null,
    foreground_waiting: false,
    foreground_phase: 'speaking',
  };
  const thinking: InferenceStatus = { ...speaking, foreground_phase: 'thinking' };

  it('shows speaking while a turn this page is not streaming is in its speaking phase', () => {
    expect(showsRemoteSpeaking(speaking, 'idle')).toBe(true);
  });

  it('stays quiet while that turn is still thinking, and before any status arrives', () => {
    expect(showsRemoteSpeaking(thinking, 'idle')).toBe(false);
    expect(showsRemoteSpeaking(null, 'idle')).toBe(false);
  });

  it('never overrides a turn this page is streaming itself', () => {
    expect(showsRemoteSpeaking(speaking, 'thinking')).toBe(false);
    expect(showsRemoteSpeaking(speaking, 'speaking')).toBe(false);
  });
});
