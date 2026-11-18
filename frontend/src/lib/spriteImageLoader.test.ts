import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSpriteImages } from './spriteImageLoader';

class FakeImage {
  static failures = new Map<string, number>();
  static inFlight = 0;
  static maxInFlight = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private url = '';

  get src(): string {
    return this.url;
  }

  set src(url: string) {
    this.url = url;
    FakeImage.inFlight += 1;
    FakeImage.maxInFlight = Math.max(FakeImage.maxInFlight, FakeImage.inFlight);
    queueMicrotask(() => {
      FakeImage.inFlight -= 1;
      const remaining = FakeImage.failures.get(url) ?? 0;
      if (remaining > 0) {
        FakeImage.failures.set(url, remaining - 1);
        this.onerror?.();
      } else {
        this.onload?.();
      }
    });
  }

  decode(): Promise<void> {
    return Promise.resolve();
  }
}

const noDelay = () => Promise.resolve();

beforeEach(() => {
  FakeImage.failures = new Map();
  FakeImage.inFlight = 0;
  FakeImage.maxInFlight = 0;
  vi.stubGlobal('Image', FakeImage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadSpriteImages', () => {
  it('loads every image that succeeds', async () => {
    const loaded = await loadSpriteImages(['/a.png', '/b.png'], { delay: noDelay });
    expect([...loaded.keys()].sort()).toEqual(['/a.png', '/b.png']);
  });

  it('retries a failing image until it succeeds', async () => {
    FakeImage.failures.set('/flaky.png', 2);
    const loaded = await loadSpriteImages(['/flaky.png'], { delay: noDelay });
    expect(loaded.has('/flaky.png')).toBe(true);
  });

  it('gives up after the retries and still returns the others', async () => {
    FakeImage.failures.set('/dead.png', 99);
    const loaded = await loadSpriteImages(['/dead.png', '/ok.png'], { delay: noDelay });
    expect(loaded.has('/dead.png')).toBe(false);
    expect(loaded.has('/ok.png')).toBe(true);
  });

  it('caps how many images load at once', async () => {
    const urls = Array.from({ length: 12 }, (_, index) => `/layer-${index}.png`);
    const loaded = await loadSpriteImages(urls, { concurrency: 3, delay: noDelay });
    expect(loaded.size).toBe(12);
    expect(FakeImage.maxInFlight).toBeLessThanOrEqual(3);
  });
});
