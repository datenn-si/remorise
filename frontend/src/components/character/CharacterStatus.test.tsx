import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../../types/character';
import { CharacterStatus } from './CharacterStatus';

function profile(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  return {
    name: 'ナギ',
    profile: '',
    personality: [],
    speech_style: '',
    sentence_endings: '',
    first_person: '私',
    second_person: 'あなた',
    relationship: '',
    background: '',
    gender: '',
    birthday: '',
    appearance: '',
    theme_hue: null,
    initial_state: { emotion: 'neutral', intensity: 0, mood: 'neutral', affinity: 50 },
    extra_settings: {},
    ...overrides,
  };
}

describe('CharacterStatus', () => {
  it('shows the split sentence endings and the basic attributes', () => {
    const { container } = render(
      <CharacterStatus
        profile={profile({
          speech_style: '穏やかで簡潔',
          sentence_endings: '〜だよ、〜だね',
          gender: '女性',
          birthday: '4月3日',
          appearance: '銀髪で小柄',
        })}
        state={null}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('話し方');
    expect(text).toContain('穏やかで簡潔');
    expect(text).toContain('語尾の例');
    expect(text).toContain('〜だよ、〜だね');
    expect(text).toContain('性別');
    expect(text).toContain('女性');
    expect(text).toContain('誕生日');
    expect(text).toContain('4月3日');
    expect(text).toContain('容姿');
    expect(text).toContain('銀髪で小柄');
  });

  it('omits the new rows when the fields are empty', () => {
    const { container } = render(<CharacterStatus profile={profile()} state={null} />);
    const text = container.textContent ?? '';
    expect(text).not.toContain('語尾の例');
    expect(text).not.toContain('性別');
    expect(text).not.toContain('誕生日');
    expect(text).not.toContain('容姿');
  });
});
