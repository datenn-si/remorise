import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INFERENCE_STATUS_POLL_MS, useInferenceStatus } from './useInferenceStatus';
import { getInferenceStatus } from '../services/chat';
import type { InferenceStatus } from '../types/chat';

vi.mock('../services/chat', () => ({ getInferenceStatus: vi.fn() }));

const mockedGet = vi.mocked(getInferenceStatus);

const background: InferenceStatus = {
  active: 'background',
  background_kind: 'summary',
  foreground_waiting: false,
  foreground_phase: null,
};
const foreground: InferenceStatus = {
  active: 'foreground',
  background_kind: null,
  foreground_waiting: false,
  foreground_phase: 'thinking',
};
const idle: InferenceStatus = {
  active: null,
  background_kind: null,
  foreground_waiting: false,
  foreground_phase: null,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useInferenceStatus', () => {
  it('fetches immediately and then again on the poll interval', async () => {
    mockedGet.mockResolvedValueOnce(background).mockResolvedValue(idle);
    const { result } = renderHook(() => useInferenceStatus());
    await act(async () => {});
    expect(result.current).toEqual(background);

    await act(async () => {
      vi.advanceTimersByTime(INFERENCE_STATUS_POLL_MS);
    });
    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual(idle);
  });

  it('keeps the last known status when a poll fails', async () => {
    mockedGet.mockResolvedValueOnce(background).mockRejectedValueOnce(new Error('down'));
    const { result } = renderHook(() => useInferenceStatus());
    await act(async () => {});
    expect(result.current).toEqual(background);

    await act(async () => {
      vi.advanceTimersByTime(INFERENCE_STATUS_POLL_MS);
    });
    expect(result.current).toEqual(background);
  });

  it('stays null when the first poll fails', async () => {
    mockedGet.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useInferenceStatus());
    await act(async () => {});
    expect(result.current).toBeNull();
  });
});

describe('useInferenceStatus onForegroundSettled', () => {
  it('fires once when a foreground turn settles back to idle', async () => {
    const onForegroundSettled = vi.fn();
    mockedGet.mockResolvedValueOnce(foreground).mockResolvedValue(idle);
    renderHook(() => useInferenceStatus({ onForegroundSettled }));
    await act(async () => {});
    expect(onForegroundSettled).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(INFERENCE_STATUS_POLL_MS);
    });
    expect(onForegroundSettled).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(INFERENCE_STATUS_POLL_MS);
    });
    expect(onForegroundSettled).toHaveBeenCalledTimes(1);
  });

  it('still fires when background work runs between the turn and idle', async () => {
    const onForegroundSettled = vi.fn();
    mockedGet
      .mockResolvedValueOnce(foreground)
      .mockResolvedValueOnce(background)
      .mockResolvedValue(idle);
    renderHook(() => useInferenceStatus({ onForegroundSettled }));
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(INFERENCE_STATUS_POLL_MS);
    });
    expect(onForegroundSettled).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(INFERENCE_STATUS_POLL_MS);
    });
    expect(onForegroundSettled).toHaveBeenCalledTimes(1);
  });

  it('does not fire for background-only activity', async () => {
    const onForegroundSettled = vi.fn();
    mockedGet.mockResolvedValueOnce(background).mockResolvedValue(idle);
    renderHook(() => useInferenceStatus({ onForegroundSettled }));
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(INFERENCE_STATUS_POLL_MS);
    });
    expect(onForegroundSettled).not.toHaveBeenCalled();
  });

  it('fires again when a later foreground turn settles', async () => {
    const onForegroundSettled = vi.fn();
    mockedGet
      .mockResolvedValueOnce(foreground)
      .mockResolvedValueOnce(idle)
      .mockResolvedValueOnce(foreground)
      .mockResolvedValue(idle);
    renderHook(() => useInferenceStatus({ onForegroundSettled }));
    await act(async () => {});
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(INFERENCE_STATUS_POLL_MS);
      });
    }
    expect(onForegroundSettled).toHaveBeenCalledTimes(2);
  });
});
