/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import creditSource from '../content/credit.md?raw';
import licenseSource from '../content/license.txt?raw';
import privacySource from '../content/privacy-policy.md?raw';
import { getCharacterTerms } from '../services/character';
import { CharacterTermsPage, CreditPage, LicensePage, PrivacyPolicyPage } from './LegalPage';

vi.mock('../services/character', () => ({ getCharacterTerms: vi.fn() }));

const mockedGetCharacterTerms = vi.mocked(getCharacterTerms);

beforeEach(() => {
  mockedGetCharacterTerms.mockResolvedValue({
    available: true,
    markdown: '# サンプル利用規約\n\nサンプルの規約です。',
  });
});

describe('bundled legal documents', () => {
  it('keeps the bundled privacy policy identical to the docs source', () => {
    const docsPrivacy = readFileSync(join(process.cwd(), '../docs/privacy-policy.md'), 'utf-8');
    expect(privacySource).toBe(docsPrivacy);
  });

  it('keeps the bundled license identical to the repository LICENSE file', () => {
    const rootLicense = readFileSync(join(process.cwd(), '../LICENSE'), 'utf-8');
    expect(licenseSource).toBe(rootLicense);
  });

  it('keeps the bundled credit identical to the repository CREDIT file', () => {
    const rootCredit = readFileSync(join(process.cwd(), '../CREDIT.md'), 'utf-8');
    expect(creditSource).toBe(rootCredit);
  });
});

describe('CharacterTermsPage', () => {
  it('renders the terms served for the loaded character', async () => {
    const { container } = render(
      <MemoryRouter>
        <CharacterTermsPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.textContent ?? '').toContain('サンプルの規約です'));
    expect(container.textContent ?? '').toContain('サンプル利用規約');
    expect(container.querySelector('a[href="/settings/about"]')).toBeTruthy();
  });

  it('shows a note when the character has no terms', async () => {
    mockedGetCharacterTerms.mockResolvedValue({ available: false, markdown: '' });
    const { container } = render(
      <MemoryRouter>
        <CharacterTermsPage />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(container.textContent ?? '').toContain('このキャラクターには利用規約はありません'),
    );
  });
});

describe('LicensePage', () => {
  it('renders the license text with the out-of-scope note for assets', () => {
    const { container } = render(
      <MemoryRouter>
        <LicensePage />
      </MemoryRouter>,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    expect(text).toContain('コードでないアセットは対象外');
    expect(text).toContain('クレジットを参照してください');
    expect(container.querySelector('a[href="/settings/about"]')).toBeTruthy();
  });
});

describe('CreditPage', () => {
  it('renders the credit document', () => {
    const { container } = render(
      <MemoryRouter>
        <CreditPage />
      </MemoryRouter>,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('クレジット');
    expect(text).toContain('だてんし');
    expect(text).toContain('キャラクター「レモラ」');
    expect(container.querySelector('a[href="/settings/about"]')).toBeTruthy();
  });
});

describe('PrivacyPolicyPage', () => {
  it('renders the privacy policy document', () => {
    const { container } = render(
      <MemoryRouter>
        <PrivacyPolicyPage />
      </MemoryRouter>,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('プライバシーポリシー');
    expect(text).toContain('個人情報を収集しません');
    expect(text).toContain('LLM API への送信');
  });
});
