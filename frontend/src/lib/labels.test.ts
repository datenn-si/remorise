import { describe, expect, it } from 'vitest';
import { memorySourceLabel } from './labels';

describe('memorySourceLabel', () => {
  it('renders conversation writes with the stated/inferred distinction', () => {
    expect(memorySourceLabel('conversation', 'explicit')).toBe('会話（明記）');
    expect(memorySourceLabel('conversation', 'inferred')).toBe('会話（推測）');
  });

  it('renders manual writes without a provenance suffix', () => {
    expect(memorySourceLabel('manual', 'explicit')).toBe('手動');
    expect(memorySourceLabel('manual', null)).toBe('手動');
  });

  it('falls back for missing or unknown sources', () => {
    expect(memorySourceLabel(null, null)).toBe('—');
    expect(memorySourceLabel('conversation', null)).toBe('会話');
  });
});
