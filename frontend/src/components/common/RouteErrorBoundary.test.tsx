import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteErrorBoundary } from './RouteErrorBoundary';

function Boom(): never {
  throw new Error('boom');
}

function tree(routeKey: string, child: ReactNode) {
  return (
    <MemoryRouter>
      <RouteErrorBoundary key={routeKey}>{child}</RouteErrorBoundary>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RouteErrorBoundary', () => {
  it('shows a page-level fallback with a way back when a child throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getByRole, getByText } = render(tree('/pipeline', <Boom />));
    expect(getByText('ページを表示できません')).toBeTruthy();
    expect(getByRole('link', { name: '会話へ戻る' })).toBeTruthy();
    expect(getByRole('button', { name: '再読み込み' })).toBeTruthy();
  });

  it('clears the failure when remounted under a different route key', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getByText, queryByText, rerender } = render(tree('/pipeline', <Boom />));
    expect(getByText('ページを表示できません')).toBeTruthy();
    rerender(tree('/settings', <p>設定の内容</p>));
    expect(queryByText('ページを表示できません')).toBeNull();
    expect(getByText('設定の内容')).toBeTruthy();
  });
});
