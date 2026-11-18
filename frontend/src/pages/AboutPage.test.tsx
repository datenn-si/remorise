import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { version } from '../../package.json';
import { getCharacterTerms } from '../services/character';
import { AboutPage } from './AboutPage';

vi.mock('../services/character', () => ({ getCharacterTerms: vi.fn() }));

const mockedGetCharacterTerms = vi.mocked(getCharacterTerms);

describe('AboutPage', () => {
  beforeEach(() => {
    mockedGetCharacterTerms.mockResolvedValue({ available: true, markdown: '# 規約' });
  });

  it('shows the wordmark, version, author, and license', () => {
    const { container, getByAltText } = render(
      <MemoryRouter>
        <AboutPage />
      </MemoryRouter>,
    );
    expect(getByAltText(/Remorise のロゴ/)).toBeTruthy();
    const text = container.textContent ?? '';
    expect(text).toContain('Remorise について');
    expect(text).toContain(version);
    expect(text).toContain('だてんし');
    expect(text).toContain('AGPL-3.0');
    expect(text).toContain('GNU Affero General Public License');
    const librariesLink = container.querySelector('a[href="/settings/about/libraries"]');
    expect(librariesLink).toBeTruthy();
    const licenseLink = container.querySelector('a[href="/settings/about/license"]');
    expect(licenseLink).toBeTruthy();
    expect(licenseLink?.className).not.toContain('underline');
    const creditLink = container.querySelector('a[href="/settings/about/credit"]');
    expect(creditLink).toBeTruthy();
    expect(creditLink?.className).toBe(licenseLink?.className);
  });

  it('links to the character terms and the privacy policy when the character has terms', async () => {
    const { container } = render(
      <MemoryRouter>
        <AboutPage />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(container.querySelector('a[href="/settings/about/terms"]')).toBeTruthy(),
    );
    expect(container.querySelector('a[href="/settings/about/privacy"]')).toBeTruthy();
  });

  it('hides the character terms when the character has none', async () => {
    mockedGetCharacterTerms.mockResolvedValue({ available: false, markdown: '' });
    const { container } = render(
      <MemoryRouter>
        <AboutPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(mockedGetCharacterTerms).toHaveBeenCalled());
    await act(async () => {});
    expect(container.querySelector('a[href="/settings/about/terms"]')).toBeNull();
    expect(container.querySelector('a[href="/settings/about/privacy"]')).toBeTruthy();
  });
});
