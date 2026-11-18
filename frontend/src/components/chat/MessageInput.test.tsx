import { fireEvent, render, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MessageInput } from './MessageInput';

beforeAll(() => {
  // jsdom has no matchMedia; the component only reads it to learn
  // whether the primary pointer is coarse (touch). Report a fine one.
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
});

function Harness({ onSend }: { onSend?: () => void }) {
  const [value, setValue] = useState('');
  return (
    <MessageInput
      value={value}
      locked={false}
      onChange={setValue}
      onSend={() => {
        onSend?.();
        setValue('');
      }}
    />
  );
}

function buttonByLabel(container: HTMLElement, label: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

describe('MessageInput', () => {
  it('makes the send button icon-only with an accessible name', () => {
    const { container } = render(
      <MessageInput value="こんにちは" locked={false} onChange={() => {}} onSend={() => {}} />,
    );
    const send = buttonByLabel(container, '送信');
    expect(send).toBeTruthy();
    expect(send?.textContent).toBe('');
    expect(send?.querySelector('[class*="mdi--send"]')).toBeTruthy();
    expect(send?.disabled).toBe(false);
  });

  it('disables the preview toggle while the draft is empty', () => {
    const { container } = render(<Harness />);
    expect(buttonByLabel(container, 'プレビュー')?.disabled).toBe(true);
    expect(container.querySelector('textarea')).toBeTruthy();
  });

  it('previews the draft as the sent message will render, and keeps the draft on the way back', async () => {
    const { container } = render(<Harness />);
    const textarea = container.querySelector('textarea');
    expect(textarea).toBeTruthy();
    if (!textarea) return;
    fireEvent.change(textarea, {
      target: { value: '**太字** と [リンク](https://example.com) と $x^2$' },
    });

    const previewButton = buttonByLabel(container, 'プレビュー');
    expect(previewButton?.disabled).toBe(false);
    if (!previewButton) return;
    fireEvent.click(previewButton);

    // The editor is replaced by the sent-message rendering of the
    // same draft: bubble styling plus the markdown path (which loads
    // lazily, so wait for the math to render; the timeout is generous
    // for full-suite parallel load).
    expect(container.querySelector('textarea')).toBeNull();
    await waitFor(
      () => {
        const bubble = container.querySelector('article.bg-user');
        expect(bubble?.querySelector('strong')?.textContent).toBe('太字');
        expect(bubble?.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
        expect(bubble?.querySelector('.katex')).toBeTruthy();
      },
      { timeout: 10000 },
    );

    const backButton = buttonByLabel(container, '編集に戻る');
    expect(backButton).toBeTruthy();
    if (!backButton) return;
    fireEvent.click(backButton);
    const restored = container.querySelector('textarea');
    expect(restored?.value).toBe('**太字** と [リンク](https://example.com) と $x^2$');
  });

  it('prevents the pointerdown default on both buttons so a tap never blurs the editor', () => {
    const { container } = render(<Harness />);
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('textarea missing');
    fireEvent.change(textarea, { target: { value: '下書き' } });
    const preview = buttonByLabel(container, 'プレビュー');
    const send = buttonByLabel(container, '送信');
    if (!preview || !send) throw new Error('buttons missing');
    // fireEvent reports false when a handler canceled the event:
    // canceling pointerdown is what keeps the focus (and the software
    // keyboard) from being lost before the click lands.
    expect(fireEvent.pointerDown(preview)).toBe(false);
    expect(fireEvent.pointerDown(send)).toBe(false);
  });

  it('still sends exactly once on the click that follows the pointerdown', () => {
    const onSend = vi.fn();
    const { container } = render(<Harness onSend={onSend} />);
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('textarea missing');
    fireEvent.change(textarea, { target: { value: '送る文' } });
    const send = buttonByLabel(container, '送信');
    if (!send) throw new Error('send button missing');
    fireEvent.pointerDown(send);
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the editor after coming back from the preview', () => {
    const { container } = render(<Harness />);
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('textarea missing');
    fireEvent.change(textarea, { target: { value: '下書き' } });
    const preview = buttonByLabel(container, 'プレビュー');
    if (!preview) throw new Error('preview button missing');
    fireEvent.click(preview);
    const back = buttonByLabel(container, '編集に戻る');
    if (!back) throw new Error('back button missing');
    fireEvent.click(back);
    const restored = container.querySelector('textarea');
    expect(restored).toBeTruthy();
    expect(document.activeElement).toBe(restored);
  });

  it('sends from the preview and returns to editing once the draft clears', () => {
    const onSend = vi.fn();
    const { container } = render(<Harness onSend={onSend} />);
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('textarea missing');
    fireEvent.change(textarea, { target: { value: '**下書き**' } });
    const previewButton = buttonByLabel(container, 'プレビュー');
    if (!previewButton) throw new Error('preview button missing');
    fireEvent.click(previewButton);
    expect(container.querySelector('textarea')).toBeNull();

    const send = buttonByLabel(container, '送信');
    if (!send) throw new Error('send button missing');
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(container.querySelector('textarea')).toBeTruthy();
    expect(container.querySelector('article.bg-user')).toBeNull();
  });

  it('greys out the send button and blocks Enter while offline', () => {
    const onSend = vi.fn();
    const { container } = render(
      <MessageInput
        value="こんにちは"
        locked={false}
        offline
        onChange={() => {}}
        onSend={onSend}
      />,
    );
    const send = buttonByLabel(container, '送信');
    if (!send) throw new Error('send button missing');
    expect(send.disabled).toBe(true);
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('textarea missing');
    expect((textarea as HTMLTextAreaElement).disabled).toBe(false);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });
});
