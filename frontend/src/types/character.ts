export type InitialState = {
  emotion: string;
  intensity: number;
  mood: string;
  affinity: number;
};

export type CharacterProfile = {
  name: string;
  profile: string;
  personality: string[];
  speech_style: string;
  sentence_endings: string;
  first_person: string;
  second_person: string;
  relationship: string;
  background: string;
  gender: string;
  birthday: string;
  appearance: string;
  theme_hue: number | null;
  initial_state: InitialState;
  extra_settings: Record<string, unknown>;
};

export type CharacterTerms = {
  available: boolean;
  markdown: string;
};

export type CharacterState = {
  emotion: string;
  intensity: number;
  secondary_emotion: string | null;
  secondary_intensity: number;
  mood: string;
  affinity: number;
  last_emotion_update: string;
  updated_at: string;
};
