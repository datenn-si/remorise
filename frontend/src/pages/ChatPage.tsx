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
import { Link, useLocation } from 'react-router-dom';
import { CharacterSprite } from '../components/character/CharacterSprite';
import { CharacterStatus } from '../components/character/CharacterStatus';
import { MessageInput } from '../components/chat/MessageInput';
import { MessageList } from '../components/chat/MessageList';
import { Banner } from '../components/common/Banner';
import { InsecureNotice } from '../components/common/InsecureNotice';
import { Modal } from '../components/common/Modal';
import { useCharacter } from '../hooks/useCharacter';
import { useChat } from '../hooks/useChat';
import { useFullscreen } from '../hooks/useFullscreen';
import { useHealth } from '../hooks/useHealth';
import { useInferenceStatus } from '../hooks/useInferenceStatus';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { useViewportShift } from '../hooks/useViewportShift';
import {
  activityLabel,
  inputLocked,
  showsBackgroundThinking,
  showsRemoteSpeaking,
  spriteFlags,
} from '../lib/chatState';
import { CONNECTION_ERROR_MESSAGE } from '../lib/errors';
import { isPlainHttpRemote } from '../lib/insecureContext';
import { affinityLabel, emotionLabel } from '../lib/labels';
import { getPreferences, setPreferences, subscribePreferences } from '../lib/preferences';
import { AWAY_PATHS } from '../lib/routes';
import {
  SPRITE_OVERLAP_MAX,
  SPRITE_OVERLAP_MIN,
  effectiveSpriteOverlap,
  overlapFromBoundary,
} from '../lib/spriteOverlap';
import { getDebugSummaries, listDebugJobs } from '../services/debug';
import { getServerSettings } from '../services/settings';
import type { DisplayMessage } from '../types/chat';
import type { DebugJob, DebugSummary } from '../types/debug';
import { appearanceForEmotion, DEFAULT_SPRITE } from '../lib/spriteLayers';
import { DEFAULT_MOTION, motionFromSettings, type SpriteMotionSettings } from '../lib/spriteMotion';
import { iconButtonClass } from '../lib/ui';

export function ChatPage() {
  const character = useCharacter();
  const [healthVersion, setHealthVersion] = useState(0);
  const online = useHealth(healthVersion);
  const [reconnecting, setReconnecting] = useState(false);
  const [draft, setDraft] = useState('');
  // A rejected send hands its text back here so it can be edited and
  // resent (or dropped) instead of being lost with the turn.
  const restoreDraft = useCallback((text: string) => setDraft(text), []);
  const prefs = useSyncExternalStore(subscribePreferences, getPreferences);
  const debug = prefs.debug;
  const debugExpandDefault = prefs.debugExpand;
  const spriteFade = prefs.spriteFade;
  const spriteOverlap = prefs.spriteOverlap;
  const messageBgOpacity = prefs.messageBgOpacity;
  const foregroundOpacity = prefs.foregroundOpacity;
  const fullscreen = useFullscreen();
  // Debug loads include rows invalidated by forgetting (marked as
  // such); normal loads are the active conversation only.
  const chat = useChat(character.setState, restoreDraft, debug);
  const [spriteOn, setSpriteOn] = useState(true);
  const [headerButtonsOpen, setHeaderButtonsOpen] = useState(true);
  const buttonStripRef = useRef<HTMLDivElement>(null);
  const [stripFade, setStripFade] = useState({ left: false, right: false });
  const updateStripFade = useCallback(() => {
    const strip = buttonStripRef.current;
    if (!strip) return;
    const left = strip.scrollLeft > 0;
    const right = strip.scrollWidth - strip.clientWidth - strip.scrollLeft > 1;
    setStripFade((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);
  useEffect(() => {
    window.addEventListener('resize', updateStripFade);
    return () => window.removeEventListener('resize', updateStripFade);
  }, [updateStripFade]);
  useEffect(() => {
    updateStripFade();
  });
  // WebGL rendering of the sprite turned out to be impossible on
  // this device: the sprite area drops out entirely (the same
  // layout as a character with no sprite art) and a banner says
  // why. There is no fallback draw.
  const [spriteGlFailed, setSpriteGlFailed] = useState(false);
  const [spriteGlNoticeDismissed, setSpriteGlNoticeDismissed] = useState(false);
  const [motion, setMotion] = useState<SpriteMotionSettings>(DEFAULT_MOTION);
  // The OS reduced-motion setting wins over the server setting: the
  // sprite warp runs from JS, so the CSS media query cannot stop it.
  const reducedMotion = usePrefersReducedMotion();
  const effectiveMotion = reducedMotion ? { ...motion, enabled: false } : motion;
  const [statusOpen, setStatusOpen] = useState(false);
  // Height-adjust mode: a drag handle on the sprite/message boundary
  // rewrites the stored overlap (a browser preference), live as it
  // moves. The sprite box keeps its default size throughout; only how
  // deeply the message column covers it changes.
  const [splitAdjusting, setSplitAdjusting] = useState(false);
  const spriteSectionRef = useRef<HTMLElement>(null);
  const splitDragCleanup = useRef<(() => void) | null>(null);
  // Banners overlay the content just under the header (fixed) instead
  // of taking flow height, so their appearance never shifts the
  // layout; the offset tracks the header's measured height. On mobile
  // the expanded header buttons float over the content instead of
  // growing the header, so their height is added while they float —
  // the banners always start below the buttons.
  const headerRef = useRef<HTMLElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const buttonPanelRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const [bannerTop, setBannerTop] = useState(0);
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const update = () => {
      const panel = buttonPanelRef.current;
      const floating = panel !== null && getComputedStyle(panel).position === 'absolute';
      setBannerTop(header.offsetHeight + (floating ? panel.offsetHeight : 0));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    if (buttonPanelRef.current) observer.observe(buttonPanelRef.current);
    return () => observer.disconnect();
  }, [headerButtonsOpen]);
  // The software keyboard never resizes this layout: the header
  // stays pinned to the visual top and the main region slides up
  // underneath it, while the sprite section is counter-shifted so
  // the character itself does not move (see useViewportShift).
  const [inputFocused, setInputFocused] = useState(false);
  useViewportShift(headerRef, bannerRef, mainRef, spriteSectionRef, setInputFocused);

  useEffect(() => () => splitDragCleanup.current?.(), []);

  const toggleSplitAdjust = () => {
    // Nothing to adopt when nothing is stored: the handle rests at
    // the default overlap the layout is already showing.
    setSplitAdjusting((current) => !current);
  };

  const startSplitDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const main = mainRef.current;
    const section = spriteSectionRef.current;
    if (!main || !section) return;
    event.preventDefault();
    const rect = main.getBoundingClientRect();
    // The box never resizes, so its height is fixed for the whole
    // drag; the boundary's place inside it is what the drag rewrites.
    const boxHeight = section.clientHeight;
    if (boxHeight <= 0) return;
    const move = (moveEvent: PointerEvent) => {
      setPreferences({
        spriteOverlap: overlapFromBoundary(moveEvent.clientY - rect.top, boxHeight),
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
    // The arrows move the handle itself: up deepens the overlap,
    // down shallows it. The clamp runs inside setPreferences.
    const current = effectiveSpriteOverlap(spriteOverlap);
    setPreferences({ spriteOverlap: current + (event.key === 'ArrowUp' ? 2 : -2) });
  };

  const { pathname } = useLocation();
  // Debug mode renders background jobs as rows in the chat timeline,
  // positioned by their recorded timestamps. Refetch when a turn
  // settles (jobs are registered at turn boundaries); fetch errors are
  // left to the /pipeline page to surface, the timeline keeps its
  // last list.
  const [debugJobs, setDebugJobs] = useState<DebugJob[]>([]);
  const [debugSummaries, setDebugSummaries] = useState<DebugSummary[]>([]);
  const messageCount = chat.messages.length;
  const phase = chat.phase;
  useEffect(() => {
    if (!debug) {
      setDebugJobs([]);
      setDebugSummaries([]);
      return;
    }
    if (phase !== 'idle') return;
    let cancelled = false;
    listDebugJobs()
      .then((jobs) => {
        if (!cancelled) setDebugJobs(jobs);
      })
      .catch(() => {});
    getDebugSummaries()
      .then((summaries) => {
        if (!cancelled) setDebugSummaries(summaries);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [debug, phase, messageCount]);
  const reloadHistory = chat.reloadHistory;
  const messagesRef = useRef(chat.messages);
  messagesRef.current = chat.messages;
  // A turn can finish on the backend without this page streaming it
  // (it was sent from a tab that has since closed, or this page's
  // stream dropped): the backend completes accepted turns on its own.
  // When inference settles after a foreground turn and the visible
  // history still ends in an unanswered message, pull the completed
  // reply in instead of waiting for a manual reload.
  const handleForegroundSettled = useCallback(() => {
    if (messagesRef.current.some((message) => message.dangling)) reloadHistory();
  }, [reloadHistory]);
  const inferenceStatus = useInferenceStatus({ onForegroundSettled: handleForegroundSettled });
  const flags = spriteFlags(chat.phase);
  const backgroundThinking = showsBackgroundThinking(inferenceStatus, chat.phase);
  const remoteSpeaking = showsRemoteSpeaking(inferenceStatus, chat.phase);
  const emotion = character.state?.emotion;
  const sprite = character.layers ?? DEFAULT_SPRITE;
  // The backend decides whether the character has any sprite art at
  // all; without it the chat shows no sprite area (and no placeholder).
  const spriteAvailable = character.layers?.available === true;
  const spriteRenderable = spriteAvailable && !spriteGlFailed;
  const showSprite = spriteRenderable && spriteOn;
  const look = appearanceForEmotion(emotion, sprite);
  const name = character.profile?.name ?? 'キャラクター';
  const feeling = emotionLabel(emotion);
  // While background work is using inference (or a send is queued
  // behind it), show the same soft thinking label as a turn's own
  // thinking phase — never system wording.
  const activity =
    activityLabel(chat.phase, chat.toolName) ??
    (remoteSpeaking ? activityLabel('speaking', null) : null) ??
    (backgroundThinking ? activityLabel('thinking', null) : null);
  const locked = inputLocked({ phase: chat.phase, loadingHistory: chat.loadingHistory });
  const affinity = character.state?.affinity;

  useEffect(() => {
    if (AWAY_PATHS.has(pathname)) return;
    document.title = character.profile ? `${character.profile.name} — Remorise` : 'Remorise';
  }, [character.profile, pathname]);

  useEffect(() => {
    let cancelled = false;
    getServerSettings()
      .then((settings) => {
        if (!cancelled) setMotion(motionFromSettings(settings));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const retry = () => {
    setHealthVersion((version) => version + 1);
    void character.reload();
    chat.reloadHistory();
  };
  // The offline banner's retry: the same reloads, plus a visible
  // in-progress state. The health flag does not move while a recheck
  // runs (it flips only on a result), so without this the tap would
  // look like nothing happened. The character reload stands in for
  // the attempt — it settles when the backend answers or fails — and
  // a short floor keeps the state on screen long enough to be seen.
  const retryOffline = async () => {
    if (reconnecting) return;
    setReconnecting(true);
    setHealthVersion((version) => version + 1);
    chat.reloadHistory();
    await Promise.all([
      Promise.resolve(character.reload()).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 600)),
    ]);
    setReconnecting(false);
  };
  const showOfflineBanner = online === false && !character.error && !chat.banner;
  // The plain-http notice shows once until dismissed (the dismissal
  // is a stored preference); the settings page always shows it.
  const [plainHttpRemote] = useState(
    () => typeof window !== 'undefined' && isPlainHttpRemote(window.location),
  );
  const showInsecureNotice = plainHttpRemote && !prefs.insecureNoticeDismissed;

  // Stable identity so memoized message rows are not invalidated by
  // a fresh closure on every render.
  const resend = chat.resend;
  const resendMessage = useCallback(
    (message: DisplayMessage) => {
      void resend(message.id);
    },
    [resend],
  );

  const submit = async () => {
    const text = draft;
    if (!text.trim() || locked || online === false) return;
    setDraft('');
    const result = await chat.send(text);
    if (result === 'restore') setDraft(text);
  };

  const connection =
    online === null
      ? { text: '接続確認中', dot: 'bg-yellow-400' }
      : online
        ? { text: '接続済み', dot: 'bg-green-500' }
        : { text: '未接続', dot: 'bg-red-500' };

  // Layout variables for the sprite/message overlap. A stored overlap
  // replaces the default 0.4 ratio for --sprite-overlap. The blend
  // length and the message background's opacity are handed over as
  // variables the same way, so the blend at the top of the message
  // column can run from transparent up to that opacity over the
  // reader's gradient length; only the sprite's own dissolve at its
  // feet is a fixed length, defined with the mask in index.css.
  // The sprite box size variables always keep their class defaults.
  const overlapPercent = effectiveSpriteOverlap(spriteOverlap);
  const mainStyle = {
    '--sprite-fade': `${spriteFade}%`,
    '--message-bg-opacity': `${messageBgOpacity}%`,
    ...(spriteOverlap !== null
      ? { '--sprite-overlap': `calc(var(--sprite-h) * ${overlapPercent / 100})` }
      : {}),
  } as CSSProperties;

  return (
    // touch-none / overscroll-none: nothing in this layout scrolls as
    // a page, so no gesture may pan the visual viewport either — with
    // the keyboard open, such a pan would drag the counter-translated
    // sprite off its fixed position even though it cannot scroll.
    <div
      className="flex h-dvh touch-none flex-col overflow-hidden overscroll-none"
      style={{ height: 'var(--app-h, 100dvh)' }}
    >
      <header
        ref={headerRef}
        className="relative z-30 flex flex-col gap-2 border-b border-line bg-canvas px-4 py-3 sm:flex-row sm:items-center sm:gap-3"
      >
        <div className="flex items-start gap-2 sm:flex-1">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg">{name}</h1>
            <p className="truncate text-sm text-muted">
              {feeling}
              {affinity !== undefined ? ` · 好感度 ${affinity}（${affinityLabel(affinity)}）` : ''}
              {' · '}
              <span
                className={`mr-1 inline-block h-2 w-2 rounded-full align-middle ${connection.dot}`}
                aria-hidden="true"
              />
              {connection.text}
            </p>
          </div>
          <button
            type="button"
            className={`${iconButtonClass} sm:hidden`}
            aria-expanded={headerButtonsOpen}
            aria-label={headerButtonsOpen ? 'ボタンを隠す' : 'ボタンを表示'}
            title={headerButtonsOpen ? 'ボタンを隠す' : 'ボタンを表示'}
            onClick={() => setHeaderButtonsOpen((open) => !open)}
          >
            <span
              className={`${
                headerButtonsOpen ? 'icon-[mdi--chevron-up]' : 'icon-[mdi--chevron-down]'
              } text-xl`}
              aria-hidden="true"
            />
          </button>
        </div>
        <div
          ref={buttonPanelRef}
          className={`relative ${
            headerButtonsOpen
              ? 'max-sm:absolute max-sm:inset-x-0 max-sm:top-full max-sm:z-30 max-sm:border-b max-sm:border-line max-sm:bg-canvas max-sm:px-4 max-sm:py-2 max-sm:shadow-lg'
              : 'max-sm:hidden'
          }`}
        >
          <div
            ref={buttonStripRef}
            onScroll={updateStripFade}
            className="scrollbar-none -mx-1 flex items-center gap-2 overflow-x-auto px-1 py-0.5"
          >
            {spriteRenderable && (
              <button
                type="button"
                className={`${iconButtonClass} md:hidden`}
                aria-pressed={spriteOn}
                aria-label={spriteOn ? '立ち絵を隠す' : '立ち絵を表示'}
                title={spriteOn ? '立ち絵を隠す' : '立ち絵を表示'}
                onClick={() => setSpriteOn((shown) => !shown)}
              >
                <span
                  className={`${spriteOn ? 'icon-[mdi--image-off]' : 'icon-[mdi--image]'} text-xl`}
                  aria-hidden="true"
                />
              </button>
            )}
            {spriteRenderable && (
              <button
                type="button"
                className={`${iconButtonClass} md:hidden`}
                aria-pressed={splitAdjusting}
                aria-label={splitAdjusting ? '高さ調整を終わる' : 'チャットの高さを調整'}
                title={splitAdjusting ? '高さ調整を終わる' : 'チャットの高さを調整'}
                onClick={toggleSplitAdjust}
              >
                <span className="icon-[mdi--arrow-up-down] text-xl" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className={iconButtonClass}
              aria-label="情報"
              title="情報"
              onClick={() => setStatusOpen(true)}
            >
              <span className="icon-[mdi--information] text-xl" aria-hidden="true" />
            </button>
            {debug && (
              <div
                role="group"
                aria-label="デバッグ"
                className="flex shrink-0 items-center gap-1.5 rounded-full px-1.5 py-1 ring-1 ring-line"
              >
                <span className="icon-[mdi--bug] px-1 text-xl text-muted" aria-hidden="true" />
                <Link to="/memories" className={iconButtonClass} aria-label="記憶" title="記憶">
                  <span className="icon-[mdi--head-snowflake] text-xl" aria-hidden="true" />
                </Link>
                {spriteAvailable && (
                  <Link
                    to="/sprites"
                    className={iconButtonClass}
                    aria-label="立ち絵"
                    title="立ち絵"
                  >
                    <span className="icon-[mdi--layers] text-xl" aria-hidden="true" />
                  </Link>
                )}
                <Link
                  to="/pipeline"
                  className={iconButtonClass}
                  aria-label="パイプライン"
                  title="パイプライン"
                >
                  <span className="icon-[mdi--sitemap] text-xl" aria-hidden="true" />
                </Link>
              </div>
            )}
            {fullscreen.supported && (
              <button
                type="button"
                className={iconButtonClass}
                aria-pressed={fullscreen.fullscreen}
                aria-label={fullscreen.fullscreen ? '全画面を終了' : '全画面表示'}
                title={fullscreen.fullscreen ? '全画面を終了' : '全画面表示'}
                onClick={fullscreen.toggle}
              >
                <span
                  className={`${
                    fullscreen.fullscreen ? 'icon-[mdi--fullscreen-exit]' : 'icon-[mdi--fullscreen]'
                  } text-xl`}
                  aria-hidden="true"
                />
              </button>
            )}
            <Link
              to="/settings/about"
              className={iconButtonClass}
              aria-label="Remorise について"
              title="Remorise について"
            >
              <span className="icon-[mdi--help-circle-outline] text-xl" aria-hidden="true" />
            </Link>
            <Link to="/settings" className={iconButtonClass} aria-label="設定" title="設定">
              <span className="icon-[mdi--cog] text-xl" aria-hidden="true" />
            </Link>
          </div>
          {stripFade.left && (
            <div
              className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-canvas to-transparent"
              aria-hidden="true"
            />
          )}
          {stripFade.right && (
            <div
              className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-canvas to-transparent"
              aria-hidden="true"
            />
          )}
        </div>
      </header>

      {(character.error ||
        (spriteGlFailed && !spriteGlNoticeDismissed) ||
        (chat.banner && chat.banner.text !== character.error) ||
        showOfflineBanner ||
        showInsecureNotice) && (
        <div
          ref={bannerRef}
          className="pointer-events-none fixed inset-x-0 z-40 flex flex-col overflow-y-auto"
          style={{ top: bannerTop, maxHeight: `calc(var(--app-h, 100dvh) - ${bannerTop}px)` }}
        >
          {character.error && (
            <div className="pointer-events-auto">
              <Banner tone="error" text={character.error} onRetry={retry} />
            </div>
          )}
          {showOfflineBanner && (
            <div className="pointer-events-auto">
              {reconnecting ? (
                <Banner tone="info" text="バックエンドに再接続しています…" />
              ) : (
                <Banner
                  tone="error"
                  text={CONNECTION_ERROR_MESSAGE}
                  onRetry={() => void retryOffline()}
                />
              )}
            </div>
          )}
          {spriteGlFailed && !spriteGlNoticeDismissed && (
            <div className="pointer-events-auto">
              <Banner
                tone="error"
                text="WebGL が利用できないため、立ち絵を表示できません。"
                onDismiss={() => setSpriteGlNoticeDismissed(true)}
              />
            </div>
          )}
          {chat.banner && chat.banner.text !== character.error && (
            <div className="pointer-events-auto">
              <Banner
                tone={chat.banner.tone}
                text={chat.banner.text}
                onDismiss={chat.dismissBanner}
                onRetry={chat.banner.retry ? retry : undefined}
              />
            </div>
          )}
          {showInsecureNotice && (
            <div className="pointer-events-auto">
              <InsecureNotice onDismiss={() => setPreferences({ insecureNoticeDismissed: true })} />
            </div>
          )}
        </div>
      )}

      <div
        ref={mainRef}
        style={mainStyle}
        className="relative flex min-h-0 flex-1 flex-col [--sprite-overlap:calc(var(--sprite-h)*0.4)] [--sprite-h:calc(var(--sprite-w)*1.5)] [--sprite-w:min(100vw,calc(var(--app-h,100dvh)*0.6))] md:flex-row"
      >
        {spriteRenderable && (
          <section
            ref={spriteSectionRef}
            className={`flex w-full shrink-0 flex-col border-line max-md:pointer-events-none md:h-full md:w-fit md:max-w-[min(1024px,calc((var(--app-h,100dvh)-4rem)*1024/1536))] md:border-r ${
              showSprite ? '' : 'max-md:hidden'
            }`}
          >
            <div className="sprite-art-fade relative mx-auto aspect-1024/1536 w-(--sprite-w) overflow-hidden md:mx-0 md:h-full md:w-auto">
              {!inputFocused && (
                <div
                  className="pointer-events-none absolute inset-x-[18%] bottom-[8%] h-1/2 rounded-full bg-gold/15 blur-3xl"
                  aria-hidden="true"
                />
              )}
              <CharacterSprite
                sprite={sprite}
                pose={look.pose}
                expression={look.expression}
                mark={look.mark}
                thinking={flags.isThinking || backgroundThinking}
                extras={look.extras}
                tears={look.tears}
                eyes="open"
                mouth="closed"
                blinking
                talking={flags.isSpeaking || remoteSpeaking}
                motion={effectiveMotion}
                label={`${name}、${feeling}`}
                onRenderUnavailable={() => setSpriteGlFailed(true)}
              />
            </div>
          </section>
        )}
        <section
          className={`relative z-10 flex min-h-0 min-w-0 flex-1 flex-col ${
            showSprite
              ? 'sprite-fg-fade max-md:-mt-(--sprite-overlap) max-md:bg-[linear-gradient(to_bottom,transparent,color-mix(in_oklch,var(--color-panel)_var(--message-bg-opacity),transparent)_min(var(--sprite-overlap),var(--sprite-fade)))] md:bg-panel/35'
              : 'bg-panel/35'
          }`}
        >
          {/* The foreground opacity covers the reading content only;
              the composer below stays solid so typing never washes out. */}
          <div
            className="relative flex min-h-0 flex-1 flex-col"
            style={{ opacity: foregroundOpacity / 100 }}
          >
            <MessageList
              messages={chat.messages}
              loading={chat.loadingHistory}
              activity={activity}
              debug={debug}
              debugExpandDefault={debugExpandDefault}
              trace={chat.trace}
              jobs={debug ? debugJobs : undefined}
              summaries={debug ? debugSummaries : undefined}
              hasMoreHistory={chat.hasMoreHistory}
              loadingOlderHistory={chat.loadingOlderHistory}
              onLoadOlder={() => void chat.loadOlderHistory()}
              onResend={chat.phase === 'idle' && !chat.loadingHistory ? resendMessage : undefined}
              topFadeSpacer={showSprite}
            />
            {activity ? (
              // Floats over the foot of the message list: it takes no
              // layout space, and its background fades from the message
              // surface at the bottom edge up to transparent, so the
              // messages underneath show through as it rises.
              <p
                aria-live="polite"
                className="pointer-events-none absolute inset-x-0 bottom-0 bg-[linear-gradient(to_top,color-mix(in_oklch,var(--color-panel)_var(--message-bg-opacity),transparent),transparent)] px-4 pt-10 pb-1 text-sm text-gold-text"
              >
                {activity}
              </p>
            ) : null}
          </div>
          <MessageInput
            value={draft}
            locked={locked}
            offline={online === false}
            onChange={setDraft}
            onSend={() => void submit()}
          />
        </section>
        {splitAdjusting && showSprite && (
          <div
            role="slider"
            tabIndex={0}
            aria-label="立ち絵とメッセージの境界"
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

      <Modal open={statusOpen} title="キャラクター" onClose={() => setStatusOpen(false)}>
        <CharacterStatus profile={character.profile} state={character.state} />
      </Modal>
    </div>
  );
}
