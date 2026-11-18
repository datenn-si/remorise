import { useCallback, useEffect, useState } from 'react';
import { errorText } from '../lib/errors';
import { setCharacterHue } from '../lib/preferences';
import { getCharacter, getCharacterLayers, getCharacterState } from '../services/character';
import type { CharacterProfile, CharacterState } from '../types/character';
import type { SpriteConfig } from '../lib/spriteLayers';

export function useCharacter() {
  const [profile, setProfile] = useState<CharacterProfile | null>(null);
  const [state, setState] = useState<CharacterState | null>(null);
  const [layers, setLayers] = useState<SpriteConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [nextProfile, nextState, nextLayers] = await Promise.all([
        getCharacter(signal),
        getCharacterState(signal),
        getCharacterLayers(signal),
      ]);
      if (signal?.aborted) return;
      setCharacterHue(nextProfile.theme_hue ?? null);
      setProfile(nextProfile);
      setState(nextState);
      setLayers(nextLayers);
      setError(null);
    } catch (caught) {
      if (signal?.aborted) return;
      const text = errorText(caught);
      if (text) setError(text);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load]);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    return load();
  }, [load]);

  return { profile, state, layers, setState, error, loading, reload };
}
