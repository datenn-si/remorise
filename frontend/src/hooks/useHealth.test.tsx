import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHealth } from '../services/api';
import { HEALTH_POLL_MS, useHealth } from './useHealth';

vi.mock('../services/api', () => ({ getHealth: vi.fn() }));

const mockedGetHealth = vi.mocked(getHealth);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useHealth', () => {
  it('reports offline after three failed checks and recovers when health returns', async () => {
    mockedGetHealth.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useHealth(0));
    await act(async () => {});
    expect(result.current).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(HEALTH_POLL_MS);
    });
    expect(result.current).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(HEALTH_POLL_MS);
    });
    expect(result.current).toBe(false);

    mockedGetHealth.mockResolvedValue({ status: 'ok' });
    await act(async () => {
      vi.advanceTimersByTime(HEALTH_POLL_MS);
    });
    expect(result.current).toBe(true);
  });
});
