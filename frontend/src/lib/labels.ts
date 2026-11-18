const EMOTION_LABELS: Record<string, string> = {
  neutral: '普通',
  happy: '喜び',
  sad: '悲しみ',
  angry: '怒り',
  embarrassed: '照れ',
  surprised: '驚き',
  anxious: '不安',
  affectionate: '親愛',
  puzzled: '困惑',
  normal: '普通',
};

const CATEGORY_LABELS: Record<string, string> = {
  event: '出来事',
  state: '状態',
};

const TOOL_LABELS: Record<string, string> = {
  search_memories: '記憶を探しています',
  get_memory: '記憶を確認しています',
  save_memory: '記憶を残しています',
  update_memory: '記憶を更新しています',
  get_conversation_summary: '会話の要約を見ています',
};

export function emotionLabel(value: string | null | undefined): string {
  if (!value) return EMOTION_LABELS.neutral;
  return EMOTION_LABELS[value] ?? value;
}

export function categoryLabel(value: string): string {
  return CATEGORY_LABELS[value] ?? value;
}

export function provenanceLabel(value: string | null | undefined): string {
  if (value === 'explicit') return '明示';
  if (value === 'inferred') return '推測';
  return value ?? '—';
}

const DELIVERY_LABELS: Record<string, string> = {
  hit: 'ヒット',
  recall: '想起',
  new: '新規',
};

export function deliveryLabel(value: string): string {
  return DELIVERY_LABELS[value] ?? value;
}

const SEARCH_RESULT_LABELS: Record<string, string> = {
  hit: 'ヒット',
  no_hit: 'ヒットなし',
  forgotten_undisclosed: '忘却・開示なし',
};

export function searchResultLabel(value: string): string {
  return SEARCH_RESULT_LABELS[value] ?? value;
}

export function toolActivity(name: string | null): string {
  if (!name) return '処理しています';
  return TOOL_LABELS[name] ?? '処理しています';
}

export function affinityLabel(affinity: number): string {
  if (affinity >= 140) return '親しい';
  if (affinity >= 80) return '普通';
  return '遠い';
}

const JOB_KIND_LABELS: Record<string, string> = {
  summary: '要約',
};

const JOB_STATUS_LABELS: Record<string, string> = {
  pending: '待機中',
  running: '実行中',
  done: '完了',
  failed: '失敗',
};

export function jobKindLabel(kind: string): string {
  return JOB_KIND_LABELS[kind] ?? kind;
}

export function jobStatusLabel(status: string): string {
  return JOB_STATUS_LABELS[status] ?? status;
}

export function sourceLabel(source: string): string {
  if (source === 'manual') return '手入力';
  if (source === 'conversation') return '会話';
  return source;
}

// A memory's creation/update source, rendered as one label: where the
// write came from, with the stated-vs-inferred distinction folded in
// for conversation writes （会話（明記） / 会話（推測） / 手動）.
export function memorySourceLabel(
  sourceType: string | null | undefined,
  provenance: string | null | undefined,
): string {
  if (!sourceType) return '—';
  if (sourceType === 'manual') return '手動';
  if (sourceType === 'conversation') {
    if (provenance === 'explicit') return '会話（明記）';
    if (provenance === 'inferred') return '会話（推測）';
    return '会話';
  }
  return sourceLabel(sourceType);
}
