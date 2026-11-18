import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Link } from 'react-router-dom';
import { CharacterSprite } from '../components/character/CharacterSprite';
import { RangeInput } from '../components/common/RangeInput';
import { useCharacter } from '../hooks/useCharacter';
import {
  MESSAGE_BG_OPACITY_MIN,
  getPreferences,
  setPreferences,
  subscribePreferences,
} from '../lib/preferences';
import {
  SPRITE_OVERLAP_MAX,
  SPRITE_OVERLAP_MIN,
  effectiveSpriteOverlap,
  overlapFromBoundary,
} from '../lib/spriteOverlap';
import {
  DEFAULT_SPRITE,
  eyeGroupLists,
  hasSplitEyes,
  poseLabel,
  poseLayerRefs,
  type Expression,
  type EyeState,
  type LayerRef,
  type Mark,
  type MouthState,
  type Pose,
} from '../lib/spriteLayers';
import { emotionLabel } from '../lib/labels';
import { DEFAULT_MOTION, motionFromSettings, type SpriteMotionSettings } from '../lib/spriteMotion';
import { buttonClass, fieldClass, iconButtonClass } from '../lib/ui';
import { getServerSettings, updateServerSettings } from '../services/settings';

const disabledFieldClass = `${fieldClass} disabled:cursor-not-allowed disabled:opacity-50`;
const disabledLabelClass = 'cursor-not-allowed text-muted';

const EXPRESSION_LABELS: Record<Expression, string> = {
  normal: '普通',
  affectionate: '親愛',
  angry: '怒り',
  anxious: '不安',
  embarrassed: '照れ',
  happy: '喜び',
  puzzled: '困惑',
  sad: '悲しみ',
  surprised: '驚き',
};

const MARK_LABELS: Record<Mark, string> = {
  thinking: '考え中',
  affectionate: '親愛',
  angry: '怒り',
  puzzled: '困惑',
  surprised: '驚き',
};

const EXTRA_LABELS: Record<string, string> = {
  sweat: '汗',
  blush: '頬の赤み',
};

export function SpriteDebugPage() {
  const character = useCharacter();
  const sprite = character.layers ?? DEFAULT_SPRITE;
  const poses = Object.keys(sprite.poses);
  const expressions = Object.keys(sprite.expressions);
  const marks = Object.keys(sprite.marks);
  const [assetState, setAssetState] = useState<{
    sprite: typeof sprite;
    assets: ReadonlySet<string>;
  } | null>(null);
  const [pose, setPose] = useState<Pose>('arms-down');
  const [expression, setExpression] = useState<Expression>('normal');
  const [preset, setPreset] = useState('neutral');
  const [mark, setMark] = useState<Mark | null>(null);
  const [thinking, setThinking] = useState(false);
  const [extras, setExtras] = useState<string[]>([]);
  const [tears, setTears] = useState(false);
  const [eyesLeft, setEyesLeft] = useState<EyeState>('open');
  const [eyesRight, setEyesRight] = useState<EyeState>('open');
  const [mouth, setMouth] = useState<MouthState>('closed');
  const [blinking, setBlinking] = useState(false);
  const [talking, setTalking] = useState(false);
  const [animateChanges, setAnimateChanges] = useState(false);
  const [motion, setMotion] = useState<SpriteMotionSettings>(DEFAULT_MOTION);
  const [motionLoaded, setMotionLoaded] = useState(false);
  const [motionNotice, setMotionNotice] = useState<string | null>(null);
  const [glFailed, setGlFailed] = useState(false);
  const prefs = useSyncExternalStore(subscribePreferences, getPreferences);
  const debugOverlap = prefs.spriteDebugOverlap;
  // This page's own blend settings, edited from the header popup
  // rather than the settings page. While one is unset, the chat's
  // value applies, so the page only diverges where it was tuned.
  const debugFade = prefs.spriteDebugFade;
  const debugBgOpacity = prefs.spriteDebugBgOpacity;
  const effectiveFade = debugFade ?? prefs.spriteFade;
  const effectiveBgOpacity = debugBgOpacity ?? prefs.messageBgOpacity;
  const foregroundOpacity = prefs.foregroundOpacity;
  const [displaySettingsOpen, setDisplaySettingsOpen] = useState(false);
  // Height-adjust mode, the chat screen's boundary handle brought to
  // this page: on mobile the control column overlaps the sprite the
  // way the message column does, and the handle rewrites this page's
  // own stored overlap (a browser preference, separate from the
  // chat's). The sprite box keeps its size throughout; only how
  // deeply the controls cover it changes.
  const [splitAdjusting, setSplitAdjusting] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);
  const spriteSectionRef = useRef<HTMLElement>(null);
  const splitDragCleanup = useRef<(() => void) | null>(null);
  const loadedAssets = assetState?.sprite === sprite ? assetState.assets : null;
  const hasLoadedAsset = (ref: LayerRef | LayerRef[] | null | undefined): boolean => {
    if (Array.isArray(ref)) return ref.some((item) => hasLoadedAsset(item));
    const path = typeof ref === 'string' ? ref : ref?.path;
    return Boolean(path && loadedAssets?.has(`${sprite.root}/${path}`));
  };
  const availablePoses = poses.filter((id) => poseLayerRefs(sprite.poses[id]).some(hasLoadedAsset));
  const presets = Object.keys(sprite.emotions);
  const selectedPreset = sprite.emotions[preset]
    ? preset
    : presets.includes('neutral')
      ? 'neutral'
      : (presets[0] ?? '');
  const availableExpressions = expressions.filter((id) => {
    const config = sprite.expressions[id];
    return hasLoadedAsset(config.base) || config.mouth.some(hasLoadedAsset);
  });
  const availableMarks = marks.filter((id) => hasLoadedAsset(sprite.marks[id]));
  const splitEyes = hasSplitEyes(sprite);
  const eyesGroup = eyeGroupLists(sprite, 'eyes');
  const availableEyeFrames = [0, 1, 2].map(
    (index) =>
      (eyesGroup.split
        ? [...(eyesGroup.left[index] ?? []), ...(eyesGroup.right[index] ?? [])]
        : (eyesGroup.shared[index] ?? [])
      ).some(hasLoadedAsset) ||
      expressions.some((id) => {
        const config = sprite.expressions[id];
        if (config.eyes_left !== undefined || config.eyes_right !== undefined)
          return (
            (config.eyes_left?.[index] ?? []).some(hasLoadedAsset) ||
            (config.eyes_right?.[index] ?? []).some(hasLoadedAsset)
          );
        return (config.eyes?.[index] ?? []).some(hasLoadedAsset);
      }),
  );
  const tearsGroup = eyeGroupLists(sprite, 'tears');
  const canUseTears = (
    tearsGroup.split ? [...tearsGroup.left, ...tearsGroup.right] : tearsGroup.shared
  ).some((files) => files.some(hasLoadedAsset));
  const extraNames = Object.keys(sprite.extras);
  const canUseExtra = (name: string) => hasLoadedAsset(sprite.extras[name]);
  const canUseThinking = availableMarks.includes('thinking');
  const selectedPose = availablePoses.includes(pose) ? pose : (availablePoses[0] ?? '');
  const selectedExpression = availableExpressions.includes(expression)
    ? expression
    : (availableExpressions[0] ?? '');
  const selectedMark = mark && availableMarks.includes(mark) ? mark : null;
  const mouthFrames = sprite.expressions[selectedExpression]?.mouth ?? [];
  const canUseMouth = mouthFrames.some(hasLoadedAsset);
  const canBlink = availableEyeFrames.some(Boolean) && sprite.blink.cycle.length > 0;
  const canTalk = canUseMouth && sprite.talk.cycle.length > 0;
  const onAssetsLoaded = useCallback(
    (assets: ReadonlySet<string>) => {
      setAssetState({ sprite, assets });
    },
    [sprite],
  );

  useEffect(() => {
    document.title = '立ち絵デバッグ — Remorise';
  }, []);

  useEffect(() => () => splitDragCleanup.current?.(), []);

  const startSplitDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const main = mainRef.current;
    const section = spriteSectionRef.current;
    if (!main || !section) return;
    event.preventDefault();
    const rect = main.getBoundingClientRect();
    const boxHeight = section.clientHeight;
    if (boxHeight <= 0) return;
    const move = (moveEvent: PointerEvent) => {
      setPreferences({
        spriteDebugOverlap: overlapFromBoundary(moveEvent.clientY - rect.top, boxHeight),
      });
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      splitDragCleanup.current = null;
    };
    splitDragCleanup.current?.();
    splitDragCleanup.current = end;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const onSplitKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const current = effectiveSpriteOverlap(debugOverlap);
    setPreferences({ spriteDebugOverlap: current + (event.key === 'ArrowUp' ? 2 : -2) });
  };

  useEffect(() => {
    let cancelled = false;
    getServerSettings()
      .then((settings) => {
        if (cancelled) return;
        setMotion(motionFromSettings(settings));
        setMotionLoaded(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const saveMotion = async () => {
    try {
      const settings = await updateServerSettings({
        sprite_motion_enabled: motion.enabled,
        sprite_motion_amplitude: motion.amplitude,
        sprite_motion_speed: motion.speed,
        sprite_motion_overscan: motion.overscan,
      });
      setMotion(motionFromSettings(settings));
      setMotionNotice('モーション設定を保存しました。');
    } catch {
      setMotionNotice('モーション設定の保存に失敗しました。');
    }
  };

  const applyPreset = () => {
    const appearance = sprite.emotions[selectedPreset];
    if (!appearance) return;
    setPose(appearance.pose);
    setExpression(appearance.expression);
    setMark(appearance.mark);
    setExtras(appearance.extras);
    setTears(appearance.tears);
  };

  if (character.layers !== null && character.layers.available !== true) {
    return (
      <div className="flex h-dvh flex-col overflow-hidden">
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <h1 className="min-w-0 flex-1 truncate text-lg">立ち絵デバッグ</h1>
          <Link to="/" className={buttonClass}>
            会話へ戻る
          </Link>
        </header>
        <p className="p-4 text-sm text-muted">
          このキャラクターには立ち絵データがないため、立ち絵デバッグは使えません。
        </p>
      </div>
    );
  }

  if (glFailed) {
    return (
      <div className="flex h-dvh flex-col overflow-hidden">
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <h1 className="min-w-0 flex-1 truncate text-lg">立ち絵デバッグ</h1>
          <Link to="/" className={buttonClass}>
            会話へ戻る
          </Link>
        </header>
        <p className="p-4 text-sm text-muted">WebGL が利用できないため、立ち絵を表示できません。</p>
      </div>
    );
  }

  const overlapPercent = effectiveSpriteOverlap(debugOverlap);
  const mainStyle = {
    '--sprite-fade': `${effectiveFade}%`,
    '--message-bg-opacity': `${effectiveBgOpacity}%`,
    '--fg-opacity': `${foregroundOpacity}%`,
    ...(debugOverlap !== null
      ? { '--sprite-overlap': `calc(var(--sprite-h) * ${overlapPercent / 100})` }
      : {}),
  } as CSSProperties;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <h1 className="min-w-0 flex-1 truncate text-lg">立ち絵デバッグ</h1>
        <button
          type="button"
          className={`${iconButtonClass} md:hidden`}
          aria-pressed={splitAdjusting}
          aria-label={splitAdjusting ? '高さ調整を終わる' : '立ち絵の高さを調整'}
          title={splitAdjusting ? '高さ調整を終わる' : '立ち絵の高さを調整'}
          onClick={() => setSplitAdjusting((current) => !current)}
        >
          <span className="icon-[mdi--arrow-up-down] text-xl" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`${iconButtonClass} md:hidden`}
          aria-expanded={displaySettingsOpen}
          aria-label="表示設定"
          title="表示設定"
          onClick={() => setDisplaySettingsOpen((current) => !current)}
        >
          <span className="icon-[mdi--tune] text-xl" aria-hidden="true" />
        </button>
        <Link to="/" className={buttonClass}>
          会話へ戻る
        </Link>
      </header>
      {displaySettingsOpen && (
        <div className="grid gap-4 border-b border-line bg-panel px-4 py-4 md:hidden">
          <label className="grid gap-1 text-sm">
            グラデーションの長さ
            <span className="flex items-center gap-3">
              <RangeInput
                min={0}
                max={100}
                value={effectiveFade}
                aria-valuetext={`${effectiveFade}%`}
                className="min-w-0 flex-1"
                onChange={(event) =>
                  setPreferences({ spriteDebugFade: Number(event.target.value) })
                }
              />
              <span className="w-10 shrink-0 text-right">{effectiveFade}%</span>
            </span>
          </label>
          <label className="grid gap-1 text-sm">
            背景の不透明度
            <span className="flex items-center gap-3">
              <RangeInput
                min={MESSAGE_BG_OPACITY_MIN}
                max={100}
                value={effectiveBgOpacity}
                aria-valuetext={`${effectiveBgOpacity}%`}
                className="min-w-0 flex-1"
                onChange={(event) =>
                  setPreferences({ spriteDebugBgOpacity: Number(event.target.value) })
                }
              />
              <span className="w-10 shrink-0 text-right">{effectiveBgOpacity}%</span>
            </span>
          </label>
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 text-xs text-muted">
              この画面専用の表示設定です。未設定の項目はチャットの設定に追従します。
            </p>
            <button
              type="button"
              className={buttonClass}
              disabled={debugFade === null && debugBgOpacity === null}
              onClick={() => setPreferences({ spriteDebugFade: null, spriteDebugBgOpacity: null })}
            >
              チャットに合わせる
            </button>
          </div>
        </div>
      )}
      <div
        ref={mainRef}
        style={mainStyle}
        className="relative flex min-h-0 flex-1 flex-col [--sprite-overlap:calc(var(--sprite-h)*0.4)] [--sprite-h:calc(var(--sprite-w)*1.5)] [--sprite-w:min(100vw,60dvh)] md:flex-row"
      >
        <section
          ref={spriteSectionRef}
          className="flex w-full shrink-0 flex-col border-line max-md:pointer-events-none md:h-full md:w-[min(1024px,calc((100dvh-4rem)*1024/1536))] md:border-r"
        >
          <div className="sprite-art-fade relative mx-auto aspect-1024/1536 w-(--sprite-w) overflow-hidden border-x border-line md:max-h-full md:w-full md:border-0">
            <div
              className="pointer-events-none absolute inset-x-[18%] bottom-[8%] h-1/2 rounded-full bg-gold/15 blur-3xl"
              aria-hidden="true"
            />
            <CharacterSprite
              sprite={sprite}
              pose={selectedPose || 'arms-down'}
              expression={selectedExpression || 'normal'}
              mark={selectedMark}
              thinking={thinking}
              extras={extras}
              tears={tears}
              eyes={eyesLeft}
              eyesLeft={eyesLeft}
              eyesRight={eyesRight}
              mouth={mouth}
              blinking={blinking}
              talking={talking}
              animateChanges={animateChanges}
              motion={motion}
              onAssetsLoaded={onAssetsLoaded}
              onRenderUnavailable={() => setGlFailed(true)}
            />
          </div>
        </section>
        <form
          className="fg-items sprite-fg-fade relative z-10 flex h-full min-h-0 min-w-0 flex-1 flex-col gap-4 self-stretch overflow-y-auto p-4 max-md:-mt-(--sprite-overlap) max-md:bg-[linear-gradient(to_bottom,transparent,color-mix(in_oklch,var(--color-panel)_var(--message-bg-opacity),transparent)_min(var(--sprite-overlap),var(--sprite-fade)))] md:bg-panel/35"
          onSubmit={(event) => event.preventDefault()}
        >
          <label className={`grid gap-1 text-sm ${presets.length === 0 ? disabledLabelClass : ''}`}>
            感情プリセット
            <select
              className={disabledFieldClass}
              value={selectedPreset}
              disabled={presets.length === 0}
              onChange={(event) => setPreset(event.target.value)}
            >
              {presets.length === 0 && <option value="">設定なし</option>}
              {presets.map((id) => (
                <option key={id} value={id}>
                  {emotionLabel(id)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={buttonClass}
              disabled={presets.length === 0}
              onClick={applyPreset}
            >
              プリセットを適用
            </button>
          </label>
          <label
            className={`grid gap-1 text-sm ${availablePoses.length === 0 ? disabledLabelClass : ''}`}
          >
            ポーズ
            <select
              className={disabledFieldClass}
              value={selectedPose}
              disabled={availablePoses.length === 0}
              onChange={(event) => setPose(event.target.value as Pose)}
            >
              {availablePoses.length === 0 && <option value="">設定なし</option>}
              {poses.map((id) => (
                <option key={id} value={id} disabled={!availablePoses.includes(id)}>
                  {poseLabel(sprite, id)}
                </option>
              ))}
            </select>
          </label>
          <label
            className={`grid gap-1 text-sm ${availableExpressions.length === 0 ? disabledLabelClass : ''}`}
          >
            表情
            <select
              className={disabledFieldClass}
              value={selectedExpression}
              disabled={availableExpressions.length === 0}
              onChange={(event) => setExpression(event.target.value as Expression)}
            >
              {availableExpressions.length === 0 && <option value="">設定なし</option>}
              {expressions.map((id) => (
                <option key={id} value={id} disabled={!availableExpressions.includes(id)}>
                  {EXPRESSION_LABELS[id] ?? id}
                </option>
              ))}
            </select>
          </label>
          <label
            className={`grid gap-1 text-sm ${availableMarks.length === 0 ? disabledLabelClass : ''}`}
          >
            マーク
            <select
              className={disabledFieldClass}
              value={selectedMark ?? ''}
              disabled={availableMarks.length === 0}
              onChange={(event) =>
                setMark(event.target.value === '' ? null : (event.target.value as Mark))
              }
            >
              <option value="">なし</option>
              {marks.map((id) => (
                <option key={id} value={id} disabled={!availableMarks.includes(id)}>
                  {MARK_LABELS[id] ?? id}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-4 text-sm">
            {extraNames.map((name) => (
              <label
                key={name}
                className={`flex items-center gap-2 ${canUseExtra(name) ? 'cursor-pointer' : disabledLabelClass}`}
              >
                <input
                  type="checkbox"
                  className="disabled:cursor-not-allowed disabled:opacity-50"
                  checked={extras.includes(name)}
                  disabled={!canUseExtra(name)}
                  onChange={(event) =>
                    setExtras((current) =>
                      event.target.checked
                        ? [...current, name]
                        : current.filter((item) => item !== name),
                    )
                  }
                />
                {EXTRA_LABELS[name] ?? name}
              </label>
            ))}
            <label
              className={`flex items-center gap-2 ${canUseTears ? 'cursor-pointer' : disabledLabelClass}`}
            >
              <input
                type="checkbox"
                className="disabled:cursor-not-allowed disabled:opacity-50"
                checked={tears}
                disabled={!canUseTears}
                onChange={(event) => setTears(event.target.checked)}
              />
              涙
            </label>
            <label
              className={`flex items-center gap-2 ${canUseThinking ? 'cursor-pointer' : disabledLabelClass}`}
            >
              <input
                type="checkbox"
                className="disabled:cursor-not-allowed disabled:opacity-50"
                checked={thinking}
                disabled={!canUseThinking}
                onChange={(event) => setThinking(event.target.checked)}
              />
              考え中マークを重ねる
            </label>
          </div>
          {splitEyes ? (
            <>
              <label
                className={`grid gap-1 text-sm ${availableEyeFrames.some(Boolean) ? '' : disabledLabelClass}`}
              >
                左目
                <select
                  className={disabledFieldClass}
                  value={eyesLeft}
                  onChange={(event) => setEyesLeft(event.target.value as EyeState)}
                >
                  <option value="open">開いている</option>
                  <option value="half">半開き</option>
                  <option value="closed">閉じたまま</option>
                </select>
              </label>
              <label
                className={`grid gap-1 text-sm ${availableEyeFrames.some(Boolean) ? '' : disabledLabelClass}`}
              >
                右目
                <select
                  className={disabledFieldClass}
                  value={eyesRight}
                  onChange={(event) => setEyesRight(event.target.value as EyeState)}
                >
                  <option value="open">開いている</option>
                  <option value="half">半開き</option>
                  <option value="closed">閉じたまま</option>
                </select>
              </label>
            </>
          ) : (
            <label
              className={`grid gap-1 text-sm ${availableEyeFrames.some(Boolean) ? '' : disabledLabelClass}`}
            >
              目
              <select
                className={disabledFieldClass}
                value={eyesLeft}
                onChange={(event) => {
                  const next = event.target.value as EyeState;
                  setEyesLeft(next);
                  setEyesRight(next);
                }}
              >
                <option value="open">開いている</option>
                <option value="half">半開き</option>
                <option value="closed">閉じたまま</option>
              </select>
            </label>
          )}
          <label className={`grid gap-1 text-sm ${canUseMouth ? '' : disabledLabelClass}`}>
            口
            <select
              className={disabledFieldClass}
              value={mouth}
              onChange={(event) => setMouth(event.target.value as MouthState)}
            >
              <option value="closed">閉じている</option>
              <option value="half">半開き</option>
              <option value="open">開いたまま</option>
            </select>
          </label>
          <label
            className={`flex items-center gap-2 text-sm ${canBlink && eyesLeft === 'open' && eyesRight === 'open' ? 'cursor-pointer' : disabledLabelClass}`}
          >
            <input
              type="checkbox"
              className="disabled:cursor-not-allowed disabled:opacity-50"
              checked={blinking}
              disabled={!canBlink || eyesLeft !== 'open' || eyesRight !== 'open'}
              onChange={(event) => setBlinking(event.target.checked)}
            />
            瞬き
          </label>
          <label
            className={`flex items-center gap-2 text-sm ${canTalk ? 'cursor-pointer' : disabledLabelClass}`}
          >
            <input
              type="checkbox"
              className="disabled:cursor-not-allowed disabled:opacity-50"
              checked={talking}
              disabled={!canTalk}
              onChange={(event) => setTalking(event.target.checked)}
            />
            口パク
          </label>
          <label
            className={`flex items-center gap-2 text-sm ${canBlink || canUseMouth ? 'cursor-pointer' : disabledLabelClass}`}
          >
            <input
              type="checkbox"
              className="disabled:cursor-not-allowed disabled:opacity-50"
              checked={animateChanges}
              disabled={!canBlink && !canUseMouth}
              onChange={(event) => setAnimateChanges(event.target.checked)}
            />
            切り替えをアニメーション
          </label>
          {availableEyeFrames.some(Boolean) && (eyesLeft !== 'open' || eyesRight !== 'open') && (
            <p className="text-sm text-muted">目を開いていない間は、選んだフレームのままです。</p>
          )}
          {canTalk && (
            <p className="text-sm text-muted">口パク中は、閉じた状態と開いた状態を繰り返します。</p>
          )}
          <fieldset className="grid gap-3 border-t border-line pt-4" disabled={!motionLoaded}>
            <legend className="text-sm font-medium">モーション</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={motion.enabled}
                onChange={(event) =>
                  setMotion((current) => ({ ...current, enabled: event.target.checked }))
                }
              />
              モーションを有効にする
            </label>
            <label className="grid gap-1 text-sm">
              動きの大きさ（{motion.amplitude.toFixed(2)}）
              <RangeInput
                min={0}
                max={2}
                step={0.05}
                value={motion.amplitude}
                onChange={(event) =>
                  setMotion((current) => ({ ...current, amplitude: Number(event.target.value) }))
                }
              />
            </label>
            <label className="grid gap-1 text-sm">
              速さ（{motion.speed.toFixed(2)}）
              <RangeInput
                min={0.1}
                max={3}
                step={0.05}
                value={motion.speed}
                onChange={(event) =>
                  setMotion((current) => ({ ...current, speed: Number(event.target.value) }))
                }
              />
            </label>
            <label className="grid gap-1 text-sm">
              オーバースキャン（{motion.overscan.toFixed(2)}）
              <RangeInput
                min={1}
                max={1.5}
                step={0.01}
                value={motion.overscan}
                onChange={(event) =>
                  setMotion((current) => ({ ...current, overscan: Number(event.target.value) }))
                }
              />
            </label>
            <div className="flex items-center gap-3">
              <button type="button" className={buttonClass} onClick={() => void saveMotion()}>
                モーション設定を保存
              </button>
              {motionNotice && <p className="text-sm text-muted">{motionNotice}</p>}
            </div>
            <p className="text-sm text-muted">
              プレビューはその場で変わります。保存するとサーバー設定（運用層）に反映され、チャット画面にも適用されます。
            </p>
          </fieldset>
        </form>
        {splitAdjusting && (
          <div
            role="slider"
            tabIndex={0}
            aria-label="立ち絵と操作項目の境界"
            aria-valuemin={SPRITE_OVERLAP_MIN}
            aria-valuemax={SPRITE_OVERLAP_MAX}
            aria-valuenow={overlapPercent}
            aria-valuetext={`被さり ${overlapPercent}%`}
            className="absolute left-1/2 z-20 flex h-11 w-24 cursor-ns-resize touch-none items-center justify-center md:hidden"
            style={{
              top: `calc(var(--sprite-h) * ${1 - overlapPercent / 100})`,
              transform: 'translate(-50%, -50%)',
            }}
            onPointerDown={startSplitDrag}
            onKeyDown={onSplitKeyDown}
          >
            <span className="flex h-6 w-16 items-center justify-center rounded-full border border-line bg-panel-2 shadow-md">
              <span className="icon-[mdi--drag-vertical] text-base text-muted" aria-hidden="true" />
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
