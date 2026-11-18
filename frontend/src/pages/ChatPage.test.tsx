import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPage } from './ChatPage';
import { useCharacter } from '../hooks/useCharacter';
import { useChat } from '../hooks/useChat';
import { useHealth } from '../hooks/useHealth';
import { getPreferences, setPreferences } from '../lib/preferences';
import { DEFAULT_SPRITE } from '../lib/spriteLayers';
import { getServerSettings } from '../services/settings';

vi.mock('../hooks/useCharacter', () => ({ useCharacter: vi.fn() }));
vi.mock('../hooks/useChat', () => ({ useChat: vi.fn() }));
vi.mock('../hooks/useHealth', () => ({ useHealth: vi.fn(() => true) }));
vi.mock('../hooks/useInferenceStatus', () => ({ useInferenceStatus: () => null }));
vi.mock('../hooks/useFullscreen', () => ({
  useFullscreen: () => ({ supported: false, fullscreen: false, toggle: () => {} }),
}));
vi.mock('../hooks/useViewportShift', () => ({ useViewportShift: () => {} }));
vi.mock('../services/settings', () => ({
  getServerSettings: vi.fn().mockResolvedValue({}),
}));
vi.mock('../services/debug', () => ({
  getDebugSummaries: vi.fn().mockResolvedValue([]),
  listDebugJobs: vi.fn().mockResolvedValue([]),
}));
vi.mock('../components/character/CharacterSprite', async () => {
  const { createElement } = await import('react');
  return { CharacterSprite: () => createElement('div', { 'data-testid': 'sprite' }) };
});

beforeAll(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
});

function mockHooks() {
  vi.mocked(getServerSettings).mockResolvedValue(
    {} as Awaited<ReturnType<typeof getServerSettings>>,
  );
  vi.mocked(useCharacter).mockReturnValue({
    profile: {
      name: 'ナギ',
      profile: '',
      personality: [],
      speech_style: '',
      sentence_endings: '',
      first_person: '',
      second_person: '',
      relationship: '',
      background: '',
      gender: '',
      birthday: '',
      appearance: '',
      initial_state: { emotion: 'neutral', intensity: 0.5, mood: '', affinity: 10 },
      extra_settings: {},
    },
    state: {
      emotion: 'neutral',
      intensity: 0.5,
      secondary_emotion: null,
      secondary_intensity: 0,
      mood: '',
      affinity: 10,
      last_emotion_update: '',
      updated_at: '',
    },
    layers: { ...DEFAULT_SPRITE, available: true },
    setState: vi.fn(),
    error: null,
    loading: false,
    reload: vi.fn(),
  } as unknown as ReturnType<typeof useCharacter>);
  vi.mocked(useChat).mockReturnValue({
    messages: [],
    phase: 'idle',
    toolName: null,
    banner: null,
    loadingHistory: false,
    hasMoreHistory: false,
    loadingOlderHistory: false,
    loadOlderHistory: vi.fn(),
    trace: null,
    send: vi.fn().mockResolvedValue('sent'),
    resend: vi.fn(),
    reloadHistory: vi.fn(),
    dismissBanner: vi.fn(),
  } as unknown as ReturnType<typeof useChat>);
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ChatPage />
    </MemoryRouter>,
  );
}

function mainElement(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[style*="--message-bg-opacity"]');
}

// jsdom reports every clientHeight as 0, which would leave the drag
// without a sprite box to measure; tests stub a box height in instead.
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
  setPreferences({ debug: false, spriteOverlap: null, spriteFade: 50, foregroundOpacity: 100 });
  vi.mocked(useHealth).mockReturnValue(true);
  mockHooks();
});

afterEach(() => {
  cleanup();
  if (clientHeightStubbed) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    clientHeightStubbed = false;
  }
});

describe('ChatPage sprite/message overlap', () => {
  it('hands the message background opacity to the layout as its own variable', () => {
    const { container } = renderPage();
    const main = mainElement(container);
    expect(main?.style.getPropertyValue('--message-bg-opacity')).toBe('75%');
    act(() => setPreferences({ messageBgOpacity: 70 }));
    expect(main?.style.getPropertyValue('--message-bg-opacity')).toBe('70%');
  });

  it('hands the gradient length to the layout as its own variable', () => {
    const { container } = renderPage();
    const main = mainElement(container);
    expect(main?.style.getPropertyValue('--sprite-fade')).toBe('50%');
    act(() => setPreferences({ spriteFade: 80 }));
    expect(main?.style.getPropertyValue('--sprite-fade')).toBe('80%');
  });

  it('applies the foreground opacity to the message content', () => {
    setPreferences({ foregroundOpacity: 60 });
    const { container } = renderPage();
    const wrappers = [...container.querySelectorAll<HTMLElement>('div')].filter(
      (el) => el.style.opacity !== '',
    );
    expect(wrappers).toHaveLength(1);
    expect(wrappers[0]?.style.opacity).toBe('0.6');
  });

  describe('ChatPage backend connection', () => {
    it('shows a retryable error when the backend is offline', () => {
      vi.mocked(useHealth).mockReturnValue(false);
      const { getByRole } = renderPage();
      expect(getByRole('alert').textContent).toContain('バックエンドに接続できません。');
      expect(getByRole('button', { name: '再試行' })).toBeTruthy();
    });

    it('shows a reconnecting note while the offline retry is in flight', async () => {
      vi.mocked(useHealth).mockReturnValue(false);
      let finishReload: () => void = () => {};
      const pendingReload = new Promise<void>((resolve) => {
        finishReload = resolve;
      });
      const character = vi.mocked(useCharacter)();
      vi.mocked(useCharacter).mockReturnValue({
        ...character,
        reload: vi.fn(() => pendingReload),
      });
      const { getByRole, queryByRole } = renderPage();
      fireEvent.click(getByRole('button', { name: '再試行' }));
      expect(getByRole('status').textContent).toContain('バックエンドに再接続しています…');
      expect(queryByRole('button', { name: '再試行' })).toBeNull();
      await act(async () => {
        finishReload();
        await new Promise((resolve) => setTimeout(resolve, 700));
      });
      expect(getByRole('alert').textContent).toContain('バックエンドに接続できません。');
      expect(getByRole('button', { name: '再試行' })).toBeTruthy();
    });
  });

  it('shows the boundary handle only in adjust mode, toggled from the header', () => {
    const { container } = renderPage();
    expect(container.querySelector('[role="slider"]')).toBeNull();
    const toggle = container.querySelector('button[aria-label="チャットの高さを調整"]');
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
    const toggle = container.querySelector('button[aria-label="チャットの高さを調整"]');
    if (!toggle) throw new Error('toggle missing');
    fireEvent.click(toggle);
    const handle = container.querySelector('[role="slider"]');
    if (!handle) throw new Error('handle missing');
    expect(handle.getAttribute('aria-valuenow')).toBe('40');
    expect(getPreferences().spriteOverlap).toBeNull();
    expect(mainElement(container)?.style.getPropertyValue('--sprite-overlap')).toBe('');
  });

  it('drags the boundary into a stored, clamped overlap without resizing the sprite', () => {
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
      const toggle = container.querySelector('button[aria-label="チャットの高さを調整"]');
      if (!toggle) throw new Error('toggle missing');
      fireEvent.click(toggle);
      const handle = container.querySelector('[role="slider"]');
      if (!handle) throw new Error('handle missing');

      // Boundary 200px into a 500px sprite box: 60% is covered.
      fireEvent.pointerDown(handle, { clientY: 200 });
      fireEvent.pointerMove(window, { clientY: 200 });
      expect(getPreferences().spriteOverlap).toBe(60);
      expect(handle.getAttribute('aria-valuenow')).toBe('60');
      // The overlap variable moves; the sprite box size never does.
      expect(mainElement(container)?.style.getPropertyValue('--sprite-overlap')).toBe(
        'calc(var(--sprite-h) * 0.6)',
      );
      expect(mainElement(container)?.style.getPropertyValue('--sprite-h')).toBe('');
      // Dragging far past either end clamps instead of erasing a side.
      fireEvent.pointerMove(window, { clientY: 0 });
      expect(getPreferences().spriteOverlap).toBe(85);
      fireEvent.pointerMove(window, { clientY: 600 });
      expect(getPreferences().spriteOverlap).toBe(15);
      fireEvent.pointerUp(window);

      // The overlap stays stored (and applied) after the mode ends.
      const end = container.querySelector('button[aria-label="高さ調整を終わる"]');
      if (!end) throw new Error('end toggle missing');
      fireEvent.click(end);
      expect(container.querySelector('[role="slider"]')).toBeNull();
      expect(getPreferences().spriteOverlap).toBe(15);
      expect(mainElement(container)?.style.getPropertyValue('--sprite-overlap')).toBe(
        'calc(var(--sprite-h) * 0.15)',
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('adjusts the overlap with the arrow keys while the handle is focused', () => {
    setPreferences({ spriteOverlap: 50 });
    const { container } = renderPage();
    const toggle = container.querySelector('button[aria-label="チャットの高さを調整"]');
    if (!toggle) throw new Error('toggle missing');
    fireEvent.click(toggle);
    const handle = container.querySelector('[role="slider"]');
    if (!handle) throw new Error('handle missing');
    // Up moves the handle up on screen: the overlap deepens.
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(getPreferences().spriteOverlap).toBe(52);
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(getPreferences().spriteOverlap).toBe(48);
  });

  it('starts the arrow keys from the default overlap when nothing is stored', () => {
    const { container } = renderPage();
    const toggle = container.querySelector('button[aria-label="チャットの高さを調整"]');
    if (!toggle) throw new Error('toggle missing');
    fireEvent.click(toggle);
    const handle = container.querySelector('[role="slider"]');
    if (!handle) throw new Error('handle missing');
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(getPreferences().spriteOverlap).toBe(42);
  });
});
