import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerSettingsForm } from './ServerSettingsForm';
import { getServerSettings, updateServerSettings } from '../../services/settings';
import type { OperationalSettings, OperationalValues } from '../../types/settings';

vi.mock('../../services/settings', () => ({
  getServerSettings: vi.fn(),
  updateServerSettings: vi.fn(),
}));

const mockedGet = vi.mocked(getServerSettings);
const mockedUpdate = vi.mocked(updateServerSettings);

const VALUES: OperationalValues = {
  llm_max_tokens: 2048,
  llm_timeout_seconds: 300,
  llm_temperature: null,
  llm_frequency_penalty: null,
  llm_presence_penalty: null,
  llm_repeat_penalty: null,
  llm_context_size: 16384,
  context_warning_ratio: 0.7,
  context_summary_ratio: 0.75,
  context_target_ratio: 0.55,
  summary_protected_messages: 20,
  job_max_attempts: 3,
  job_poll_interval_seconds: 5,
  emotion_half_life_minutes: 30,
  affinity_min: 0,
  affinity_max: 100,
  affinity_delta_limit: 5,
  archive_retention_days: 0,
  raw_log_retention_days: 30,
  memory_decay_enabled: true,
  memory_decay_threshold: 0.2,
  memory_half_life_event_days: 30,
  memory_half_life_state_days: 365,
  memory_reactivation_factor: 1.5,
  memory_reactivation_max_multiplier: 10,
  memory_agent_max_calls: 5,
  memory_agent_timeout_seconds: 60,
  memory_handover_limit: 5,
  memory_handover_token_budget: 2000,
  memory_resident_max_items: 20,
  memory_similarity_threshold: 0.8,
  sprite_motion_enabled: true,
  sprite_motion_amplitude: 1,
  sprite_motion_speed: 1,
  sprite_motion_overscan: 1.06,
};

const BASE: OperationalSettings = {
  ...VALUES,
  overridden: [],
  base_values: VALUES,
  readonly: {
    llm_base_url: 'http://127.0.0.1:9931/v1',
    llm_model: 'sample-model',
    llm_api_key_configured: false,
    remorise_data_dir: '/data',
  },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ServerSettingsForm', () => {
  it('shows base values as placeholders and saves only the changed fields', async () => {
    mockedGet.mockResolvedValue(BASE);
    mockedUpdate.mockResolvedValue({ ...BASE, archive_retention_days: 14 });
    render(<ServerSettingsForm />);

    // Without a database value the input stays empty and the base
    // value is the placeholder.
    const archive = (await screen.findByLabelText(
      'アーカイブの自動物理削除までの日数（0で自動削除しない）',
    )) as HTMLInputElement;
    expect(archive.value).toBe('');
    expect(archive.placeholder).toBe('0');
    fireEvent.change(archive, { target: { value: '14' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith({ archive_retention_days: 14 }));
    expect(await screen.findByText('保存しました。')).toBeTruthy();
  });

  it('greys out fields switched off by a checkbox', async () => {
    mockedGet.mockResolvedValue({ ...BASE, memory_decay_enabled: false });
    render(<ServerSettingsForm />);
    // Gated by the group's (off) checkbox.
    const threshold = await screen.findByLabelText('忘却する保持スコアのしきい値');
    expect(threshold.closest('div')?.className).toContain('saturate-0');
    // An optional sampling field with no value in force is off, so greyed.
    const temperature = screen.getByLabelText('Temperature');
    expect(temperature.closest('div')?.className).toContain('saturate-0');
    // A field with no gate stays full strength.
    const archive = screen.getByLabelText(
      'アーカイブの自動物理削除までの日数（0で自動削除しない）',
    );
    expect(archive.closest('div')?.className).not.toContain('saturate-0');
  });

  it('sends null for a cleared sampling field (reset to unset)', async () => {
    mockedGet.mockResolvedValue({
      ...BASE,
      llm_temperature: 0.8,
      overridden: ['llm_temperature'],
    });
    mockedUpdate.mockResolvedValue(BASE);
    render(<ServerSettingsForm />);

    const temperature = (await screen.findByLabelText('Temperature')) as HTMLInputElement;
    expect(temperature.value).toBe('0.8');
    fireEvent.change(temperature, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith({ llm_temperature: null }));
  });

  it('marks DB-overridden fields and resets them individually', async () => {
    mockedGet.mockResolvedValue({
      ...BASE,
      llm_temperature: 0.9,
      overridden: ['llm_temperature'],
    });
    mockedUpdate.mockResolvedValue(BASE);
    render(<ServerSettingsForm />);

    await screen.findByLabelText('Temperature');
    expect(screen.getByText('DB')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '.env の値に戻す' }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith({ llm_temperature: null }));
  });

  it('keeps an unset sampling field off until its checkbox enables it', async () => {
    mockedGet.mockResolvedValue(BASE);
    mockedUpdate.mockResolvedValue({
      ...BASE,
      llm_temperature: 1.1,
      overridden: ['llm_temperature'],
    });
    render(<ServerSettingsForm />);

    const temperature = (await screen.findByLabelText('Temperature')) as HTMLInputElement;
    expect(temperature.disabled).toBe(true);
    expect(temperature.placeholder).toBe('サーバーの既定');
    fireEvent.click(screen.getByLabelText('Temperatureを有効にする'));
    expect(temperature.disabled).toBe(false);
    fireEvent.change(temperature, { target: { value: '1.1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith({ llm_temperature: 1.1 }));
  });

  it('sends null when an overridden sampling field is switched off', async () => {
    mockedGet.mockResolvedValue({
      ...BASE,
      llm_temperature: 0.8,
      overridden: ['llm_temperature'],
    });
    mockedUpdate.mockResolvedValue(BASE);
    render(<ServerSettingsForm />);

    await screen.findByLabelText('Temperature');
    fireEvent.click(screen.getByLabelText('Temperatureを有効にする'));
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith({ llm_temperature: null }));
  });

  it('shows the base layer read-only and env values as placeholders', async () => {
    mockedGet.mockResolvedValue({
      ...BASE,
      llm_max_tokens: 4096,
      overridden: ['llm_max_tokens'],
    });
    render(<ServerSettingsForm />);

    expect(await screen.findByText('接続とデータ（この画面では変更できません）')).toBeTruthy();
    expect(screen.getByText('sample-model')).toBeTruthy();
    const maxTokens = screen.getByLabelText('生成トークン上限') as HTMLInputElement;
    expect(maxTokens.value).toBe('4096');
    expect(maxTokens.placeholder).toBe('2048');
    const timeout = screen.getByLabelText('LLM のタイムアウト（秒）') as HTMLInputElement;
    expect(timeout.value).toBe('');
    expect(timeout.placeholder).toBe('300');
  });
});
