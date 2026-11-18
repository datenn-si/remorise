import { useEffect, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { InsecureNotice } from '../components/common/InsecureNotice';
import { useInferenceStatus } from '../hooks/useInferenceStatus';
import { RangeInput } from '../components/common/RangeInput';
import { ServerSettingsForm } from '../components/settings/ServerSettingsForm';
import {
  FOREGROUND_OPACITY_MIN,
  MESSAGE_BG_OPACITY_MIN,
  getEffectiveHue,
  getPreferences,
  setPreferences,
  subscribePreferences,
} from '../lib/preferences';
import { buttonClass, fieldClass } from '../lib/ui';

export function SettingsPage() {
  const prefs = useSyncExternalStore(subscribePreferences, getPreferences);
  const shownHue = useSyncExternalStore(subscribePreferences, getEffectiveHue);
  const characterThemeActive = prefs.characterTheme;
  const inferenceStatus = useInferenceStatus();
  const turnInProgress = inferenceStatus?.active === 'foreground';

  useEffect(() => {
    document.title = '設定 — Remorise';
  }, []);

  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col overflow-hidden px-4">
      <header className="flex items-center gap-3 py-4">
        <Link to="/" className={buttonClass}>
          会話へ戻る
        </Link>
        <h1 className="text-lg">設定</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        <div className="mb-5 empty:hidden">
          <InsecureNotice />
        </div>
        <form className="grid max-w-md gap-5" onSubmit={(event) => event.preventDefault()}>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={prefs.debug}
              disabled={turnInProgress}
              onChange={(event) => setPreferences({ debug: event.target.checked })}
            />
            <span>
              デバッグモード
              <span className="mt-1 block text-muted">
                記憶の閲覧、会話履歴の物理削除、立ち絵の確認、トークンの内訳を表示します。
              </span>
              {turnInProgress && (
                <span className="mt-1 block text-muted">
                  キャラクターの発話中は切り替えできません。
                </span>
              )}
            </span>
          </label>
          {prefs.debug && (
            <label className="-mt-2 ml-7 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={prefs.debugExpand}
                onChange={(event) => setPreferences({ debugExpand: event.target.checked })}
              />
              <span>
                デバッグ情報をデフォルトで展開する
                <span className="mt-1 block text-muted">
                  前段処理、パイプライン、要約などの情報ブロックを、最初から開いた状態で表示します（トークン消費は常に表示されます）。
                </span>
              </span>
            </label>
          )}
          <label className="grid gap-1 text-sm">
            配色
            <select
              className={fieldClass}
              value={prefs.scheme}
              onChange={(event) =>
                setPreferences({ scheme: event.target.value as 'device' | 'light' | 'dark' })
              }
            >
              <option value="device">デバイス</option>
              <option value="light">ライト</option>
              <option value="dark">ダーク</option>
            </select>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={prefs.characterTheme}
              onChange={(event) => setPreferences({ characterTheme: event.target.checked })}
            />
            <span>
              キャラクターのテーマ色相を使う
              <span className="mt-1 block text-muted">
                有効にすると、色相はキャラクター設定のテーマ色相に追随します。テーマ色相を持たないキャラクターでは、既定の色相（314）になります。
              </span>
            </span>
          </label>
          <label
            className={`grid gap-1 text-sm ${characterThemeActive ? 'saturate-0 opacity-60' : ''}`}
          >
            色相
            <span className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="h-6 w-6 shrink-0 rounded-full ring-1 ring-ink/50"
                style={{ backgroundColor: `oklch(0.45 0.16 ${shownHue})` }}
              ></span>
              <RangeInput
                min={0}
                max={360}
                value={shownHue}
                aria-valuetext={String(shownHue)}
                disabled={characterThemeActive}
                className="min-w-0 flex-1"
                onChange={(event) => setPreferences({ hue: Number(event.target.value) })}
              />
            </span>
          </label>
          <label className="grid gap-1 text-sm">
            グラデーションの長さ
            <span className="flex items-center gap-3">
              <RangeInput
                min={0}
                max={100}
                value={prefs.spriteFade}
                aria-valuetext={`${prefs.spriteFade}%`}
                className="min-w-0 flex-1"
                onChange={(event) => setPreferences({ spriteFade: Number(event.target.value) })}
              />
              <span className="w-10 shrink-0 text-right">{prefs.spriteFade}%</span>
            </span>
            <span className="text-muted">
              立ち絵とメッセージの境目をぼかす長さです。メッセージ領域の高さに対する割合で決まります。立ち絵の足元のぼかしは固定で、この設定では変わりません。
            </span>
          </label>
          <label className="grid gap-1 text-sm">
            メッセージ背景の不透明度
            <span className="flex items-center gap-3">
              <RangeInput
                min={MESSAGE_BG_OPACITY_MIN}
                max={100}
                value={prefs.messageBgOpacity}
                aria-valuetext={`${prefs.messageBgOpacity}%`}
                className="min-w-0 flex-1"
                onChange={(event) =>
                  setPreferences({ messageBgOpacity: Number(event.target.value) })
                }
              />
              <span className="w-10 shrink-0 text-right">{prefs.messageBgOpacity}%</span>
            </span>
            <span className="text-muted">
              立ち絵に被さるメッセージ領域の背景の濃さです。100%で不透明、下げるほど立ち絵が透けて見えます。
            </span>
          </label>
          <label className="grid gap-1 text-sm">
            文字・項目の不透明度
            <span className="flex items-center gap-3">
              <RangeInput
                min={FOREGROUND_OPACITY_MIN}
                max={100}
                value={prefs.foregroundOpacity}
                aria-valuetext={`${prefs.foregroundOpacity}%`}
                className="min-w-0 flex-1"
                onChange={(event) =>
                  setPreferences({ foregroundOpacity: Number(event.target.value) })
                }
              />
              <span className="w-10 shrink-0 text-right">{prefs.foregroundOpacity}%</span>
            </span>
            <span className="text-muted">
              メッセージの文字や項目そのものの濃さです。下限は背景の不透明度と同じで、それより薄くはなりません。
            </span>
          </label>
        </form>
        <div className="mt-10 border-t border-line pt-6">
          <ServerSettingsForm />
        </div>
      </div>
    </div>
  );
}
