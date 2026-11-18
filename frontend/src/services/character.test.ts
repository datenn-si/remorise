import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPRITE } from '../lib/spriteLayers';
import { apiUrl } from './api';
import { getCharacterLayers } from './character';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getCharacterLayers', () => {
  it('resolves layer URLs against the backend API origin', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(DEFAULT_SPRITE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const layers = await getCharacterLayers();

    expect(layers.root).toBe(apiUrl('/api/character/assets'));
  });
});
