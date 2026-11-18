import { render, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { useInferenceStatus } from '../hooks/useInferenceStatus';
import type { InferenceStatus } from '../types/chat';
import { SettingsPage } from './SettingsPage';

vi.mock('../hooks/useInferenceStatus', () => ({ useInferenceStatus: vi.fn() }));
vi.mock('../components/settings/ServerSettingsForm', () => ({
  ServerSettingsForm: () => null,
}));

const mockedUseInferenceStatus = vi.mocked(useInferenceStatus);

function renderPage(status: InferenceStatus | null) {
  mockedUseInferenceStatus.mockReturnValue(status);
  return render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

describe('SettingsPage', () => {
  it('disables the debug toggle and says why while a foreground turn runs', () => {
    const { container } = renderPage({
      active: 'foreground',
      background_kind: null,
      foreground_waiting: false,
      foreground_phase: 'thinking',
    });
    const toggle = within(container).getByLabelText(/デバッグモード/) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(container.textContent).toContain('キャラクターの発話中は切り替えできません。');
  });

  it('leaves the debug toggle usable while no turn runs', () => {
    const { container } = renderPage(null);
    const toggle = within(container).getByLabelText(/デバッグモード/) as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
    expect(container.textContent).not.toContain('キャラクターの発話中は切り替えできません。');
  });
});
