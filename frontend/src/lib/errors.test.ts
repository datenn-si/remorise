import { describe, expect, it } from 'vitest';
import { apiErrorMessage } from './errors';

describe('apiErrorMessage', () => {
  it('keeps the coded messages the backend contract defines', () => {
    expect(apiErrorMessage(502, 'llm_error')).toContain('LLMサーバーがエラーを返しました');
    expect(apiErrorMessage(503, 'llm_unavailable')).toContain('LLMサーバーに接続できません');
    expect(apiErrorMessage(409, undefined)).toContain('応答を生成しています');
  });

  it('reads a bare 502 as a connection failure, not an LLM error', () => {
    // No code means the response did not come from the backend's
    // own error contract: a gateway in front of a stopped backend
    // (Tailscale Serve, the Vite proxy) answered instead.
    expect(apiErrorMessage(502, undefined)).toBe('バックエンドに接続できません。');
  });
});
