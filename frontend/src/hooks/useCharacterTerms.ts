import { useEffect, useState } from 'react';
import { errorText } from '../lib/errors';
import { getCharacterTerms } from '../services/character';
import type { CharacterTerms } from '../types/character';

export function useCharacterTerms() {
  const [terms, setTerms] = useState<CharacterTerms | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    getCharacterTerms(abort.signal)
      .then((next) => {
        if (!abort.signal.aborted) setTerms(next);
      })
      .catch((caught) => {
        if (!abort.signal.aborted) setError(errorText(caught));
      });
    return () => abort.abort();
  }, []);

  return { terms, error, loading: terms === null && error === null };
}
