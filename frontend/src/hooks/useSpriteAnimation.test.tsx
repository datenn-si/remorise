import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BLINK_MIN_GAP_MS,
  BLINK_STEP_MS,
  MOUTH_INTERVAL_MS,
  nextBlinkDelay,
  useSpriteAnimation,
} from './useSpriteAnimation';
import type { EyeState } from '../lib/spriteLayers';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useSpriteAnimation', () => {
  it('closes the eyes through frames 1, 2, and 1, then opens them', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useSpriteAnimation({ eyes: 'open', mouth: 'closed', blinking: true, talking: false }),
    );

    expect(result.current.eyeFrameLeft).toBe(0);
    act(() => {
      vi.advanceTimersByTime(BLINK_STEP_MS);
    });
    expect(result.current.eyeFrameLeft).toBe(1);
    act(() => {
      vi.advanceTimersByTime(BLINK_STEP_MS);
    });
    expect(result.current.eyeFrameLeft).toBe(2);
    act(() => {
      vi.advanceTimersByTime(BLINK_STEP_MS);
    });
    expect(result.current.eyeFrameLeft).toBe(1);
    act(() => {
      vi.advanceTimersByTime(BLINK_STEP_MS);
    });
    expect(result.current.eyeFrameLeft).toBe(0);
  });

  it('holds the eyes closed and the mouth open without animating', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useSpriteAnimation({ eyes: 'closed', mouth: 'open', blinking: true, talking: false }),
    );

    expect(result.current.eyeFrameLeft).toBe(2);
    expect(result.current.mouthFrame).toBe(2);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.eyeFrameLeft).toBe(2);
    expect(result.current.mouthFrame).toBe(2);
  });

  it('opens and closes the mouth while talking, then returns to the resting mouth', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ talking }: { talking: boolean }) =>
        useSpriteAnimation({ eyes: 'open', mouth: 'closed', blinking: false, talking }),
      { initialProps: { talking: true } },
    );

    expect(result.current.mouthFrame).toBe(1);
    act(() => {
      vi.advanceTimersByTime(MOUTH_INTERVAL_MS);
    });
    expect(result.current.mouthFrame).toBe(2);
    act(() => {
      vi.advanceTimersByTime(MOUTH_INTERVAL_MS);
    });
    expect(result.current.mouthFrame).toBe(1);
    act(() => {
      vi.advanceTimersByTime(MOUTH_INTERVAL_MS);
    });
    expect(result.current.mouthFrame).toBe(0);

    rerender({ talking: false });
    expect(result.current.mouthFrame).toBe(0);
  });

  it('rests on a half-open eye and mouth without blinking', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useSpriteAnimation({ eyes: 'half', mouth: 'half', blinking: true, talking: false }),
    );
    expect(result.current.eyeFrameLeft).toBe(1);
    expect(result.current.mouthFrame).toBe(1);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.eyeFrameLeft).toBe(1);
    expect(result.current.mouthFrame).toBe(1);
  });

  it('plays the half-open frame when the eyes close with animation', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ eyes }: { eyes: EyeState }) =>
        useSpriteAnimation({
          eyes,
          mouth: 'closed',
          blinking: false,
          talking: false,
          animateChanges: true,
        }),
      { initialProps: { eyes: 'open' as EyeState } },
    );
    expect(result.current.eyeFrameLeft).toBe(0);
    rerender({ eyes: 'closed' });
    expect(result.current.eyeFrameLeft).toBe(1);
    act(() => {
      vi.advanceTimersByTime(BLINK_STEP_MS);
    });
    expect(result.current.eyeFrameLeft).toBe(2);
  });

  it('tracks split eye states per side and blinks only while both rest open', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ eyesLeft, eyesRight }: { eyesLeft: EyeState; eyesRight: EyeState }) =>
        useSpriteAnimation({
          eyes: 'open',
          eyesLeft,
          eyesRight,
          mouth: 'closed',
          blinking: true,
          talking: false,
        }),
      { initialProps: { eyesLeft: 'open' as EyeState, eyesRight: 'closed' as EyeState } },
    );
    expect(result.current.eyeFrameLeft).toBe(0);
    expect(result.current.eyeFrameRight).toBe(2);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.eyeFrameLeft).toBe(0);
    expect(result.current.eyeFrameRight).toBe(2);
    rerender({ eyesLeft: 'open', eyesRight: 'open' });
    act(() => {
      vi.advanceTimersByTime(BLINK_STEP_MS);
    });
    expect(result.current.eyeFrameLeft).toBe(1);
    expect(result.current.eyeFrameRight).toBe(1);
  });

  it('spaces blinks around twenty a minute and sooner when hurried', () => {
    expect(nextBlinkDelay(() => 0)).toBe(BLINK_MIN_GAP_MS);
    expect(Number.isFinite(nextBlinkDelay(() => 1))).toBe(true);
    const random = seededRandom(3);
    const calm = averageGap(random, false);
    const hurried = averageGap(seededRandom(3), true);
    expect(calm).toBeGreaterThan(2400);
    expect(calm).toBeLessThan(3600);
    expect(hurried).toBeGreaterThan(1400);
    expect(hurried).toBeLessThan(calm);
  });

  it('starts the next blink after the hurried gap', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.useFakeTimers();
    const delay = nextBlinkDelay(() => 0.5, true);
    expect(delay).toBeLessThan(nextBlinkDelay(() => 0.5, false));
    const { result } = renderHook(() =>
      useSpriteAnimation({
        eyes: 'open',
        mouth: 'closed',
        blinking: true,
        talking: false,
        hurried: true,
      }),
    );
    act(() => {
      vi.advanceTimersByTime(BLINK_STEP_MS * 4);
    });
    expect(result.current.eyeFrameLeft).toBe(0);
    act(() => {
      vi.advanceTimersByTime(delay - 1);
    });
    expect(result.current.eyeFrameLeft).toBe(0);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.eyeFrameLeft).toBe(1);
  });
});

function seededRandom(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return (value + 1) / 4294967297;
  };
}

function averageGap(random: () => number, hurried: boolean): number {
  let total = 0;
  const count = 2000;
  for (let index = 0; index < count; index += 1) total += nextBlinkDelay(random, hurried);
  return total / count;
}
