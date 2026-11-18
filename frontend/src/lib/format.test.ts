import { describe, expect, it } from 'vitest';
import { formatDateTime } from './format';

describe('formatDateTime', () => {
  it('shows an offset-less UTC timestamp in the local zone', () => {
    const zoned = formatDateTime('2026-10-31T15:04:00Z');
    const naive = formatDateTime('2026-10-31 15:04:00');
    const local = new Intl.DateTimeFormat(undefined, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date('2026-10-31T15:04:00Z'));
    expect(naive).toBe(zoned);
    expect(zoned).toBe(local);
  });
});
