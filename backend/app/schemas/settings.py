from pydantic import BaseModel, ConfigDict, Field


class OperationalValues(BaseModel):
    llm_max_tokens: int
    llm_timeout_seconds: float
    llm_temperature: float | None
    llm_frequency_penalty: float | None
    llm_presence_penalty: float | None
    llm_repeat_penalty: float | None
    llm_context_size: int
    context_warning_ratio: float
    context_summary_ratio: float
    context_target_ratio: float
    summary_protected_messages: int
    job_max_attempts: int
    job_poll_interval_seconds: float
    emotion_half_life_minutes: int
    affinity_min: int
    affinity_max: int
    affinity_delta_limit: int
    archive_retention_days: int
    raw_log_retention_days: int
    memory_decay_enabled: bool
    memory_decay_threshold: float
    memory_half_life_event_days: float
    memory_half_life_state_days: float
    memory_reactivation_factor: float
    memory_reactivation_max_multiplier: float
    memory_agent_max_calls: int
    memory_agent_timeout_seconds: float
    memory_handover_limit: int
    memory_handover_token_budget: int
    memory_resident_max_items: int
    memory_similarity_threshold: float
    sprite_motion_enabled: bool
    sprite_motion_amplitude: float
    sprite_motion_speed: float
    sprite_motion_overscan: float


class ReadonlySettingsInfo(BaseModel):
    """Base-layer configuration, exposed for display only.

    These values come from ``.env`` and are fixed at startup; this API
    can never change them. The API key itself is never returned, only
    whether one is configured, and the database URL is not exposed at
    all (it may embed credentials).
    """

    llm_base_url: str
    llm_model: str
    llm_api_key_configured: bool
    remorise_data_dir: str


class OperationalSettingsResponse(OperationalValues):
    """Effective operational-layer settings.

    ``overridden`` lists the fields whose value currently comes from
    the database rather than from ``.env`` / the defaults.
    ``base_values`` holds the ``.env`` / default value of every field
    (what a field falls back to when its override is reset), and
    ``readonly`` carries the base-layer configuration for display.
    """

    overridden: list[str]
    base_values: OperationalValues
    readonly: ReadonlySettingsInfo


class OperationalSettingsUpdate(BaseModel):
    """Partial update of the operational layer.

    Every field is optional; an absent field is left untouched and an
    explicit ``null`` resets the field (its DB override is removed and
    the ``.env`` / default value applies again). Unknown fields —
    including base-layer names — are rejected, so this endpoint can
    never change settings outside its layer.
    """

    model_config = ConfigDict(extra="forbid")

    llm_max_tokens: int | None = Field(default=None, gt=0)
    llm_timeout_seconds: float | None = Field(default=None, gt=0)
    llm_temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    llm_frequency_penalty: float | None = Field(default=None, ge=-2.0, le=2.0)
    llm_presence_penalty: float | None = Field(default=None, ge=-2.0, le=2.0)
    llm_repeat_penalty: float | None = Field(default=None, gt=0.0)
    llm_context_size: int | None = Field(default=None, gt=0)
    context_warning_ratio: float | None = Field(default=None, ge=0.0, le=1.0)
    context_summary_ratio: float | None = Field(default=None, ge=0.0, le=1.0)
    context_target_ratio: float | None = Field(default=None, ge=0.0, le=1.0)
    summary_protected_messages: int | None = Field(default=None, ge=0)
    job_max_attempts: int | None = Field(default=None, ge=1)
    job_poll_interval_seconds: float | None = Field(default=None, gt=0)
    emotion_half_life_minutes: int | None = Field(default=None, gt=0)
    affinity_min: int | None = Field(default=None, ge=0, le=200)
    affinity_max: int | None = Field(default=None, ge=0, le=200)
    affinity_delta_limit: int | None = Field(default=None, ge=0, le=5)
    archive_retention_days: int | None = Field(default=None, ge=0)
    raw_log_retention_days: int | None = Field(default=None, ge=0)
    memory_decay_enabled: bool | None = None
    memory_decay_threshold: float | None = Field(default=None, gt=0.0, le=1.0)
    memory_half_life_event_days: float | None = Field(default=None, gt=0)
    memory_half_life_state_days: float | None = Field(default=None, gt=0)
    memory_reactivation_factor: float | None = Field(default=None, ge=1.0)
    memory_reactivation_max_multiplier: float | None = Field(default=None, ge=1.0)
    memory_agent_max_calls: int | None = Field(default=None, ge=1, le=32)
    memory_agent_timeout_seconds: float | None = Field(default=None, gt=0)
    memory_handover_limit: int | None = Field(default=None, ge=1, le=50)
    memory_handover_token_budget: int | None = Field(default=None, ge=100)
    memory_resident_max_items: int | None = Field(default=None, ge=1, le=200)
    memory_similarity_threshold: float | None = Field(default=None, gt=0.0, le=1.0)
    sprite_motion_enabled: bool | None = None
    sprite_motion_amplitude: float | None = Field(default=None, ge=0.0, le=2.0)
    sprite_motion_speed: float | None = Field(default=None, gt=0.0, le=3.0)
    sprite_motion_overscan: float | None = Field(default=None, ge=1.0, le=1.5)
