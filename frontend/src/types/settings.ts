/**
 * Operational-layer server settings from `GET /api/settings`.
 * `overridden` lists the fields whose value comes from the database
 * rather than from `.env` / the defaults, and `base_values` holds
 * the `.env` / default value of every field (shown as the input
 * placeholder). `readonly` carries the base-layer configuration
 * (LLM connection, model, data directory, CORS origins) for display
 * only; it cannot be changed from the UI, and the API key itself is
 * never included, only whether one is configured. The
 * data-lifecycle and memory-forgetting parameters live here too:
 * the debug API is read-only, so they moved to the normal settings.
 */
export type OperationalValues = {
  llm_max_tokens: number;
  llm_timeout_seconds: number;
  llm_temperature: number | null;
  llm_frequency_penalty: number | null;
  llm_presence_penalty: number | null;
  llm_repeat_penalty: number | null;
  llm_context_size: number;
  context_summary_ratio: number;
  context_target_ratio: number;
  summary_protected_messages: number;
  job_max_attempts: number;
  job_poll_interval_seconds: number;
  emotion_half_life_minutes: number;
  affinity_min: number;
  affinity_max: number;
  affinity_delta_limit: number;
  archive_retention_days: number;
  raw_log_retention_days: number;
  memory_decay_enabled: boolean;
  memory_decay_threshold: number;
  memory_half_life_event_days: number;
  memory_half_life_state_days: number;
  memory_reactivation_factor: number;
  memory_reactivation_max_multiplier: number;
  memory_agent_max_calls: number;
  memory_agent_timeout_seconds: number;
  memory_handover_limit: number;
  memory_handover_token_budget: number;
  memory_resident_max_items: number;
  memory_similarity_threshold: number;
  sprite_motion_enabled: boolean;
  sprite_motion_amplitude: number;
  sprite_motion_speed: number;
  sprite_motion_overscan: number;
};

export type ReadonlySettingsInfo = {
  llm_base_url: string;
  llm_model: string;
  llm_api_key_configured: boolean;
  remorise_data_dir: string;
};

export type OperationalSettings = OperationalValues & {
  overridden: string[];
  base_values: OperationalValues;
  readonly: ReadonlySettingsInfo;
};

export type OperationalField = keyof OperationalValues;

/** Partial update: absent = untouched, `null` = reset to the `.env` value. */
export type OperationalSettingsUpdate = Partial<Record<OperationalField, number | boolean | null>>;
