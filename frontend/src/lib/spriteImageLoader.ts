/**
 * Sprite layer images load over whatever link the phone currently
 * has: one failed request must not cost the layer for the whole
 * session, and firing every layer at once floods a slow link until
 * unrelated requests (health checks, history) start failing too.
 * Load in small batches and retry each image with backoff.
 */
const RETRY_DELAYS_MS = [1_000, 3_000];
export const SPRITE_IMAGE_CONCURRENCY = 6;

function loadOnce(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      void Promise.resolve(image.decode?.()).then(
        () => resolve(image),
        () => resolve(image),
      );
    };
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

async function loadWithRetry(
  url: string,
  delay: (ms: number) => Promise<void>,
): Promise<HTMLImageElement | null> {
  for (let attempt = 0; ; attempt += 1) {
    const image = await loadOnce(url);
    if (image) return image;
    const wait = RETRY_DELAYS_MS[attempt];
    if (wait === undefined) return null;
    await delay(wait);
  }
}

export async function loadSpriteImages(
  urls: readonly string[],
  options: {
    concurrency?: number;
    delay?: (ms: number) => Promise<void>;
  } = {},
): Promise<Map<string, HTMLImageElement>> {
  const concurrency = options.concurrency ?? SPRITE_IMAGE_CONCURRENCY;
  const delay =
    options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const loaded = new Map<string, HTMLImageElement>();
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next];
      next += 1;
      const image = await loadWithRetry(url, delay);
      if (image) loaded.set(url, image);
    }
  };
  const workers = Math.min(concurrency, urls.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return loaded;
}
