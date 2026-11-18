import { clampSpriteOverlap } from './spriteOverlap';
import { applyThemeColor } from './themeColor';

export type Scheme = 'device' | 'light' | 'dark';

export type Preferences = {
  debug: boolean;
  debugExpand: boolean;
  scheme: Scheme;
  hue: number;
  characterTheme: boolean;
  spriteFade: number;
  spriteOverlap: number | null;
  spriteDebugOverlap: number | null;
  spriteDebugFade: number | null;
  spriteDebugBgOpacity: number | null;
  messageBgOpacity: number;
  foregroundOpacity: number;
  insecureNoticeDismissed: boolean;
};

const DEBUG_KEY = 'remorise.debug';
const DEBUG_EXPAND_KEY = 'remorise.debug-expand';
const SCHEME_KEY = 'remorise.scheme';
const HUE_KEY = 'remorise.hue';
const CHARACTER_THEME_KEY = 'remorise.character-theme';
const SPRITE_FADE_KEY = 'remorise.sprite-fade';
const SPRITE_OVERLAP_KEY = 'remorise.sprite-overlap';
// The sprite debug page's own boundary: the same kind of overlap as
// the chat's, but stored apart so tuning one never moves the other.
const SPRITE_DEBUG_OVERLAP_KEY = 'remorise.sprite-debug-overlap';
// The sprite debug page's own blend settings. Null follows the
// chat's values, so the debug page only diverges where it was
// tuned on purpose.
const SPRITE_DEBUG_FADE_KEY = 'remorise.sprite-debug-fade';
const SPRITE_DEBUG_BG_OPACITY_KEY = 'remorise.sprite-debug-bg-opacity';
const MESSAGE_BG_OPACITY_KEY = 'remorise.message-bg-opacity';
const FOREGROUND_OPACITY_KEY = 'remorise.foreground-opacity';
// Whether the reader has closed the plain-http notice on the chat
// page. The settings page shows the notice regardless of this flag.
const INSECURE_NOTICE_DISMISSED_KEY = 'remorise.insecure-notice-dismissed';
// The first height-adjust mode stored a sprite box height under this
// key; that meaning is gone, so the key is removed on load and its
// value never read as an overlap.
const LEGACY_SPRITE_SPLIT_KEY = 'remorise.sprite-split';
const DEFAULT_HUE = 314;
export const DEFAULT_SPRITE_FADE = 20;
// The message column's background opacity over the sprite. The floor
// keeps the panel color doing real work: at 50% it still halves the
// contrast of whatever stands behind the text, while below it the
// sprite's detail starts competing with the words directly.
export const MESSAGE_BG_OPACITY_MIN = 50;
export const DEFAULT_MESSAGE_BG_OPACITY = 75;
// The foreground (text and items) opacity shares the background's
// floor: the words may melt into the sprite as far as the panel
// behind them does, but never further.
export const FOREGROUND_OPACITY_MIN = MESSAGE_BG_OPACITY_MIN;
export const DEFAULT_FOREGROUND_OPACITY = 100;

const listeners = new Set<() => void>();

let prefs = readStored();

// The active character's theme hue, handed over when its profile
// loads. It is never persisted: it belongs to the character, so a
// stored copy would follow the reader into the next character.
let characterHue: number | null = null;

export function getPreferences(): Preferences {
  return prefs;
}

export function getCharacterHue(): number | null {
  return characterHue;
}

export function setCharacterHue(hue: number | null): void {
  const next = hue === null || !Number.isFinite(hue) ? null : clampHue(hue);
  if (next === characterHue) return;
  characterHue = next;
  applyTheme(prefs);
  for (const listener of listeners) listener();
}

function effectiveHue(value: Preferences): number {
  if (!value.characterTheme) return value.hue;
  // A character without a theme hue falls back to the default hue,
  // not the reader's stored one: while the character theme is on,
  // the manual hue is simply out of the picture, slider included.
  return characterHue ?? DEFAULT_HUE;
}

export function getEffectiveHue(): number {
  return effectiveHue(prefs);
}

export function applyStoredTheme(): void {
  applyTheme(prefs);
  watchDeviceScheme();
}

let deviceSchemeWatched = false;

function watchDeviceScheme(): void {
  if (deviceSchemeWatched) return;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  deviceSchemeWatched = true;
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (prefs.scheme === 'device') applyThemeColor(effectiveHue(prefs), prefs.scheme);
  });
}

export function setPreferences(patch: Partial<Preferences>): void {
  const next = { ...prefs, ...patch };
  if (!isScheme(next.scheme)) next.scheme = 'device';
  next.hue = clampHue(next.hue);
  next.spriteFade = clampSpriteFade(next.spriteFade);
  next.spriteOverlap = next.spriteOverlap === null ? null : clampSpriteOverlap(next.spriteOverlap);
  next.spriteDebugOverlap =
    next.spriteDebugOverlap === null ? null : clampSpriteOverlap(next.spriteDebugOverlap);
  next.spriteDebugFade =
    next.spriteDebugFade === null ? null : clampSpriteFade(next.spriteDebugFade);
  next.spriteDebugBgOpacity =
    next.spriteDebugBgOpacity === null ? null : clampMessageBgOpacity(next.spriteDebugBgOpacity);
  next.messageBgOpacity = clampMessageBgOpacity(next.messageBgOpacity);
  next.foregroundOpacity = clampForegroundOpacity(next.foregroundOpacity);
  prefs = next;
  localStorage.setItem(DEBUG_KEY, next.debug ? '1' : '0');
  localStorage.setItem(DEBUG_EXPAND_KEY, next.debugExpand ? '1' : '0');
  localStorage.setItem(SCHEME_KEY, next.scheme);
  localStorage.setItem(HUE_KEY, String(next.hue));
  localStorage.setItem(CHARACTER_THEME_KEY, next.characterTheme ? '1' : '0');
  localStorage.setItem(SPRITE_FADE_KEY, String(next.spriteFade));
  if (next.spriteOverlap === null) localStorage.removeItem(SPRITE_OVERLAP_KEY);
  else localStorage.setItem(SPRITE_OVERLAP_KEY, String(next.spriteOverlap));
  if (next.spriteDebugOverlap === null) localStorage.removeItem(SPRITE_DEBUG_OVERLAP_KEY);
  else localStorage.setItem(SPRITE_DEBUG_OVERLAP_KEY, String(next.spriteDebugOverlap));
  if (next.spriteDebugFade === null) localStorage.removeItem(SPRITE_DEBUG_FADE_KEY);
  else localStorage.setItem(SPRITE_DEBUG_FADE_KEY, String(next.spriteDebugFade));
  if (next.spriteDebugBgOpacity === null) localStorage.removeItem(SPRITE_DEBUG_BG_OPACITY_KEY);
  else localStorage.setItem(SPRITE_DEBUG_BG_OPACITY_KEY, String(next.spriteDebugBgOpacity));
  localStorage.setItem(MESSAGE_BG_OPACITY_KEY, String(next.messageBgOpacity));
  localStorage.setItem(FOREGROUND_OPACITY_KEY, String(next.foregroundOpacity));
  localStorage.setItem(INSECURE_NOTICE_DISMISSED_KEY, next.insecureNoticeDismissed ? '1' : '0');
  applyTheme(next);
  for (const listener of listeners) listener();
}

export function subscribePreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readStored(): Preferences {
  let debug = false;
  let debugExpand = false;
  let scheme: Scheme = 'device';
  let hue = DEFAULT_HUE;
  let characterTheme = true;
  let spriteFade = DEFAULT_SPRITE_FADE;
  let spriteOverlap: number | null = null;
  let spriteDebugOverlap: number | null = null;
  let spriteDebugFade: number | null = null;
  let spriteDebugBgOpacity: number | null = null;
  let messageBgOpacity = DEFAULT_MESSAGE_BG_OPACITY;
  let foregroundOpacity = DEFAULT_FOREGROUND_OPACITY;
  let insecureNoticeDismissed = false;
  try {
    debug = localStorage.getItem(DEBUG_KEY) === '1';
    insecureNoticeDismissed = localStorage.getItem(INSECURE_NOTICE_DISMISSED_KEY) === '1';
    debugExpand = localStorage.getItem(DEBUG_EXPAND_KEY) === '1';
    const storedScheme = localStorage.getItem(SCHEME_KEY);
    if (isScheme(storedScheme)) scheme = storedScheme;
    const storedHue = localStorage.getItem(HUE_KEY);
    hue = storedHue === null || storedHue === '' ? DEFAULT_HUE : clampHue(Number(storedHue));
    characterTheme = localStorage.getItem(CHARACTER_THEME_KEY) !== '0';
    localStorage.removeItem(LEGACY_SPRITE_SPLIT_KEY);
    const storedFade = localStorage.getItem(SPRITE_FADE_KEY);
    if (storedFade !== null && storedFade !== '') {
      const parsed = Number(storedFade);
      if (Number.isFinite(parsed)) spriteFade = clampSpriteFade(parsed);
    }
    const storedOverlap = localStorage.getItem(SPRITE_OVERLAP_KEY);
    if (storedOverlap !== null && storedOverlap !== '') {
      const parsed = Number(storedOverlap);
      if (Number.isFinite(parsed)) spriteOverlap = clampSpriteOverlap(parsed);
    }
    const storedDebugOverlap = localStorage.getItem(SPRITE_DEBUG_OVERLAP_KEY);
    if (storedDebugOverlap !== null && storedDebugOverlap !== '') {
      const parsed = Number(storedDebugOverlap);
      if (Number.isFinite(parsed)) spriteDebugOverlap = clampSpriteOverlap(parsed);
    }
    const storedDebugFade = localStorage.getItem(SPRITE_DEBUG_FADE_KEY);
    if (storedDebugFade !== null && storedDebugFade !== '') {
      const parsed = Number(storedDebugFade);
      if (Number.isFinite(parsed)) spriteDebugFade = clampSpriteFade(parsed);
    }
    const storedDebugBgOpacity = localStorage.getItem(SPRITE_DEBUG_BG_OPACITY_KEY);
    if (storedDebugBgOpacity !== null && storedDebugBgOpacity !== '') {
      const parsed = Number(storedDebugBgOpacity);
      if (Number.isFinite(parsed)) spriteDebugBgOpacity = clampMessageBgOpacity(parsed);
    }
    const storedBgOpacity = localStorage.getItem(MESSAGE_BG_OPACITY_KEY);
    if (storedBgOpacity !== null && storedBgOpacity !== '') {
      messageBgOpacity = clampMessageBgOpacity(Number(storedBgOpacity));
    }
    const storedForegroundOpacity = localStorage.getItem(FOREGROUND_OPACITY_KEY);
    if (storedForegroundOpacity !== null && storedForegroundOpacity !== '') {
      foregroundOpacity = clampForegroundOpacity(Number(storedForegroundOpacity));
    }
  } catch {
    // Private mode can block storage. The defaults still theme the page.
  }
  return {
    debug,
    debugExpand,
    scheme,
    hue,
    characterTheme,
    spriteFade,
    spriteOverlap,
    spriteDebugOverlap,
    spriteDebugFade,
    spriteDebugBgOpacity,
    messageBgOpacity,
    foregroundOpacity,
    insecureNoticeDismissed,
  };
}

function applyTheme(value: Preferences): void {
  document.documentElement.dataset.scheme = value.scheme;
  const hue = effectiveHue(value);
  document.documentElement.style.setProperty('--hue', String(hue));
  applyThemeColor(hue, value.scheme);
}

function isScheme(value: string | null | undefined): value is Scheme {
  return value === 'device' || value === 'light' || value === 'dark';
}

function clampPreference(
  value: number,
  min: number,
  max: number,
  fallback: number,
  round: boolean,
): number {
  if (!Number.isFinite(value)) return fallback;
  const prepared = round ? Math.round(value) : value;
  return Math.min(max, Math.max(min, prepared));
}

function clampHue(value: number): number {
  return clampPreference(value, 0, 360, DEFAULT_HUE, false);
}

function clampMessageBgOpacity(value: number): number {
  return clampPreference(value, MESSAGE_BG_OPACITY_MIN, 100, DEFAULT_MESSAGE_BG_OPACITY, true);
}

function clampSpriteFade(value: number): number {
  return clampPreference(value, 0, 100, DEFAULT_SPRITE_FADE, true);
}

function clampForegroundOpacity(value: number): number {
  return clampPreference(value, FOREGROUND_OPACITY_MIN, 100, DEFAULT_FOREGROUND_OPACITY, true);
}
