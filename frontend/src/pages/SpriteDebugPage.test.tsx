import { cleanup, fireEvent, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpriteDebugPage } from './SpriteDebugPage';
import { useCharacter } from '../hooks/useCharacter';
import { getPreferences, setPreferences } from '../lib/preferences';
import { DEFAULT_SPRITE } from '../lib/spriteLayers';

vi.mock('../hooks/useCharacter', () => ({ useCharacter: vi.fn() }));
vi.mock('../services/settings', () => ({
  getServerSettings: vi.fn().mockResolvedValue({}),
  updateServerSettings: vi.fn().mockResolvedValue({}),
}));
vi.mock('../components/character/CharacterSprite', async () => {
  const { createElement, useEffect } = await import('react');
  const { allSpriteLayerUrls } = await import('../lib/spriteLayers');
  return {
    CharacterSprite: ({
      sprite,
      onAssetsLoaded,
    }: {
      sprite: typeof DEFAULT_SPRITE;
      onAssetsLoaded?: (assets: ReadonlySet<string>) => void;
    }) => {
      useEffect(
        () => onAssetsLoaded?.(new Set(allSpriteLayerUrls(sprite))),
        [onAssetsLoaded, sprite],
      );
      return createElement('div', { 'data-testid': 'sprite' });
    },
  };
});

function renderPage() {
  return render(
    <MemoryRouter>
      <SpriteDebugPage />
    </MemoryRouter>,
  );
}

function mainElement(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[style*="--message-bg-opacity"]');
}

let clientHeightStubbed = false;
function stubClientHeight(px: number) {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => px,
  });
  clientHeightStubbed = true;
}

beforeEach(() => {
  localStorage.clear();
  setPreferences({
    spriteOverlap: null,
    spriteDebugOverlap: null,
    spriteFade: 50,
    spriteDebugFade: null,
    spriteDebugBgOpacity: null,
    messageBgOpacity: 100,
    foregroundOpacity: 100,
  });
  vi.mocked(useCharacter).mockReturnValue({
    layers: { ...DEFAULT_SPRITE, available: true },
  } as unknown as ReturnType<typeof useCharacter>);
});

afterEach(() => {
  cleanup();
  if (clientHeightStubbed) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    clientHeightStubbed = false;
  }
});

describe('SpriteDebugPage sprite/control overlap', () => {
  it('lets you select open eye and mouth states without overlay images', () => {
    const sprite = {
      ...DEFAULT_SPRITE,
      poses: { still: ['body.png'] },
      expressions: { normal: { base: 'face.png', mouth: [null, null, null] } },
      emotions: {
        neutral: { pose: 'still', expression: 'normal', mark: null, extras: [], tears: false },
      },
    };
    // A shared-only character: DEFAULT_SPRITE carries empty split
    // lists, which would select split mode under the either/or rule.
    delete sprite.eyes_left;
    delete sprite.eyes_right;
    delete sprite.tears_left;
    delete sprite.tears_right;
    vi.mocked(useCharacter).mockReturnValue({
      layers: { ...sprite, available: true },
    } as unknown as ReturnType<typeof useCharacter>);
    const { getByLabelText } = renderPage();
    const eyes = getByLabelText('目') as HTMLSelectElement;
    const mouth = getByLabelText('口') as HTMLSelectElement;
    expect(eyes.disabled).toBe(false);
    expect(mouth.disabled).toBe(false);
    fireEvent.change(eyes, { target: { value: 'open' } });
    fireEvent.change(mouth, { target: { value: 'open' } });
    expect(eyes.value).toBe('open');
    expect(mouth.value).toBe('open');
  });

  it('offers per-side eye selects for split eyes and gates blinking on both open', () => {
    const sprite = {
      ...DEFAULT_SPRITE,
      poses: { still: ['body.png'] },
      expressions: { normal: { base: 'face.png', mouth: [null, null, null] } },
      eyes_left: [['left-open.png'], ['left-half.png'], ['left-closed.png']],
      eyes_right: [['right-open.png'], ['right-half.png'], ['right-closed.png']],
      emotions: {
        neutral: { pose: 'still', expression: 'normal', mark: null, extras: [], tears: false },
      },
    };
    vi.mocked(useCharacter).mockReturnValue({
      layers: { ...sprite, available: true },
    } as unknown as ReturnType<typeof useCharacter>);
    const { getByLabelText } = renderPage();
    const left = getByLabelText('左目') as HTMLSelectElement;
    const right = getByLabelText('右目') as HTMLSelectElement;
    const blink = getByLabelText('瞬き') as HTMLInputElement;
    expect(blink.disabled).toBe(false);
    fireEvent.change(left, { target: { value: 'closed' } });
    expect(left.value).toBe('closed');
    expect(right.value).toBe('open');
    expect(blink.disabled).toBe(true);
  });

  it('applies the selected emotion appearance to all corresponding controls', () => {
    const sprite = {
      ...DEFAULT_SPRITE,
      poses: { still: ['body.png'], arms: ['arms.png'] },
      expressions: {
        normal: { base: 'normal.png', mouth: [null, null, null] },
        happy: { base: 'happy.png', mouth: [null, null, null] },
      },
      marks: { happy: 'happy-mark.png' },
      extras: { sweat: 'sweat.png' },
      emotions: {
        neutral: { pose: 'still', expression: 'normal', mark: null, extras: [], tears: false },
        happy: { pose: 'arms', expression: 'happy', mark: 'happy', extras: ['sweat'], tears: true },
      },
    };
    vi.mocked(useCharacter).mockReturnValue({
      layers: { ...sprite, available: true },
    } as unknown as ReturnType<typeof useCharacter>);
    const { getByLabelText, getByRole } = renderPage();
    fireEvent.change(getByLabelText('感情プリセット'), { target: { value: 'happy' } });
    fireEvent.click(getByRole('button', { name: 'プリセットを適用' }));
    expect((getByLabelText('ポーズ') as HTMLSelectElement).value).toBe('arms');
    expect((getByLabelText('表情') as HTMLSelectElement).value).toBe('happy');
    expect((getByLabelText('マーク') as HTMLSelectElement).value).toBe('happy');
    expect((getByLabelText('汗') as HTMLInputElement).checked).toBe(true);
    expect((getByLabelText('涙') as HTMLInputElement).checked).toBe(true);
  });

  it('shows the boundary handle only in adjust mode, toggled from the header', () => {
    const { container } = renderPage();
    expect(container.querySelector('[role="slider"]')).toBeNull();
    const toggle = container.querySelector('button[aria-label="立ち絵の高さを調整"]');
    expect(toggle).toBeTruthy();
    if (!toggle) return;
    fireEvent.click(toggle);
    expect(container.querySelector('[role="slider"]')).toBeTruthy();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    const end = container.querySelector('button[aria-label="高さ調整を終わる"]');
    if (!end) throw new Error('end toggle missing');
    fireEvent.click(end);
    expect(container.querySelector('[role="slider"]')).toBeNull();
  });

  it('rests the handle at the default overlap without storing anything', () => {
    const { container } = renderPage();
    const toggle = container.querySelector('button[aria-label="立ち絵の高さを調整"]');
    if (!toggle) throw new Error('toggle missing');
    fireEvent.click(toggle);
    const handle = container.querySelector('[role="slider"]');
    if (!handle) throw new Error('handle missing');
    expect(handle.getAttribute('aria-valuenow')).toBe('40');
    expect(getPreferences().spriteDebugOverlap).toBeNull();
    expect(mainElement(container)?.style.getPropertyValue('--sprite-overlap')).toBe('');
  });

  it('applies a stored debug overlap as its own variable', () => {
    setPreferences({ spriteDebugOverlap: 70 });
    const { container } = renderPage();
    expect(mainElement(container)?.style.getPropertyValue('--sprite-overlap')).toBe(
      'calc(var(--sprite-h) * 0.7)',
    );
    expect(mainElement(container)?.style.getPropertyValue('--message-bg-opacity')).toBe('100%');
  });

  it('drags the boundary into a stored, clamped debug overlap and leaves the chat value alone', () => {
    stubClientHeight(500);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          top: 0,
          left: 0,
          right: 400,
          bottom: 1000,
          width: 400,
          height: 1000,
          x: 0,
          y: 0,
          toJSON: () => {},
        }) as DOMRect,
    );
    try {
      const { container } = renderPage();
      const toggle = container.querySelector('button[aria-label="立ち絵の高さを調整"]');
      if (!toggle) throw new Error('toggle missing');
      fireEvent.click(toggle);
      const handle = container.querySelector('[role="slider"]');
      if (!handle) throw new Error('handle missing');

      fireEvent.pointerDown(handle, { clientY: 200 });
      fireEvent.pointerMove(window, { clientY: 200 });
      expect(getPreferences().spriteDebugOverlap).toBe(60);
      expect(handle.getAttribute('aria-valuenow')).toBe('60');
      expect(getPreferences().spriteOverlap).toBeNull();
      expect(localStorage.getItem('remorise.sprite-overlap')).toBeNull();
      expect(localStorage.getItem('remorise.sprite-debug-overlap')).toBe('60');

      fireEvent.pointerMove(window, { clientY: 0 });
      expect(getPreferences().spriteDebugOverlap).toBe(85);
      fireEvent.pointerMove(window, { clientY: 600 });
      expect(getPreferences().spriteDebugOverlap).toBe(15);
      fireEvent.pointerUp(window);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('adjusts the debug overlap with the arrow keys and leaves the chat value alone', () => {
    setPreferences({ spriteDebugOverlap: 50 });
    const { container } = renderPage();
    const toggle = container.querySelector('button[aria-label="立ち絵の高さを調整"]');
    if (!toggle) throw new Error('toggle missing');
    fireEvent.click(toggle);
    const handle = container.querySelector('[role="slider"]');
    if (!handle) throw new Error('handle missing');
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(getPreferences().spriteDebugOverlap).toBe(52);
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(getPreferences().spriteDebugOverlap).toBe(48);
    expect(getPreferences().spriteOverlap).toBeNull();
  });
});

describe('SpriteDebugPage display settings popup', () => {
  function openPopup(container: HTMLElement) {
    const toggle = container.querySelector('button[aria-label="表示設定"]');
    if (!toggle) throw new Error('display settings toggle missing');
    fireEvent.click(toggle);
  }

  function popupRange(container: HTMLElement, labelText: string) {
    const labels = [...container.querySelectorAll('label')];
    const label = labels.find((el) => el.textContent?.includes(labelText));
    const input = label?.querySelector<HTMLInputElement>('input[type="range"]');
    if (!input) throw new Error(`range for ${labelText} missing`);
    return input;
  }

  it('opens from the header and starts from the chat values', () => {
    const { container } = renderPage();
    expect(container.textContent).not.toContain('この画面専用の表示設定です');
    openPopup(container);
    expect(container.textContent).toContain('この画面専用の表示設定です');
    expect(popupRange(container, 'グラデーションの長さ').value).toBe('50');
    expect(popupRange(container, '背景の不透明度').value).toBe('100');
  });

  it('hands the chat blend values to the layout while the debug values are unset', () => {
    setPreferences({ spriteFade: 30, messageBgOpacity: 70 });
    const { container } = renderPage();
    expect(mainElement(container)?.style.getPropertyValue('--sprite-fade')).toBe('30%');
    expect(mainElement(container)?.style.getPropertyValue('--message-bg-opacity')).toBe('70%');
  });

  it('writes only the debug values from the popup sliders', () => {
    const { container } = renderPage();
    openPopup(container);
    fireEvent.change(popupRange(container, 'グラデーションの長さ'), { target: { value: '80' } });
    expect(getPreferences().spriteDebugFade).toBe(80);
    expect(getPreferences().spriteFade).toBe(50);
    expect(mainElement(container)?.style.getPropertyValue('--sprite-fade')).toBe('80%');
    fireEvent.change(popupRange(container, '背景の不透明度'), { target: { value: '60' } });
    expect(getPreferences().spriteDebugBgOpacity).toBe(60);
    expect(getPreferences().messageBgOpacity).toBe(100);
    expect(mainElement(container)?.style.getPropertyValue('--message-bg-opacity')).toBe('60%');
  });

  it('resets the debug blend values back to following the chat', () => {
    setPreferences({ spriteDebugFade: 80, spriteDebugBgOpacity: 60 });
    const { container } = renderPage();
    openPopup(container);
    const reset = [...container.querySelectorAll('button')].find(
      (el) => el.textContent === 'チャットに合わせる',
    );
    if (!reset) throw new Error('reset button missing');
    fireEvent.click(reset);
    expect(getPreferences().spriteDebugFade).toBeNull();
    expect(getPreferences().spriteDebugBgOpacity).toBeNull();
    expect(mainElement(container)?.style.getPropertyValue('--sprite-fade')).toBe('50%');
    expect(mainElement(container)?.style.getPropertyValue('--message-bg-opacity')).toBe('100%');
  });

  it('hands the foreground opacity to the layout and marks the controls with fg-items', () => {
    setPreferences({ foregroundOpacity: 60 });
    const { container } = renderPage();
    expect(mainElement(container)?.style.getPropertyValue('--fg-opacity')).toBe('60%');
    expect(container.querySelector('form')?.classList.contains('fg-items')).toBe(true);
  });
});
