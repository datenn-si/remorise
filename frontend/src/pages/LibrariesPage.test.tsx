import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { LibrariesPage } from './LibrariesPage';

describe('LibrariesPage', () => {
  it('lists direct dependencies from the generated data', () => {
    const { container } = render(
      <MemoryRouter>
        <LibrariesPage />
      </MemoryRouter>,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('フロントエンド（実行時）');
    expect(text).toContain('バックエンド（実行時）');
    // Known direct dependencies from package.json / pyproject.toml.
    expect(text).toContain('react');
    expect(text).toContain('19.3.1');
    expect(text).toContain('fastapi');
    expect(text).toContain('sqlalchemy');
    expect(text).toContain('MIT');
    expect(text).toContain('推移的な依存は含みません');
    expect(text).not.toContain('取りに行きません');
  });

  it('links license names to the license text on spdx.org', () => {
    const { container } = render(
      <MemoryRouter>
        <LibrariesPage />
      </MemoryRouter>,
    );
    const links = [...container.querySelectorAll('a')].filter((anchor) =>
      (anchor.getAttribute('href') ?? '').startsWith('https://spdx.org/licenses/'),
    );
    expect(links.length).toBeGreaterThan(0);
    expect(links.map((anchor) => anchor.getAttribute('href'))).toContain(
      'https://spdx.org/licenses/MIT.html',
    );
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noreferrer');
    }
  });
});
