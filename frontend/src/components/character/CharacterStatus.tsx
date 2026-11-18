import { affinityLabel, emotionLabel } from '../../lib/labels';
import { formatDateTime } from '../../lib/format';
import type { CharacterProfile, CharacterState } from '../../types/character';

export function CharacterStatus({
  profile,
  state,
}: {
  profile: CharacterProfile | null;
  state: CharacterState | null;
}) {
  if (!profile && !state) {
    return <p className="text-muted">キャラクター情報を読み込んでいます。</p>;
  }

  return (
    <div className="space-y-6 text-sm">
      {profile && (
        <section className="space-y-3">
          <h3 className="text-base text-gold-text">{profile.name}</h3>
          <p className="text-xs text-muted">キャラクター設定（character.json）の内容です。</p>
          {profile.profile && (
            <p className="whitespace-pre-wrap leading-relaxed">{profile.profile}</p>
          )}
          {profile.personality.length > 0 && (
            <p>
              <span className="text-muted">性格 </span>
              {profile.personality.join('、')}
            </p>
          )}
          <Info label="話し方" value={profile.speech_style} />
          <Info label="語尾の例" value={profile.sentence_endings} />
          <Info label="一人称" value={profile.first_person} />
          <Info label="二人称" value={profile.second_person} />
          <Info label="関係" value={profile.relationship} />
          <Info label="背景" value={profile.background} />
          <Info label="性別" value={profile.gender} />
          <Info label="誕生日" value={profile.birthday} />
          <Info label="容姿" value={profile.appearance} />
          {profile.initial_state && (
            <p className="text-muted">
              初期状態 感情 {emotionLabel(profile.initial_state.emotion)}（強さ{' '}
              {Math.round(profile.initial_state.intensity * 100)}%）・気分{' '}
              {profile.initial_state.mood || '—'}・好感度 {profile.initial_state.affinity}
            </p>
          )}
          {Object.keys(profile.extra_settings).length > 0 && (
            <pre className="overflow-x-auto rounded-xl bg-canvas p-3 text-xs text-muted">
              {JSON.stringify(profile.extra_settings, null, 2)}
            </pre>
          )}
        </section>
      )}
      {state && (
        <section>
          <h3 className="text-base text-gold-text">いまの状態</h3>
          <p className="mt-1 text-xs text-muted">感情と好感度は会話から更新されます。</p>
          <dl className="mt-3 space-y-2">
            <Row
              term="主感情"
              value={`${emotionLabel(state.emotion)}（強さ ${Math.round(state.intensity * 100)}%）`}
            />
            <Row
              term="副感情"
              value={
                state.secondary_emotion
                  ? `${emotionLabel(state.secondary_emotion)}（強さ ${Math.round(state.secondary_intensity * 100)}%）`
                  : 'なし'
              }
            />
            <Row term="気分" value={state.mood || '—'} />
            <Row term="好感度" value={`${state.affinity}（${affinityLabel(state.affinity)}）`} />
            <Row term="感情の更新" value={formatDateTime(state.last_emotion_update)} />
          </dl>
        </section>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <p>
      <span className="text-muted">{label} </span>
      <span className="whitespace-pre-wrap">{value}</span>
    </p>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
      <dt className="text-muted">{term}</dt>
      <dd>{value}</dd>
    </div>
  );
}
