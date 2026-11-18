import type { CharacterProfile, CharacterState, CharacterTerms } from '../types/character';
import type { SpriteConfig } from '../lib/spriteLayers';
import { apiUrl, request } from './api';

export function getCharacter(signal?: AbortSignal): Promise<CharacterProfile> {
  return request<CharacterProfile>('/api/character', { signal });
}

export function getCharacterTerms(signal?: AbortSignal): Promise<CharacterTerms> {
  return request<CharacterTerms>('/api/character/terms', { signal });
}

export function getCharacterState(signal?: AbortSignal): Promise<CharacterState> {
  return request<CharacterState>('/api/character/state', { signal });
}

export function getCharacterLayers(signal?: AbortSignal): Promise<SpriteConfig> {
  return request<SpriteConfig>('/api/character/layers', { signal }).then((sprite) => ({
    ...sprite,
    root: apiUrl(sprite.root),
  }));
}
