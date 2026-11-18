import type {
  DisplayMessage,
  InferenceStatus,
  StateAnalysis,
  ToolDebug,
  UsageDebug,
} from '../types/chat';
import { toolActivity } from './labels';

export type TurnTrace = {
  tools: ToolDebug[];
  usage: UsageDebug | null;
  stateAnalysis: StateAnalysis | null;
};

export const emptyTrace: TurnTrace = { tools: [], usage: null, stateAnalysis: null };

export type Phase = 'idle' | 'thinking' | 'speaking' | 'tool' | 'settling';

export type Banner = {
  tone: 'error' | 'info';
  text: string;
  retry?: boolean;
};

export type ChatState = {
  messages: DisplayMessage[];
  phase: Phase;
  toolName: string | null;
  openAssistantId: string | null;
  pendingUserId: string | null;
  banner: Banner | null;
  loadingHistory: boolean;
  trace: TurnTrace;
};

export const initialChatState: ChatState = {
  messages: [],
  phase: 'idle',
  toolName: null,
  openAssistantId: null,
  pendingUserId: null,
  banner: null,
  loadingHistory: true,
  trace: emptyTrace,
};

export type ChatAction =
  | { type: 'historyLoading' }
  | { type: 'historyLoaded'; messages: DisplayMessage[] }
  | { type: 'historyPrepended'; messages: DisplayMessage[] }
  | { type: 'historyFailed'; text: string }
  | { type: 'send'; localId: string; text: string }
  | { type: 'resend'; localId: string }
  | { type: 'resendFailed'; text: string; messages?: DisplayMessage[] }
  | { type: 'token'; localId: string; content: string }
  | { type: 'tool'; id: string; name: string; arguments: string }
  | { type: 'toolDone'; id: string; result: string }
  | { type: 'usage'; usage: UsageDebug }
  | { type: 'stateAnalysis'; analysis: StateAnalysis }
  | { type: 'finish' }
  | { type: 'replace'; messages: DisplayMessage[] }
  | { type: 'refreshFailed'; text: string }
  | { type: 'httpError'; status: number; text: string }
  | { type: 'streamError'; text: string }
  | { type: 'warn'; text: string }
  | { type: 'dismissBanner' };

export function inputLocked(state: Pick<ChatState, 'phase' | 'loadingHistory'>): boolean {
  return state.loadingHistory || state.phase !== 'idle';
}

export function spriteFlags(phase: Phase): { isSpeaking: boolean; isThinking: boolean } {
  return {
    isSpeaking: phase === 'speaking',
    isThinking: phase === 'thinking' || phase === 'tool',
  };
}

export function activityLabel(phase: Phase, toolName: string | null): string | null {
  if (phase === 'thinking') return '考えています';
  if (phase === 'speaking') return '話しています';
  if (phase === 'tool') return toolActivity(toolName);
  if (phase === 'settling') return '応答を保存しています';
  return null;
}

/**
 * Whether the normal UI should present the character as thinking because
 * of inference happening outside this turn: background work (memory
 * extraction, summarization, worker housekeeping) holding the shared
 * inference lock, or a send queued behind that work. The presentation is
 * the same thinking mark and label as a turn's own thinking phase; the
 * sprite's speaking state is never derived from this, and an active
 * speaking phase is never overridden.
 */
export function showsBackgroundThinking(status: InferenceStatus | null, phase: Phase): boolean {
  if (status === null) return false;
  if (status.foreground_waiting) return true;
  return phase === 'idle' && status.active === 'background';
}

/**
 * Whether the normal UI should present the character as speaking
 * because of a foreground turn this page is not streaming itself (it
 * was sent from another tab or device, or this page attached after
 * the fact): the backend reports the running turn's phase, and once
 * its first visible token is out the turn is speaking, not thinking.
 * A turn this page streams itself is presented from its own phase
 * and is never overridden.
 */
export function showsRemoteSpeaking(status: InferenceStatus | null, phase: Phase): boolean {
  if (status === null || phase !== 'idle') return false;
  return status.active === 'foreground' && status.foreground_phase === 'speaking';
}

export function reduceChat(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'historyLoading':
      if (state.phase !== 'idle') return state;
      return { ...state, loadingHistory: true };
    case 'historyLoaded':
      if (state.phase !== 'idle') return { ...state, loadingHistory: false };
      return {
        ...state,
        loadingHistory: false,
        messages: action.messages,
        banner: null,
        openAssistantId: null,
        pendingUserId: null,
        trace: emptyTrace,
      };
    case 'historyPrepended':
      // An older page was merged in front of the loaded history:
      // only the message list changes, nothing about the turn state.
      if (state.phase !== 'idle') return state;
      return { ...state, messages: action.messages };
    case 'historyFailed':
      return {
        ...state,
        loadingHistory: false,
        banner: { tone: 'error', text: action.text, retry: true },
      };
    case 'send':
      if (state.phase !== 'idle' || state.loadingHistory) return state;
      return {
        ...state,
        phase: 'thinking',
        toolName: null,
        openAssistantId: null,
        pendingUserId: action.localId,
        banner: null,
        trace: emptyTrace,
        messages: [...state.messages, { id: action.localId, role: 'user', content: action.text }],
      };
    case 'token': {
      if (state.phase === 'idle' || state.phase === 'settling') return state;
      if (state.openAssistantId) {
        const openId = state.openAssistantId;
        return {
          ...state,
          phase: 'speaking',
          toolName: null,
          messages: state.messages.map((message) =>
            message.id === openId
              ? { ...message, content: message.content + action.content }
              : message,
          ),
        };
      }
      return {
        ...state,
        phase: 'speaking',
        toolName: null,
        openAssistantId: action.localId,
        messages: [
          ...state.messages,
          { id: action.localId, role: 'assistant', content: action.content },
        ],
      };
    }
    case 'tool':
      if (state.phase === 'idle' || state.phase === 'settling') return state;
      return {
        ...state,
        phase: 'tool',
        toolName: action.name,
        openAssistantId: null,
        trace: {
          ...state.trace,
          tools: [
            ...state.trace.tools,
            { id: action.id, name: action.name, arguments: action.arguments, result: null },
          ],
        },
      };
    case 'toolDone': {
      if (state.phase === 'idle' || state.phase === 'settling') return state;
      const tools = state.trace.tools.map((tool) =>
        tool.id === action.id ? { ...tool, result: action.result } : tool,
      );
      return { ...state, phase: 'thinking', toolName: null, trace: { ...state.trace, tools } };
    }
    case 'usage':
      if (state.phase === 'idle') return state;
      return { ...state, trace: { ...state.trace, usage: action.usage } };
    case 'stateAnalysis':
      if (state.phase === 'idle') return state;
      return { ...state, trace: { ...state.trace, stateAnalysis: action.analysis } };
    case 'finish':
      if (state.phase === 'idle') return state;
      return { ...state, phase: 'settling', toolName: null, openAssistantId: null };
    case 'replace':
      if (state.phase !== 'idle' && state.phase !== 'settling') return state;
      return {
        ...state,
        phase: 'idle',
        toolName: null,
        openAssistantId: null,
        pendingUserId: null,
        loadingHistory: false,
        trace: emptyTrace,
        messages: action.messages,
        banner: null,
      };
    case 'refreshFailed':
      return idleWith(state, { tone: 'error', text: action.text, retry: true }, state.messages);
    case 'resend': {
      if (state.phase !== 'idle' || state.loadingHistory) return state;
      const target = state.messages.find((message) => message.id === action.localId);
      if (!target || target.role !== 'user' || !target.dangling) return state;
      return {
        ...state,
        phase: 'thinking',
        toolName: null,
        openAssistantId: null,
        pendingUserId: action.localId,
        banner: null,
        trace: emptyTrace,
        messages: setDangling(state.messages, action.localId, false),
      };
    }
    case 'resendFailed':
      return idleWith(
        state,
        { tone: 'error', text: action.text },
        action.messages ?? state.messages,
      );
    case 'httpError': {
      const drop = (action.status === 409 || action.status === 422) && state.pendingUserId !== null;
      // A kept optimistic message was stored by the server before the
      // generation failed, so it is left dangling and can be resent.
      const messages = drop
        ? state.messages.filter((message) => message.id !== state.pendingUserId)
        : state.pendingUserId
          ? setDangling(state.messages, state.pendingUserId, true)
          : state.messages;
      return idleWith(state, { tone: 'error', text: action.text }, messages);
    }
    case 'streamError':
      return idleWith(
        state,
        { tone: 'error', text: action.text },
        markDanglingTurn(state, markTurn(state, 'failed')),
      );
    case 'warn':
      return { ...state, banner: { tone: 'error', text: action.text } };
    case 'dismissBanner':
      return { ...state, banner: null };
  }
}

function idleWith(state: ChatState, banner: Banner, messages: DisplayMessage[]): ChatState {
  return {
    ...state,
    phase: 'idle',
    toolName: null,
    openAssistantId: null,
    pendingUserId: null,
    banner,
    messages,
  };
}

function setDangling(messages: DisplayMessage[], id: string, dangling: boolean): DisplayMessage[] {
  return messages.map((message) =>
    message.id === id ? { ...message, dangling: dangling ? true : undefined } : message,
  );
}

function markDanglingTurn(state: ChatState, messages: DisplayMessage[]): DisplayMessage[] {
  if (!state.pendingUserId) return messages;
  return setDangling(messages, state.pendingUserId, true);
}

function markTurn(state: ChatState, status: 'failed'): DisplayMessage[] {
  const start = state.pendingUserId
    ? state.messages.findIndex((message) => message.id === state.pendingUserId)
    : -1;
  if (start === -1) return state.messages;
  return state.messages.map((message, index) =>
    index > start && message.role === 'assistant' && !message.status
      ? { ...message, status }
      : message,
  );
}
