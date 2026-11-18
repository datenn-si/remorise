import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fullscreenSupported, useFullscreen } from './useFullscreen';

function stubFullscreen(enabled: boolean) {
  Object.defineProperty(document, 'fullscreenEnabled', {
    configurable: true,
    value: enabled,
  });
}

afterEach(() => {
  stubFullscreen(false);
  vi.restoreAllMocks();
});

describe('fullscreenSupported', () => {
  it('is false when the document does not allow fullscreen (insecure origin)', () => {
    stubFullscreen(false);
    expect(fullscreenSupported()).toBe(false);
  });

  it('is true when the document allows fullscreen and the API exists', () => {
    stubFullscreen(true);
    document.documentElement.requestFullscreen = vi.fn().mockResolvedValue(undefined);
    expect(fullscreenSupported()).toBe(true);
  });
});

describe('useFullscreen', () => {
  it('requests fullscreen on the root element and exits when active', async () => {
    stubFullscreen(true);
    const request = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = request;
    document.exitFullscreen = exit;

    const { result } = renderHook(() => useFullscreen());
    expect(result.current.supported).toBe(true);
    expect(result.current.fullscreen).toBe(false);

    act(() => result.current.toggle());
    expect(request).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: document.documentElement,
    });
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(result.current.fullscreen).toBe(true);

    act(() => result.current.toggle());
    expect(exit).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: null,
    });
  });
});
