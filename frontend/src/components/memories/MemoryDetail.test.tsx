import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryDetail } from './MemoryDetail';
import type { Memory } from '../../types/memory';

const memory: Memory = {
  id: 1,
  content: 'テスト用の記憶',
  category: 'state',
  importance: 3,
  status: 'active',
  is_active: true,
  provenance: 'explicit',
  keywords: [],
  specific_terms: [],
  period_start: '2026-11-01T00:00:00Z',
  period_end: null,
  event_at: null,
  provisional: false,
  source_type: 'conversation',
  source_date: null,
  created_at: '2026-11-01T00:00:00Z',
  content_updated_at: '2026-11-01T00:00:00Z',
  content_update_source_type: 'conversation',
  content_update_provenance: 'explicit',
  last_accessed_at: null,
  last_recalled_at: null,
  reactivation_count: 0,
  last_restored_at: '2026-11-15T02:00:00+09:00',
  restoration_count: 3,
  last_reinforced_at: '2026-11-15T02:01:00+09:00',
};

afterEach(() => {
  cleanup();
});

describe('MemoryDetail', () => {
  it('lists the lifecycle bookkeeping in the spec order', () => {
    const { container } = render(<MemoryDetail memory={memory} />);
    const terms = [...container.querySelectorAll('dt')].map((dt) => dt.textContent);
    const lifecycle = terms.filter((term) =>
      ['最終アクセス', '最終強化', '最終想起', '想起回数', '最終復帰', '復帰回数'].includes(
        term ?? '',
      ),
    );
    expect(lifecycle).toEqual([
      '最終アクセス',
      '最終強化',
      '最終想起',
      '想起回数',
      '最終復帰',
      '復帰回数',
    ]);
  });
});
