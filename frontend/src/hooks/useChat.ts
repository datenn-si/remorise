import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { reduceChat, initialChatState } from '../lib/chatState';
import { errorText } from '../lib/errors';
import { toDisplayMessages } from '../lib/messages';
import { ApiError } from '../services/api';
import { getHistory, streamChat, streamResend, type ChatStreamEvent } from '../services/chat';
import type { CharacterState } from '../types/character';
import type { DisplayMessage, HistoryMessage } from '../types/chat';

export const HISTORY_PAGE_SIZE = 100;

/**
 * A unique local id. crypto.randomUUID is only available in secure
 * contexts (https or localhost), and the app is also served over plain
 * http on the tailnet address, so fall back to getRandomValues —
 * available in both — when randomUUID is missing.
 */
function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type SendResult = 'kept' | 'restore' | 'ignored';

export function useChat(
  onState: (state: CharacterState) => void,
  onTextRestore?: (text: string) => void,
  includeArchived = false,
) {
  const [state, dispatch] = useReducer(reduceChat, initialChatState);
  const [historyNonce, setHistoryNonce] = useState(0);
  // The raw history rows currently held (a contiguous tail of the
  // conversation: the latest page plus any older pages the user
  // scrolled back through). Display messages are always derived from
  // the whole held range, never from a single page, so tool rows and
  // their results pair up across page boundaries.
  const rawRef = useRef<HistoryMessage[]>([]);
  const hasMoreRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);
  const session = useRef(1);
  const abortRef = useRef<AbortController | null>(null);
  const liveRef = useRef(false);
  const busy = useRef(false);
  // Set when this screen goes away: in-flight reads stop applying
  // their results, but the turn itself is never stopped (accepted
  // turns run to completion on the backend; there is no stop control).
  const cancelledRef = useRef(false);
  const stateRef = useRef(state);
  const onStateRef = useRef(onState);
  const onTextRestoreRef = useRef(onTextRestore);
  stateRef.current = state;
  onStateRef.current = onState;
  onTextRestoreRef.current = onTextRestore;

  useEffect(() => {
    return () => {
      if (!liveRef.current) return;
      cancelledRef.current = true;
      // Leaving the page must not stop the turn (accepted turns run
      // to completion on the backend). Only the local read is dropped.
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const id = session.current;
    const abort = new AbortController();
    void getHistory({ limit: HISTORY_PAGE_SIZE, includeArchived, signal: abort.signal })
      .then((history) => {
        if (session.current !== id) return;
        rawRef.current = history.messages;
        hasMoreRef.current = history.has_more;
        setHasMoreHistory(history.has_more);
        dispatch({ type: 'historyLoaded', messages: toDisplayMessages(history.messages) });
      })
      .catch((caught: unknown) => {
        if (abort.signal.aborted || session.current !== id) return;
        dispatch({
          type: 'historyFailed',
          text: errorText(caught) || '会話履歴を読み込めませんでした。',
        });
      });
    return () => {
      abort.abort();
      if (session.current === id) session.current += 1;
    };
  }, [historyNonce, includeArchived]);

  // Merge a freshly fetched latest page into the held history: rows
  // the page covers are replaced by its versions (a turn's reply may
  // have been saved), while older
  // pages the user scrolled back through stay loaded.
  const mergeLatestPage = useCallback((page: HistoryMessage[], pageHasMore: boolean) => {
    const firstId = page.length > 0 ? page[0].id : Number.POSITIVE_INFINITY;
    const wasEmpty = rawRef.current.length === 0;
    rawRef.current = [...rawRef.current.filter((row) => row.id < firstId), ...page];
    if (wasEmpty) {
      hasMoreRef.current = pageHasMore;
      setHasMoreHistory(pageHasMore);
    }
  }, []);

  const refreshLatest = useCallback(async (): Promise<DisplayMessage[]> => {
    const history = await getHistory({ limit: HISTORY_PAGE_SIZE, includeArchived });
    mergeLatestPage(history.messages, history.has_more);
    return toDisplayMessages(rawRef.current);
  }, [includeArchived, mergeLatestPage]);

  const loadOlderHistory = useCallback(async () => {
    if (loadingOlderRef.current || !hasMoreRef.current) return;
    const current = stateRef.current;
    if (current.phase !== 'idle' || current.loadingHistory) return;
    const oldest = rawRef.current[0];
    if (!oldest) return;
    loadingOlderRef.current = true;
    setLoadingOlderHistory(true);
    const ticket = session.current;
    try {
      const page = await getHistory({
        beforeId: oldest.id,
        limit: HISTORY_PAGE_SIZE,
        includeArchived,
      });
      if (ticket !== session.current) return;
      rawRef.current = [...page.messages, ...rawRef.current];
      hasMoreRef.current = page.has_more;
      setHasMoreHistory(page.has_more);
      dispatch({ type: 'historyPrepended', messages: toDisplayMessages(rawRef.current) });
    } catch {
      // Scrolling up again retries.
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlderHistory(false);
    }
  }, [includeArchived]);

  const applyEvent = useCallback(
    (event: ChatStreamEvent, bubble: { id: string }, warned: { current: boolean }) => {
      switch (event.type) {
        case 'message_start':
          return;
        case 'token':
          if (!bubble.id) bubble.id = `asst-${randomId()}`;
          dispatch({ type: 'token', localId: bubble.id, content: event.content });
          return;
        case 'usage':
          dispatch({
            type: 'usage',
            usage: {
              promptTokens: event.promptTokens,
              completionTokens: event.completionTokens,
              totalTokens: event.totalTokens,
            },
          });
          return;
        case 'state_analysis':
          dispatch({ type: 'stateAnalysis', analysis: event.analysis });
          return;
        case 'character_state':
          onStateRef.current(event.state);
          return;
        case 'message_end':
          return;
        case 'error':
          return;
        case 'invalid':
          if (!warned.current) {
            warned.current = true;
            dispatch({ type: 'warn', text: '応答の一部を読み取れませんでした。' });
          }
      }
    },
    [],
  );

  const send = useCallback(
    async (text: string): Promise<SendResult> => {
      const trimmed = text.trim();
      const current = stateRef.current;
      if (!trimmed || busy.current || current.phase !== 'idle' || current.loadingHistory) {
        return 'ignored';
      }
      busy.current = true;
      liveRef.current = true;
      cancelledRef.current = false;
      const ticket = session.current;
      const userId = `local-${randomId()}`;
      dispatch({ type: 'send', localId: userId, text: trimmed });
      const abort = new AbortController();
      abortRef.current = abort;
      const bubble = { id: '' };
      const warned = { current: false };
      let finished = false;
      let failed = false;
      try {
        await streamChat(trimmed, abort.signal, (event) => {
          if (ticket !== session.current || cancelledRef.current) return;
          if (event.type === 'message_end') {
            finished = true;
            return;
          }
          if (event.type === 'error') {
            finished = true;
            failed = true;
            dispatch({ type: 'streamError', text: '応答の生成に失敗しました。' });
            return;
          }
          applyEvent(event, bubble, warned);
        });
        if (ticket !== session.current || cancelledRef.current) return 'kept';
        if (!finished) {
          dispatch({ type: 'streamError', text: '応答の受信が途中で切れました。' });
          return 'kept';
        }
        if (failed) return 'kept';
        dispatch({ type: 'finish' });
        try {
          const messages = await refreshLatest();
          if (ticket !== session.current) return 'kept';
          dispatch({ type: 'replace', messages });
        } catch (caught) {
          if (ticket !== session.current) return 'kept';
          dispatch({
            type: 'refreshFailed',
            text: errorText(caught) || '履歴の更新に失敗しました。',
          });
        }
        return 'kept';
      } catch (caught) {
        if (ticket !== session.current || cancelledRef.current || abort.signal.aborted)
          return 'kept';
        const status = caught instanceof ApiError ? caught.status : 0;
        dispatch({
          type: 'httpError',
          status,
          text: errorText(caught) || 'メッセージを送れませんでした。',
        });
        return status === 409 || status === 422 ? 'restore' : 'kept';
      } finally {
        if (abortRef.current === abort) abortRef.current = null;
        liveRef.current = false;
        busy.current = false;
      }
    },
    [applyEvent, refreshLatest],
  );

  const resend = useCallback(
    async (localId: string): Promise<void> => {
      const current = stateRef.current;
      if (busy.current || current.phase !== 'idle' || current.loadingHistory) return;
      const target = current.messages.find(
        (message) => message.id === localId && message.role === 'user' && message.dangling,
      );
      if (!target) return;
      busy.current = true;
      liveRef.current = true;
      cancelledRef.current = false;
      const ticket = session.current;
      dispatch({ type: 'resend', localId });
      const abort = new AbortController();
      abortRef.current = abort;
      const bubble = { id: '' };
      const warned = { current: false };
      let finished = false;
      let failed = false;
      try {
        await streamResend(abort.signal, (event) => {
          if (ticket !== session.current || cancelledRef.current) return;
          if (event.type === 'message_end') {
            finished = true;
            return;
          }
          if (event.type === 'error') {
            finished = true;
            failed = true;
            dispatch({ type: 'streamError', text: '応答の生成に失敗しました。' });
            return;
          }
          applyEvent(event, bubble, warned);
        });
        if (ticket !== session.current || cancelledRef.current) return;
        if (!finished) {
          dispatch({ type: 'streamError', text: '応答の受信が途中で切れました。' });
          return;
        }
        if (failed) return;
        dispatch({ type: 'finish' });
        try {
          const messages = await refreshLatest();
          if (ticket !== session.current) return;
          dispatch({ type: 'replace', messages });
        } catch (caught) {
          if (ticket !== session.current) return;
          dispatch({
            type: 'refreshFailed',
            text: errorText(caught) || '履歴の更新に失敗しました。',
          });
        }
      } catch (caught) {
        if (ticket !== session.current || cancelledRef.current || abort.signal.aborted) return;
        // The local dangling assumption may be stale (for example the
        // reply exists after all): resync from the server, then report.
        let fresh: DisplayMessage[] | undefined;
        try {
          fresh = await refreshLatest();
          if (ticket !== session.current) return;
        } catch {
          fresh = undefined;
        }
        dispatch({
          type: 'resendFailed',
          text: errorText(caught) || '再送できませんでした。',
          messages: fresh,
        });
      } finally {
        if (abortRef.current === abort) abortRef.current = null;
        liveRef.current = false;
        busy.current = false;
      }
    },
    [applyEvent, refreshLatest],
  );

  const reloadHistory = useCallback(() => {
    if (stateRef.current.phase !== 'idle') return;
    dispatch({ type: 'historyLoading' });
    setHistoryNonce((nonce) => nonce + 1);
  }, []);

  return {
    messages: state.messages,
    phase: state.phase,
    toolName: state.toolName,
    banner: state.banner,
    loadingHistory: state.loadingHistory,
    hasMoreHistory,
    loadingOlderHistory,
    loadOlderHistory,
    trace: state.trace,
    send,
    resend,
    reloadHistory,
    dismissBanner: () => dispatch({ type: 'dismissBanner' }),
  };
}
