import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store reads localStorage once at module load, so each case
// reloads the module against a prepared storage.
async function loadPreferences() {
  vi.resetModules();
  return import('./preferences');
}

beforeEach(() => {
  localStorage.clear();
});

describe('preferences: sprite overlap', () => {
  it('defaults to no stored overlap', async () => {
    const { getPreferences } = await loadPreferences();
    expect(getPreferences().spriteOverlap).toBeNull();
  });

  it('restores a stored overlap', async () => {
    localStorage.setItem('remorise.sprite-overlap', '42');
    const { getPreferences } = await loadPreferences();
    expect(getPreferences().spriteOverlap).toBe(42);
  });

  it('repairs out-of-range stored values on load', async () => {
    localStorage.setItem('remorise.sprite-overlap', '3');
    const { getPreferences } = await loadPreferences();
    expect(getPreferences().spriteOverlap).toBe(15);
  });

  it('persists writes and clamps them', async () => {
    const { getPreferences, setPreferences } = await loadPreferences();
    setPreferences({ spriteOverlap: 63 });
    expect(getPreferences().spriteOverlap).toBe(63);
    expect(localStorage.getItem('remorise.sprite-overlap')).toBe('63');
    setPreferences({ spriteOverlap: 100 });
    expect(getPreferences().spriteOverlap).toBe(85);
    setPreferences({ spriteOverlap: 0 });
    expect(getPreferences().spriteOverlap).toBe(15);
  });

  it('clears the stored overlap when set back to null', async () => {
    const { getPreferences, setPreferences } = await loadPreferences();
    setPreferences({ spriteOverlap: 40 });
    expect(localStorage.getItem('remorise.sprite-overlap')).toBe('40');
    setPreferences({ spriteOverlap: null });
    expect(getPreferences().spriteOverlap).toBeNull();
    expect(localStorage.getItem('remorise.sprite-overlap')).toBeNull();
  });

  it('defaults the message background opacity to fully opaque', async () => {
    const { getPreferences } = await loadPreferences();
    expect(getPreferences().messageBgOpacity).toBe(100);
  });

  it('restores a stored message background opacity', async () => {
    localStorage.setItem('remorise.message-bg-opacity', '70');
    const { getPreferences } = await loadPreferences();
    expect(getPreferences().messageBgOpacity).toBe(70);
  });

  it('repairs a stored message background opacity outside the floor and ceiling', async () => {
    localStorage.setItem('remorise.message-bg-opacity', '30');
    const below = await loadPreferences();
    expect(below.getPreferences().messageBgOpacity).toBe(50);
    localStorage.setItem('remorise.message-bg-opacity', '140');
    const above = await loadPreferences();
    expect(above.getPreferences().messageBgOpacity).toBe(100);
  });

  it('persists message background opacity writes and clamps them to the floor', async () => {
    const { getPreferences, setPreferences } = await loadPreferences();
    setPreferences({ messageBgOpacity: 20 });
    expect(getPreferences().messageBgOpacity).toBe(50);
    expect(localStorage.getItem('remorise.message-bg-opacity')).toBe('50');
    setPreferences({ messageBgOpacity: 120 });
    expect(getPreferences().messageBgOpacity).toBe(100);
    expect(localStorage.getItem('remorise.message-bg-opacity')).toBe('100');
    setPreferences({ messageBgOpacity: 75 });
    expect(getPreferences().messageBgOpacity).toBe(75);
  });

  it('drops the legacy sprite-split value instead of reading it as an overlap', async () => {
    // The old key held a sprite box height (a different meaning);
    // its value must neither load as an overlap nor survive.
    localStorage.setItem('remorise.sprite-split', '80');
    const { getPreferences } = await loadPreferences();
    expect(getPreferences().spriteOverlap).toBeNull();
    expect(localStorage.getItem('remorise.sprite-split')).toBeNull();
  });

  it('defaults the gradient length to 50%', async () => {
    const { getPreferences } = await loadPreferences();
    expect(getPreferences().spriteFade).toBe(50);
  });

  it('restores, persists, and clamps the gradient length', async () => {
    localStorage.setItem('remorise.sprite-fade', '25');
    const { getPreferences, setPreferences } = await loadPreferences();
    expect(getPreferences().spriteFade).toBe(25);
    setPreferences({ spriteFade: 140 });
    expect(getPreferences().spriteFade).toBe(100);
    expect(localStorage.getItem('remorise.sprite-fade')).toBe('100');
    setPreferences({ spriteFade: -5 });
    expect(getPreferences().spriteFade).toBe(0);
  });

  it('defaults the foreground opacity to fully opaque and clamps it to the background floor', async () => {
    const { getPreferences, setPreferences } = await loadPreferences();
    expect(getPreferences().foregroundOpacity).toBe(100);
    setPreferences({ foregroundOpacity: 30 });
    expect(getPreferences().foregroundOpacity).toBe(50);
    expect(localStorage.getItem('remorise.foreground-opacity')).toBe('50');
    setPreferences({ foregroundOpacity: 75 });
    expect(getPreferences().foregroundOpacity).toBe(75);
  });

  it('restores a stored foreground opacity', async () => {
    localStorage.setItem('remorise.foreground-opacity', '70');
    const { getPreferences } = await loadPreferences();
    expect(getPreferences().foregroundOpacity).toBe(70);
  });
});

describe('preferences: sprite debug blend', () => {
  it('defaults both debug blend values to unset, so the chat values apply', async () => {
    const { getPreferences } = await loadPreferences();
    expect(getPreferences().spriteDebugFade).toBeNull();
    expect(getPreferences().spriteDebugBgOpacity).toBeNull();
  });

  it('restores, persists, clamps, and clears the debug gradient length under its own key', async () => {
    localStorage.setItem('remorise.sprite-debug-fade', '80');
    const { getPreferences, setPreferences } = await loadPreferences();
    expect(getPreferences().spriteDebugFade).toBe(80);
    setPreferences({ spriteDebugFade: 140 });
    expect(getPreferences().spriteDebugFade).toBe(100);
    expect(localStorage.getItem('remorise.sprite-debug-fade')).toBe('100');
    expect(getPreferences().spriteFade).toBe(50);
    setPreferences({ spriteDebugFade: null });
    expect(getPreferences().spriteDebugFade).toBeNull();
    expect(localStorage.getItem('remorise.sprite-debug-fade')).toBeNull();
  });

  it('restores, persists, clamps, and clears the debug background opacity under its own key', async () => {
    localStorage.setItem('remorise.sprite-debug-bg-opacity', '66');
    const { getPreferences, setPreferences } = await loadPreferences();
    expect(getPreferences().spriteDebugBgOpacity).toBe(66);
    setPreferences({ spriteDebugBgOpacity: 10 });
    expect(getPreferences().spriteDebugBgOpacity).toBe(50);
    expect(localStorage.getItem('remorise.sprite-debug-bg-opacity')).toBe('50');
    expect(getPreferences().messageBgOpacity).toBe(100);
    setPreferences({ spriteDebugBgOpacity: null });
    expect(getPreferences().spriteDebugBgOpacity).toBeNull();
    expect(localStorage.getItem('remorise.sprite-debug-bg-opacity')).toBeNull();
  });
});

describe('preferences: character theme', () => {
  it('defaults the character theme to on and persists the flag under its own key', async () => {
    const { getPreferences, setPreferences } = await loadPreferences();
    expect(getPreferences().characterTheme).toBe(true);
    setPreferences({ characterTheme: false });
    expect(getPreferences().characterTheme).toBe(false);
    expect(localStorage.getItem('remorise.character-theme')).toBe('0');
    setPreferences({ characterTheme: true });
    expect(localStorage.getItem('remorise.character-theme')).toBe('1');
  });

  it('restores a stored off flag', async () => {
    localStorage.setItem('remorise.character-theme', '0');
    const { getPreferences } = await loadPreferences();
    expect(getPreferences().characterTheme).toBe(false);
  });

  it('drives --hue from the character hue while on, without storing it as the reader hue', async () => {
    localStorage.setItem('remorise.hue', '100');
    const { getPreferences, setCharacterHue } = await loadPreferences();
    setCharacterHue(200);
    expect(document.documentElement.style.getPropertyValue('--hue')).toBe('200');
    expect(getPreferences().hue).toBe(100);
    expect(localStorage.getItem('remorise.hue')).toBe('100');
  });

  it('falls back to the default hue when the character has none, and to the stored hue when off', async () => {
    localStorage.setItem('remorise.hue', '100');
    const { setCharacterHue, setPreferences } = await loadPreferences();
    setCharacterHue(200);
    setCharacterHue(null);
    expect(document.documentElement.style.getPropertyValue('--hue')).toBe('314');
    setCharacterHue(200);
    setPreferences({ characterTheme: false });
    expect(document.documentElement.style.getPropertyValue('--hue')).toBe('100');
    setPreferences({ characterTheme: true });
    expect(document.documentElement.style.getPropertyValue('--hue')).toBe('200');
  });
});

describe('preferences: sprite debug overlap', () => {
  it('defaults to no stored debug overlap', async () => {
    const { getPreferences } = await loadPreferences();
    expect(getPreferences().spriteDebugOverlap).toBeNull();
  });

  it('restores, persists, clamps, and clears under its own key', async () => {
    localStorage.setItem('remorise.sprite-debug-overlap', '58');
    const { getPreferences, setPreferences } = await loadPreferences();
    expect(getPreferences().spriteDebugOverlap).toBe(58);
    setPreferences({ spriteDebugOverlap: 100 });
    expect(getPreferences().spriteDebugOverlap).toBe(85);
    expect(localStorage.getItem('remorise.sprite-debug-overlap')).toBe('85');
    setPreferences({ spriteDebugOverlap: null });
    expect(getPreferences().spriteDebugOverlap).toBeNull();
    expect(localStorage.getItem('remorise.sprite-debug-overlap')).toBeNull();
  });

  it('never touches the chat overlap, and the chat overlap never touches it', async () => {
    const { getPreferences, setPreferences } = await loadPreferences();
    setPreferences({ spriteDebugOverlap: 63 });
    expect(getPreferences().spriteOverlap).toBeNull();
    expect(localStorage.getItem('remorise.sprite-overlap')).toBeNull();
    setPreferences({ spriteOverlap: 33 });
    expect(getPreferences().spriteDebugOverlap).toBe(63);
    expect(localStorage.getItem('remorise.sprite-debug-overlap')).toBe('63');
  });
});
