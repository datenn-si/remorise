import { describe, expect, it } from 'vitest';
import swSource from '../public/sw.js?raw';

// The service worker is a plain script in public/, outside the
// module graph. These tests load its source and run it against a
// stubbed worker scope (self / caches / fetch) to pin the fetch
// contract — above all that a navigation answered with an error
// status (a stopped backend behind a proxy answers 502 without the
// fetch rejecting) falls back to the cached shell instead of
// surfacing the proxy's error page.

const ORIGIN = 'https://remorise.test';
const SHELL_HTML = '<!doctype html><title>shell</title>';

class FakeResponse {
  readonly status: number;
  private readonly body: string;

  constructor(body: string, status = 200) {
    this.body = body;
    this.status = status;
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  clone(): FakeResponse {
    return new FakeResponse(this.body, this.status);
  }

  async text(): Promise<string> {
    return this.body;
  }
}

type FetchImpl = (request: unknown) => Promise<FakeResponse>;

class FakeCache {
  readonly store = new Map<string, FakeResponse>();
  private readonly fetchImpl: FetchImpl;

  constructor(fetchImpl: FetchImpl) {
    this.fetchImpl = fetchImpl;
  }

  private key(input: unknown): string {
    if (typeof input === 'string') return new URL(input, ORIGIN).href;
    return (input as { url: string }).url;
  }

  async addAll(urls: string[]): Promise<void> {
    for (const url of urls) {
      const response = await this.fetchImpl({ url: new URL(url, ORIGIN).href, method: 'GET' });
      if (!response.ok) throw new Error(`addAll failed for ${url}`);
      this.store.set(this.key(url), response);
    }
  }

  async put(input: unknown, response: FakeResponse): Promise<void> {
    this.store.set(this.key(input), response);
  }

  async match(input: unknown): Promise<FakeResponse | undefined> {
    return this.store.get(this.key(input));
  }
}

class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();
  private readonly fetchImpl: FetchImpl;

  constructor(fetchImpl: FetchImpl) {
    this.fetchImpl = fetchImpl;
  }

  async open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache(this.fetchImpl);
      this.caches.set(name, cache);
    }
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }

  async match(input: unknown): Promise<FakeResponse | undefined> {
    for (const cache of this.caches.values()) {
      const hit = await cache.match(input);
      if (hit) return hit;
    }
    return undefined;
  }
}

type Listener = (event: unknown) => void;

interface Harness {
  listeners: Map<string, Listener>;
  caches: FakeCacheStorage;
  dispatchFetch: (request: {
    url: string;
    method?: string;
    mode?: string;
  }) => Promise<FakeResponse | undefined> | null;
  install: () => Promise<void>;
}

function loadWorker(fetchImpl: FetchImpl): Harness {
  const source = swSource;
  const listeners = new Map<string, Listener>();
  const caches = new FakeCacheStorage(fetchImpl);
  const scope = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, listener);
    },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  };
  const run = new Function('self', 'caches', 'fetch', source);
  run(scope, caches, fetchImpl);

  return {
    listeners,
    caches,
    install: async () => {
      let pending: Promise<unknown> | undefined;
      listeners.get('install')?.({
        waitUntil: (promise: Promise<unknown>) => {
          pending = promise;
        },
      });
      await pending;
    },
    dispatchFetch: (request) => {
      let result: Promise<FakeResponse | undefined> | null = null;
      listeners.get('fetch')?.({
        request: { method: 'GET', mode: 'cors', ...request },
        respondWith: (promise: Promise<FakeResponse | undefined>) => {
          result = promise;
        },
      });
      return result;
    },
  };
}

const okFetch: FetchImpl = (request) => {
  const url = (request as { url: string }).url;
  if (url.endsWith('/logo.svg')) return Promise.resolve(new FakeResponse('<svg/>'));
  return Promise.resolve(new FakeResponse(SHELL_HTML));
};

describe('service worker navigation handling', () => {
  it('serves the cached shell when a navigation is answered 502', async () => {
    let impl: FetchImpl = okFetch;
    const worker = loadWorker((request) => impl(request));
    await worker.install();
    // The backend stops: a proxy in front of it now answers 502
    // (an HTML error page), which fetch does NOT reject on.
    impl = () => Promise.resolve(new FakeResponse('Bad Gateway', 502));
    const response = await worker.dispatchFetch({ url: `${ORIGIN}/`, mode: 'navigate' });
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe(SHELL_HTML);
  });

  it('serves the cached shell when the network itself fails', async () => {
    let impl: FetchImpl = okFetch;
    const worker = loadWorker((request) => impl(request));
    await worker.install();
    impl = () => Promise.reject(new TypeError('network down'));
    const response = await worker.dispatchFetch({ url: `${ORIGIN}/settings`, mode: 'navigate' });
    expect(await response?.text()).toBe(SHELL_HTML);
  });

  it('returns the network page when it is fine and refreshes the cached shell', async () => {
    let impl: FetchImpl = okFetch;
    const worker = loadWorker((request) => impl(request));
    await worker.install();
    impl = () => Promise.resolve(new FakeResponse('<!doctype html><title>fresh</title>'));
    const response = await worker.dispatchFetch({ url: `${ORIGIN}/`, mode: 'navigate' });
    expect(await response?.text()).toBe('<!doctype html><title>fresh</title>');
    const cached = await worker.caches.match('/index.html');
    expect(await cached?.text()).toBe('<!doctype html><title>fresh</title>');
  });

  it('passes the error page through when no shell was ever cached', async () => {
    const worker = loadWorker(() => Promise.resolve(new FakeResponse('Bad Gateway', 502)));
    const response = await worker.dispatchFetch({ url: `${ORIGIN}/`, mode: 'navigate' });
    expect(response?.status).toBe(502);
  });

  it('never intercepts API calls or non-GET requests', async () => {
    const worker = loadWorker(okFetch);
    expect(worker.dispatchFetch({ url: `${ORIGIN}/api/chat`, mode: 'cors' })).toBeNull();
    expect(worker.dispatchFetch({ url: `${ORIGIN}/health`, mode: 'cors' })).toBeNull();
    expect(worker.dispatchFetch({ url: `${ORIGIN}/`, method: 'POST', mode: 'cors' })).toBeNull();
  });

  it('serves a cached static asset without the network', async () => {
    let impl: FetchImpl = okFetch;
    const worker = loadWorker((request) => impl(request));
    await worker.install();
    impl = () => Promise.reject(new TypeError('network down'));
    const response = await worker.dispatchFetch({ url: `${ORIGIN}/logo.svg`, mode: 'cors' });
    expect(await response?.text()).toBe('<svg/>');
  });
});
