import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function Boom(): never {
  throw new Error('boom');
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('shows the fallback when a child throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getByRole, getByText } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(getByText('画面を表示できません')).toBeTruthy();
    expect(getByRole('button', { name: '再読み込み' })).toBeTruthy();
  });

  it('gives feedback on the reload button before reloading', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const { getByRole } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    const button = getByRole('button', { name: '再読み込み' }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.textContent).toBe('再読み込み中…');
    expect(button.disabled).toBe(true);
  });
});
