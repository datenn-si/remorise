import { useCallback, useEffect, useState } from 'react';
import { errorText } from '../../lib/errors';
import { fieldClass, primaryButtonClass } from '../../lib/ui';
import { getServerSettings, updateServerSettings } from '../../services/settings';
import type {
  OperationalField,
  OperationalSettings,
  OperationalSettingsUpdate,
} from '../../types/settings';

type FieldDef = {
  key: OperationalField;
  label: string;
  kind: 'number' | 'checkbox';
  step?: string;
  optional?: boolean;
};

const GROUPS: { title: string; fields: FieldDef[]; gateKey?: OperationalField }[] = [
  {
    title: '生成',
    fields: [
      { key: 'llm_max_tokens', label: '生成トークン上限', kind: 'number', step: '1' },
      { key: 'llm_timeout_seconds', label: 'LLM のタイムアウト（秒）', kind: 'number', step: '1' },
      {
        key: 'llm_temperature',
        label: 'Temperature',
        kind: 'number',
        step: '0.1',
        optional: true,
      },
      {
        key: 'llm_frequency_penalty',
        label: 'Frequency penalty',
        kind: 'number',
        step: '0.1',
        optional: true,
      },
      {
        key: 'llm_presence_penalty',
        label: 'Presence penalty',
        kind: 'number',
        step: '0.1',
        optional: true,
      },
      {
        key: 'llm_repeat_penalty',
        label: 'Repeat penalty',
        kind: 'number',
        step: '0.05',
        optional: true,
      },
      { key: 'llm_context_size', label: '文脈サイズ（トークン）', kind: 'number', step: '1' },
    ],
  },
  {
    title: '文脈と要約',
    fields: [
      { key: 'context_warning_ratio', label: '文脈の警告比率', kind: 'number', step: '0.05' },
      { key: 'context_summary_ratio', label: '要約を開始する比率', kind: 'number', step: '0.05' },
      { key: 'context_target_ratio', label: '要約後の目標比率', kind: 'number', step: '0.05' },
      {
        key: 'summary_protected_messages',
        label: '保護する直近メッセージ数',
        kind: 'number',
        step: '1',
      },
    ],
  },
  {
    title: 'ジョブ',
    fields: [
      { key: 'job_max_attempts', label: 'ジョブの最大試行回数', kind: 'number', step: '1' },
      {
        key: 'job_poll_interval_seconds',
        label: 'ジョブの確認間隔（秒）',
        kind: 'number',
        step: '0.5',
      },
    ],
  },
  {
    title: '感情',
    fields: [
      { key: 'emotion_half_life_minutes', label: '感情の半減期（分）', kind: 'number', step: '1' },
      { key: 'affinity_min', label: '好感度の下限', kind: 'number', step: '1' },
      { key: 'affinity_max', label: '好感度の上限', kind: 'number', step: '1' },
      {
        key: 'affinity_delta_limit',
        label: '好感度の1回あたりの変化上限',
        kind: 'number',
        step: '1',
      },
    ],
  },
  {
    title: '記憶処理',
    fields: [
      {
        key: 'memory_agent_max_calls',
        label: '記憶処理の呼び出し上限（1ターン）',
        kind: 'number',
        step: '1',
      },
      {
        key: 'memory_agent_timeout_seconds',
        label: '記憶処理のタイムアウト（秒）',
        kind: 'number',
        step: '1',
      },
      {
        key: 'memory_handover_limit',
        label: '受け渡す記憶の件数上限',
        kind: 'number',
        step: '1',
      },
      {
        key: 'memory_handover_token_budget',
        label: '受け渡す記憶のトークン予算',
        kind: 'number',
        step: '1',
      },
      {
        key: 'memory_resident_max_items',
        label: '常駐集合の件数上限',
        kind: 'number',
        step: '1',
      },
      {
        key: 'memory_similarity_threshold',
        label: '内容類似の照合しきい値',
        kind: 'number',
        step: '0.05',
      },
    ],
  },
  {
    title: '記憶の忘却',
    gateKey: 'memory_decay_enabled',
    fields: [
      { key: 'memory_decay_enabled', label: '忘却を有効にする', kind: 'checkbox' },
      {
        key: 'memory_decay_threshold',
        label: '忘却する保持スコアのしきい値',
        kind: 'number',
        step: '0.05',
      },
      {
        key: 'memory_half_life_event_days',
        label: '半減期（出来事・日）',
        kind: 'number',
        step: '1',
      },
      {
        key: 'memory_half_life_state_days',
        label: '半減期（状態・日）',
        kind: 'number',
        step: '1',
      },
      {
        key: 'memory_reactivation_factor',
        label: '想起ごとの半減期の倍率',
        kind: 'number',
        step: '0.1',
      },
      {
        key: 'memory_reactivation_max_multiplier',
        label: '半減期の倍率の上限',
        kind: 'number',
        step: '0.5',
      },
    ],
  },
  {
    title: 'ライフサイクル',
    fields: [
      {
        key: 'archive_retention_days',
        label: 'アーカイブの自動物理削除までの日数（0で自動削除しない）',
        kind: 'number',
        step: '1',
      },
      {
        key: 'raw_log_retention_days',
        label: 'LLM 生ログの保持日数',
        kind: 'number',
        step: '1',
      },
    ],
  },
  {
    title: '立ち絵モーション',
    gateKey: 'sprite_motion_enabled',
    fields: [
      { key: 'sprite_motion_enabled', label: 'モーションを有効にする', kind: 'checkbox' },
      {
        key: 'sprite_motion_amplitude',
        label: '動きの大きさ（0〜2）',
        kind: 'number',
        step: '0.05',
      },
      {
        key: 'sprite_motion_speed',
        label: '速さ（0より大きく3まで）',
        kind: 'number',
        step: '0.05',
      },
      {
        key: 'sprite_motion_overscan',
        label: 'オーバースキャン（1〜1.5）',
        kind: 'number',
        step: '0.01',
      },
    ],
  },
];

const NUMERIC_FIELDS = GROUPS.flatMap((group) =>
  group.fields.filter((field) => field.kind === 'number'),
);

const CHECKBOX_FIELDS = GROUPS.flatMap((group) =>
  group.fields.filter((field) => field.kind === 'checkbox'),
);

const OPTIONAL_FIELDS = GROUPS.flatMap((group) =>
  group.fields.filter((field) => field.kind === 'number' && field.optional),
);

function checksFrom(values: OperationalSettings): Record<string, boolean> {
  const checks: Record<string, boolean> = {};
  for (const field of CHECKBOX_FIELDS) {
    checks[field.key] = Boolean(values[field.key]);
  }
  return checks;
}

function enabledFrom(values: OperationalSettings): Record<string, boolean> {
  const enabled: Record<string, boolean> = {};
  for (const field of OPTIONAL_FIELDS) {
    // An optional field is on while a value is in force (from the
    // database or from .env); off means nothing is sent and the
    // LLM server's default applies.
    enabled[field.key] = values[field.key] != null;
  }
  return enabled;
}

function draftFrom(values: OperationalSettings): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const field of NUMERIC_FIELDS) {
    // Only a field with a database value shows it in the input. The
    // rest stay empty, so the base value (.env / default) is visible
    // as the input's placeholder instead.
    if (!values.overridden.includes(field.key)) {
      draft[field.key] = '';
      continue;
    }
    const value = values[field.key] as number | null;
    draft[field.key] = value === null ? '' : String(value);
  }
  return draft;
}

/**
 * Operational server settings. Values are stored in the
 * backend database and override `.env`; saving takes effect without a
 * restart. Only changed fields are sent, so untouched fields keep
 * following `.env`. A field marked "DB" is currently overridden, and
 * can be reset to its `.env` value. A numeric field without a
 * database value keeps its input empty and shows the `.env` /
 * default value as the placeholder; only a database value appears
 * in the input itself. The sampling fields are optional: their
 * checkbox says whether a value is sent at all, and while off the
 * LLM server's default applies.
 */
export function ServerSettingsForm() {
  const [values, setValues] = useState<OperationalSettings | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyLoaded = useCallback((next: OperationalSettings) => {
    setValues(next);
    setDraft(draftFrom(next));
    setChecks(checksFrom(next));
    setEnabled(enabledFrom(next));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    getServerSettings(controller.signal)
      .then(applyLoaded)
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(errorText(caught) || 'サーバー設定を読み込めませんでした。');
      });
    return () => controller.abort();
  }, [applyLoaded]);

  const buildPatch = (): OperationalSettingsUpdate | null => {
    if (!values) return null;
    const patch: OperationalSettingsUpdate = {};
    for (const field of CHECKBOX_FIELDS) {
      const next = checks[field.key];
      if (next !== undefined && next !== values[field.key]) {
        patch[field.key] = next;
      }
    }
    for (const field of NUMERIC_FIELDS) {
      if (field.optional && !(enabled[field.key] ?? false)) {
        // Switched off: drop the database value so nothing is sent.
        if (values.overridden.includes(field.key)) {
          patch[field.key] = null;
        }
        continue;
      }
      const raw = (draft[field.key] ?? '').trim();
      const current = values[field.key] as number | null;
      const baseline = values.overridden.includes(field.key)
        ? current === null
          ? ''
          : String(current)
        : '';
      if (raw === baseline) continue;
      if (raw === '') {
        // Cleared back to empty: drop the database value and follow
        // the base value again.
        patch[field.key] = null;
        continue;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return null;
      if (parsed !== current) patch[field.key] = parsed;
    }
    return patch;
  };

  const patch = values ? buildPatch() : null;
  const hasChanges = patch !== null && Object.keys(patch).length > 0;

  const save = async () => {
    if (!patch || !hasChanges || busy) return;
    setBusy(true);
    setError(null);
    try {
      applyLoaded(await updateServerSettings(patch));
      setSaved(true);
    } catch (caught) {
      setError(errorText(caught) || 'サーバー設定を保存できませんでした。');
    } finally {
      setBusy(false);
    }
  };

  const resetField = async (key: OperationalField) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      applyLoaded(await updateServerSettings({ [key]: null }));
      setSaved(true);
    } catch (caught) {
      setError(errorText(caught) || '初期値に戻せませんでした。');
    } finally {
      setBusy(false);
    }
  };

  if (!values) {
    return (
      <section>
        <h2 className="mb-2 text-base">サーバー設定</h2>
        {error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : (
          <p className="text-sm text-muted">サーバー設定を読み込んでいます。</p>
        )}
      </section>
    );
  }

  return (
    <section>
      <h2 className="mb-2 text-base">サーバー設定</h2>
      <p className="text-sm text-muted">
        バックエンドの動作設定です。データベースに保存され、.env
        の値より優先されます。保存すると再起動なしで反映されます。「DB」と付いた項目はデータベースで上書き中です。入力欄のプレースホルダには、.env／既定の値が表示されます。サンプリング系の項目は、チェックが入っているときだけ値が送信され、外すと
        LLM サーバーの既定が適用されます。
      </p>
      {GROUPS.map((group) => (
        <fieldset key={group.title} className="mt-5">
          <legend className="text-sm font-semibold text-ink">{group.title}</legend>
          <div className="mt-2 grid max-w-md gap-3">
            {group.fields.map((field) => {
              // A field switched off by a checkbox (its own, for the
              // optional sampling fields, or its group's gate) is not
              // in effect: its input reads as inactive, desaturated
              // and grey. The checkbox itself stays full strength, so
              // it still reads as the way to switch the field on.
              const inactive =
                field.kind === 'number' &&
                ((field.optional && !(enabled[field.key] ?? false)) ||
                  (group.gateKey !== undefined &&
                    field.key !== group.gateKey &&
                    !(checks[group.gateKey] ?? false)));
              return field.kind === 'checkbox' ? (
                <label key={field.key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={checks[field.key] ?? false}
                    disabled={busy}
                    onChange={(event) => {
                      setChecks((prev) => ({ ...prev, [field.key]: event.target.checked }));
                      setSaved(false);
                    }}
                  />
                  <span>{field.label}</span>
                  {values.overridden.includes(field.key) ? <DbBadge /> : null}
                </label>
              ) : (
                <div key={field.key} className="grid gap-1 text-sm">
                  <span className="flex items-center gap-2">
                    {field.optional ? (
                      <input
                        type="checkbox"
                        aria-label={`${field.label}を有効にする`}
                        checked={enabled[field.key] ?? false}
                        disabled={busy || values.base_values[field.key] != null}
                        onChange={(event) => {
                          setEnabled((prev) => ({
                            ...prev,
                            [field.key]: event.target.checked,
                          }));
                          setSaved(false);
                        }}
                      />
                    ) : null}
                    <label htmlFor={`server-settings-${field.key}`}>{field.label}</label>
                    {values.overridden.includes(field.key) ? <DbBadge /> : null}
                    {values.overridden.includes(field.key) ? (
                      <button
                        type="button"
                        className="cursor-pointer text-xs text-muted underline"
                        disabled={busy}
                        onClick={() => void resetField(field.key)}
                      >
                        .env の値に戻す
                      </button>
                    ) : null}
                  </span>
                  <input
                    id={`server-settings-${field.key}`}
                    type="number"
                    step={field.step}
                    className={`${fieldClass} ${inactive ? 'saturate-0 opacity-60' : ''}`}
                    value={draft[field.key] ?? ''}
                    placeholder={
                      values.base_values[field.key] == null
                        ? field.optional
                          ? 'サーバーの既定'
                          : ''
                        : String(values.base_values[field.key])
                    }
                    disabled={busy || (field.optional && !(enabled[field.key] ?? false))}
                    onChange={(event) => {
                      setDraft((prev) => ({ ...prev, [field.key]: event.target.value }));
                      setSaved(false);
                    }}
                  />
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}
      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          className={primaryButtonClass}
          disabled={!hasChanges || busy}
          onClick={() => void save()}
        >
          保存する
        </button>
        {saved && !hasChanges ? <span className="text-sm text-muted">保存しました。</span> : null}
      </div>
      {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      <div className="mt-8">
        <h3 className="text-sm font-semibold text-ink">
          接続とデータ（この画面では変更できません）
        </h3>
        <p className="mt-1 text-sm text-muted">
          .env で設定する基底層の項目です。変更するには .env を編集して再起動してください。
        </p>
        <dl className="mt-2 grid max-w-md gap-2 text-sm">
          <ReadonlyRow label="LLM の接続先" value={values.readonly.llm_base_url} />
          <ReadonlyRow label="LLM モデル" value={values.readonly.llm_model} />
          <ReadonlyRow
            label="LLM の API キー"
            value={values.readonly.llm_api_key_configured ? '設定済み' : '未設定'}
          />
          <ReadonlyRow label="データディレクトリ" value={values.readonly.remorise_data_dir} />
        </dl>
      </div>
    </section>
  );
}

function ReadonlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted">{label}</dt>
      <dd className="break-all">{value}</dd>
    </div>
  );
}

function DbBadge() {
  return (
    <span className="rounded-full border border-line px-1.5 py-0.5 text-xs leading-none text-muted">
      DB
    </span>
  );
}
