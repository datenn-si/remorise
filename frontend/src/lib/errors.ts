// One wording for every connection failure, wherever it surfaces:
// banners, form errors and load failures all show this same sentence.
export const CONNECTION_ERROR_MESSAGE = 'バックエンドに接続できません。';

const BY_CODE: Record<string, string> = {
  generation_in_progress: 'いま応答を生成しています。終わるまで待機してください。',
  llm_unavailable: 'LLMサーバーに接続できません。送ったメッセージは履歴に残っています。',
  llm_timeout: 'LLMサーバーが時間内に応答しませんでした。送ったメッセージは履歴に残っています。',
  llm_error: 'LLMサーバーがエラーを返しました。送ったメッセージは履歴に残っています。',
  memory_not_found: '記憶が見つかりません。',
  character_state_not_found: 'キャラクター状態が見つかりません。',
  validation_error: '入力内容を確認してください。',
  timeout: CONNECTION_ERROR_MESSAGE,
  network: CONNECTION_ERROR_MESSAGE,
  invalid_response: 'サーバーの応答を読み取れませんでした。',
};

export function apiErrorMessage(status: number, code: string | undefined): string {
  if (code && BY_CODE[code]) return BY_CODE[code];
  if (status === 409) return BY_CODE.generation_in_progress;
  if (status === 422) return BY_CODE.validation_error;
  // A 502 without a code did not come from the backend's own
  // error contract (those always carry a code): a gateway in
  // front of it (Tailscale Serve, the Vite proxy) could not
  // reach it, which is a connection failure, not an LLM error.
  if (status === 502) return BY_CODE.network;
  if (status === 503) return BY_CODE.llm_unavailable;
  if (status === 504) return BY_CODE.llm_timeout;
  if (status === 404) return '見つかりませんでした。';
  if (status === 0) return BY_CODE.network;
  return 'リクエストに失敗しました。';
}

export function errorText(error: unknown): string {
  if (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return '';
  }
  if (error instanceof Error && error.name === 'ApiError') return error.message;
  return CONNECTION_ERROR_MESSAGE;
}
