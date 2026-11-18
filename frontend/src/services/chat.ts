import type { CharacterState } from '../types/character';
import {
  isStateAnalysis,
  type HistoryResponse,
  type InferenceStatus,
  type StateAnalysis,
} from '../types/chat';
import { CONNECTION_ERROR_MESSAGE } from '../lib/errors';
import { ApiError, apiErrorFromResponse, apiUrl, request } from './api';
import { createSseParser, type SseEvent } from './sse';

export type ChatStreamEvent =
  | { type: 'message_start'; messageId: number }
  | { type: 'token'; content: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number; totalTokens: number }
  | { type: 'state_analysis'; analysis: StateAnalysis }
  | { type: 'character_state'; state: CharacterState }
  | { type: 'message_end'; messageId: number }
  | { type: 'error'; code: string }
  | { type: 'invalid' };

export type HistoryPageOptions = {
  /** Fetch the page older than this message id (cursor). */
  beforeId?: number;
  limit?: number;
  /** Include rows invalidated by forgetting (debug view only). */
  includeArchived?: boolean;
  signal?: AbortSignal;
};

export function getHistory(options: HistoryPageOptions = {}): Promise<HistoryResponse> {
  const params = new URLSearchParams();
  if (options.beforeId !== undefined) params.set('before_id', String(options.beforeId));
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.includeArchived) params.set('include_archived', 'true');
  const query = params.toString();
  return request<HistoryResponse>(`/api/chat/history${query ? `?${query}` : ''}`, {
    signal: options.signal,
  });
}

export function getInferenceStatus(signal?: AbortSignal): Promise<InferenceStatus> {
  return request<InferenceStatus>('/api/chat/inference-status', { signal });
}

export function parseChatEvent(event: SseEvent): ChatStreamEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(event.data);
  } catch {
    return { type: 'invalid' };
  }
  if (!isRecord(payload)) return { type: 'invalid' };
  switch (event.event) {
    case 'message_start':
    case 'message_end':
      if (typeof payload.message_id !== 'number') return { type: 'invalid' };
      return event.event === 'message_start'
        ? { type: 'message_start', messageId: payload.message_id }
        : { type: 'message_end', messageId: payload.message_id };
    case 'token':
      return typeof payload.content === 'string'
        ? { type: 'token', content: payload.content }
        : { type: 'invalid' };
    case 'usage':
      return isTokenCount(payload.prompt_tokens) &&
        isTokenCount(payload.completion_tokens) &&
        isTokenCount(payload.total_tokens)
        ? {
            type: 'usage',
            promptTokens: payload.prompt_tokens,
            completionTokens: payload.completion_tokens,
            totalTokens: payload.total_tokens,
          }
        : { type: 'invalid' };
    case 'character_state':
      return isCharacterState(payload)
        ? { type: 'character_state', state: payload }
        : { type: 'invalid' };
    case 'state_analysis':
      return isStateAnalysis(payload)
        ? { type: 'state_analysis', analysis: payload }
        : { type: 'invalid' };
    case 'error':
      return typeof payload.code === 'string'
        ? { type: 'error', code: payload.code }
        : { type: 'invalid' };
    default:
      return { type: 'invalid' };
  }
}

export function streamChat(
  message: string,
  signal: AbortSignal,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  return streamSse('/api/chat', { message }, signal, onEvent);
}

export function streamResend(
  signal: AbortSignal,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  return streamSse('/api/chat/resend', {}, signal, onEvent);
}

async function streamSse(
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const connect = new AbortController();
  let timedOut = false;
  // The response only starts once the backend has waited for the
  // inference lock, run the front stage (memory processing, then
  // emotion analysis), and received the generation's first token —
  // on local hardware that chain legitimately takes minutes, so the
  // connect window has to cover it (front-stage budgets plus the
  // server-side LLM timeout), not just the network round trip.
  const timer = setTimeout(() => {
    timedOut = true;
    connect.abort();
  }, 600_000);
  const abortConnect = () => connect.abort();
  signal.addEventListener('abort', abortConnect);

  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: connect.signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    if (timedOut) throw new ApiError(0, CONNECTION_ERROR_MESSAGE, 'timeout');
    throw new ApiError(0, CONNECTION_ERROR_MESSAGE, 'network');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abortConnect);
  }

  if (!response.ok) throw await apiErrorFromResponse(response);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    throw new ApiError(response.status, 'ストリーム応答ではありません。', 'invalid_response');
  }
  if (!response.body) {
    throw new ApiError(response.status, 'ストリームを開始できません。', 'invalid_response');
  }

  const reader = response.body.getReader();
  const onAbort = () => {
    void reader.cancel();
  };
  signal.addEventListener('abort', onAbort);
  const decoder = new TextDecoder();
  const parser = createSseParser();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        onEvent(parseChatEvent(event));
      }
    }
    for (const event of parser.push(decoder.decode())) onEvent(parseChatEvent(event));
    for (const event of parser.flush()) onEvent(parseChatEvent(event));
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCharacterState(value: Record<string, unknown>): value is CharacterState {
  return (
    typeof value.emotion === 'string' &&
    typeof value.intensity === 'number' &&
    value.intensity >= 0 &&
    value.intensity <= 1 &&
    (value.secondary_emotion === null || typeof value.secondary_emotion === 'string') &&
    typeof value.secondary_intensity === 'number' &&
    value.secondary_intensity >= 0 &&
    value.secondary_intensity <= 1 &&
    typeof value.mood === 'string' &&
    typeof value.affinity === 'number' &&
    Number.isInteger(value.affinity) &&
    value.affinity >= 0 &&
    value.affinity <= 200 &&
    typeof value.last_emotion_update === 'string' &&
    typeof value.updated_at === 'string'
  );
}
