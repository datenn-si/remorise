import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

function stubMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return matches;
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, fn: (event: MediaQueryListEvent) => void) =>
      listeners.add(fn),
    removeEventListener: (_type: string, fn: (event: MediaQueryListEvent) => void) =>
      listeners.delete(fn),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  return {
    setMatches(next: boolean) {
      matches = next;
      listeners.forEach((fn) => fn({ matches: next } as MediaQueryListEvent));
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('usePrefersReducedMotion', () => {
  it('reports the OS setting and follows its changes', () => {
    const media = stubMedia(false);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    act(() => media.setMatches(true));
    expect(result.current).toBe(true);
    act(() => media.setMatches(false));
    expect(result.current).toBe(false);
  });

  it('starts reduced when the OS setting is already on', () => {
    stubMedia(true);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
  });
});
