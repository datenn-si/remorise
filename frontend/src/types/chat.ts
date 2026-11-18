export type HistoryMessage = {
  id: number;
  role: string;
  content: string;
  tool_calls: unknown[] | null;
  tool_call_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  /** True for rows invalidated by forgetting (only returned when the
   * caller asked for archived rows, i.e. the debug view). */
  archived?: boolean;
};

export type HistoryResponse = {
  messages: HistoryMessage[];
  has_more: boolean;
};

/** Wire format of `GET /api/chat/inference-status` (see backend docs). */
export type InferenceStatus = {
  active: 'foreground' | 'background' | null;
  background_kind: string | null;
  foreground_waiting: boolean;
  foreground_phase: 'thinking' | 'speaking' | null;
};

export type ToolDebug = {
  id: string;
  name: string;
  arguments: string;
  result: string | null;
};

export type UsageDebug = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type Emotion =
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'angry'
  | 'embarrassed'
  | 'surprised'
  | 'anxious'
  | 'affectionate'
  | 'puzzled';

export type StateAnalysis = {
  emotion: {
    primary: Emotion;
    intensity: number;
    secondary: Emotion | null;
    secondary_intensity: number;
    mood: string;
  };
  affinity: { delta: number; reason: string };
};

const emotions = new Set<Emotion>([
  'neutral',
  'happy',
  'sad',
  'angry',
  'embarrassed',
  'surprised',
  'anxious',
  'affectionate',
  'puzzled',
]);

export function isStateAnalysis(value: unknown): value is StateAnalysis {
  if (typeof value !== 'object' || value === null) return false;
  const analysis = value as Record<string, unknown>;
  const emotion = analysis.emotion;
  const affinity = analysis.affinity;
  if (
    typeof emotion !== 'object' ||
    emotion === null ||
    typeof affinity !== 'object' ||
    affinity === null
  )
    return false;
  const emotionValue = emotion as Record<string, unknown>;
  const affinityValue = affinity as Record<string, unknown>;
  return (
    emotions.has(emotionValue.primary as Emotion) &&
    typeof emotionValue.intensity === 'number' &&
    emotionValue.intensity >= 0 &&
    emotionValue.intensity <= 1 &&
    (emotionValue.secondary === null || emotions.has(emotionValue.secondary as Emotion)) &&
    typeof emotionValue.secondary_intensity === 'number' &&
    emotionValue.secondary_intensity >= 0 &&
    emotionValue.secondary_intensity <= 1 &&
    typeof emotionValue.mood === 'string' &&
    Number.isInteger(affinityValue.delta) &&
    typeof affinityValue.reason === 'string'
  );
}

/**
 * The front-stage analysis record the backend stores on the user message
 * (metadata key `front_stage`) so a resend can reuse it without applying
 * the state twice. Same shape as StateAnalysis plus the search keywords.
 */
export type FrontStageDebug = StateAnalysis & {
  keywords: string[];
  reminds: boolean;
};

export function isFrontStageDebug(value: unknown): value is FrontStageDebug {
  if (!isStateAnalysis(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.keywords) &&
    record.keywords.every((keyword) => typeof keyword === 'string') &&
    typeof record.reminds === 'boolean'
  );
}

export type MemorySearchResult = 'hit' | 'no_hit' | 'forgotten_undisclosed';

export type MemoryDelivery = 'hit' | 'recall' | 'new';

/**
 * The front stage's memory record on the assistant message: the
 * searches it ran (terms are the display keywords), what it disclosed
 * to the character and how each item arrived, and the side effects
 * of the turn (recalls, restorations, creations, the "something is
 * forgotten" notification terms, and provisional rows to ask back).
 */
export type MemorySearchDebug = {
  searches: { terms: string[]; pointing: boolean; result: MemorySearchResult }[];
  disclosed: { id: number; content: string; delivery: MemoryDelivery }[];
  recalled_ids: number[];
  restored_ids: number[];
  created_ids: number[];
  notification_terms: string[];
  ask_back_ids: number[];
};

const SEARCH_RESULTS = new Set<string>(['hit', 'no_hit', 'forgotten_undisclosed']);
const DELIVERIES = new Set<string>(['hit', 'recall', 'new']);

function isIdList(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((id) => typeof id === 'number');
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function isMemorySearchDebug(value: unknown): value is MemorySearchDebug {
  if (typeof value !== 'object' || value === null) return false;
  const search = value as Record<string, unknown>;
  return (
    Array.isArray(search.searches) &&
    search.searches.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        isStringList((entry as Record<string, unknown>).terms) &&
        typeof (entry as Record<string, unknown>).pointing === 'boolean' &&
        SEARCH_RESULTS.has((entry as Record<string, unknown>).result as string),
    ) &&
    Array.isArray(search.disclosed) &&
    search.disclosed.every(
      (hit) =>
        typeof hit === 'object' &&
        hit !== null &&
        typeof (hit as Record<string, unknown>).id === 'number' &&
        typeof (hit as Record<string, unknown>).content === 'string' &&
        DELIVERIES.has((hit as Record<string, unknown>).delivery as string),
    ) &&
    isIdList(search.recalled_ids) &&
    isIdList(search.restored_ids) &&
    isIdList(search.created_ids) &&
    isStringList(search.notification_terms) &&
    isIdList(search.ask_back_ids)
  );
}

export type SummaryDebug = {
  id: number;
  start_message_id: number;
  end_message_id: number;
};

export function isSummaryDebug(value: unknown): value is SummaryDebug {
  if (typeof value !== 'object' || value === null) return false;
  const summary = value as Record<string, unknown>;
  return (
    typeof summary.id === 'number' &&
    typeof summary.start_message_id === 'number' &&
    typeof summary.end_message_id === 'number'
  );
}

export type DisplayMessage = {
  id: string;
  /** The backend message id behind the string key, for debug surfaces
   * that work with the real id (e.g. the manual purge cutoff). */
  messageId?: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
  /** Invalidated by forgetting; only ever present in debug loads. */
  archived?: boolean;
  status?: 'failed';
  /** A user message whose generation failed before any reply was saved. */
  dangling?: boolean;
  metadata?: Record<string, unknown> | null;
  frontStage?: FrontStageDebug;
  stateAnalysis?: StateAnalysis;
  memorySearch?: MemorySearchDebug;
  summary?: SummaryDebug;
  tools?: ToolDebug[];
  usage?: UsageDebug;
};
