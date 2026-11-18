import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSpriteAnimation } from '../../hooks/useSpriteAnimation';
import {
  allSpriteLayerUrls,
  DEFAULT_SPRITE,
  isHurriedExpression,
  spriteLayerGroups,
  type Expression,
  type EyeState,
  type LayerGroup,
  type Mark,
  type MouthState,
  type Pose,
  type ResolvedLayer,
  type SpriteConfig,
} from '../../lib/spriteLayers';
import {
  DEFAULT_MOTION,
  createMotionState,
  identityTransform,
  impulseMotion,
  spriteTransform,
  stepMotion,
  type MotionState,
  type SpriteMotionSettings,
  type SpriteTransform,
} from '../../lib/spriteMotion';
import { loadSpriteImages } from '../../lib/spriteImageLoader';
import {
  buildMesh,
  DEFAULT_WARP,
  PARALLAX_REAR_ENLARGE,
  rearWarpSettings,
  type WarpSettings,
} from '../../lib/spriteMesh';
import {
  createSpriteGlRenderer,
  type SpriteGlRenderer,
  type SpriteSheet,
} from '../../lib/spriteGl';

/**
 * Mesh-warp draw. The visible layers are composited into offscreen
 * images (cached per layer set and surface scale) and drawn
 * through the warp mesh — a composite bends as one sheet, so
 * layers within a sheet cannot drift relative to each other; the
 * only per-layer change is still which image is swapped in
 * (blink, mouth, expression), which simply recomposites the
 * cache. Rasterization is WebGL (spriteGl.ts).
 *
 * Layers marked `rear` (back-side parts such as back hair) are
 * composited into their own sheet — drawn a little larger about
 * the canvas center — and drawn behind the front sheet with a
 * dampened warp (spriteMesh.ts: rearWarpSettings), so the two
 * sheets drift against each other by a few pixels at most — the
 * parallax. Sprites without rear layers take the single-sheet
 * path, unchanged. The static (motion-off) draw always uses the
 * single sheet: parallax is a motion, and a still sprite must
 * align exactly as authored.
 */
type CompositeCache = { key: string; canvas: HTMLCanvasElement | null };

const compositeCache: CompositeCache = { key: '', canvas: null };
const frontCache: CompositeCache = { key: '', canvas: null };
const rearCache: CompositeCache = { key: '', canvas: null };

function compositeFor(
  cache: CompositeCache,
  layers: ResolvedLayer[],
  images: ReadonlyMap<string, HTMLImageElement>,
  sprite: SpriteConfig,
  scale: number,
  enlarge = 1,
): HTMLCanvasElement {
  const key = [layers.map((layer) => layer.url).join(','), Math.round(scale * 100)].join('@');
  if (cache.key !== key || !cache.canvas) {
    const offscreen = document.createElement('canvas');
    offscreen.width = Math.max(1, Math.round(sprite.image.width * scale));
    offscreen.height = Math.max(1, Math.round(sprite.image.height * scale));
    const offContext = offscreen.getContext('2d');
    if (offContext) {
      offContext.setTransform(scale, 0, 0, scale, 0, 0);
      if (enlarge !== 1) {
        // The rear sheet is drawn a little larger about the canvas
        // center, so its parts keep covering behind the front
        // sheet while the two sheets drift against each other.
        offContext.translate(sprite.image.width / 2, sprite.image.height / 2);
        offContext.scale(enlarge, enlarge);
        offContext.translate(-sprite.image.width / 2, -sprite.image.height / 2);
      }
      for (const layer of layers) {
        const image = images.get(layer.url);
        // Missing files are simply not drawn; nothing substitutes for them.
        if (image) offContext.drawImage(image, layer.x, layer.y);
      }
    }
    cache.key = key;
    cache.canvas = offscreen;
  }
  return cache.canvas;
}

function flattenGroups(groups: LayerGroup[]): ResolvedLayer[] {
  return groups.flatMap((group) => group.layers);
}

function drawSprite(
  renderer: SpriteGlRenderer,
  groups: LayerGroup[],
  images: ReadonlyMap<string, HTMLImageElement>,
  sprite: SpriteConfig,
  transform: SpriteTransform,
  scale: number,
  timeMs: number,
  warp: WarpSettings,
) {
  const composite = compositeFor(compositeCache, flattenGroups(groups), images, sprite, scale);
  const mesh = buildMesh(timeMs, sprite.image, transform, warp);
  renderer.draw(composite, mesh, scale);
}

function drawSpriteAnimated(
  renderer: SpriteGlRenderer,
  groups: LayerGroup[],
  images: ReadonlyMap<string, HTMLImageElement>,
  sprite: SpriteConfig,
  transform: SpriteTransform,
  scale: number,
  timeMs: number,
  warp: WarpSettings,
) {
  const layers = flattenGroups(groups);
  const rear = layers.filter((layer) => layer.depth === 'rear');
  if (rear.length === 0) {
    drawSprite(renderer, groups, images, sprite, transform, scale, timeMs, warp);
    return;
  }
  const front = layers.filter((layer) => layer.depth !== 'rear');
  const sheets: SpriteSheet[] = [
    {
      composite: compositeFor(rearCache, rear, images, sprite, scale, PARALLAX_REAR_ENLARGE),
      mesh: buildMesh(timeMs, sprite.image, transform, rearWarpSettings(warp)),
    },
  ];
  if (front.length > 0) {
    sheets.push({
      composite: compositeFor(frontCache, front, images, sprite, scale),
      mesh: buildMesh(timeMs, sprite.image, transform, warp),
    });
  }
  renderer.drawStack(sheets, scale);
}

// How long a lost WebGL context gets to come back on its own
// before the sprite is declared unavailable. Restoration, when
// it happens, is normally prompt; this only bounds the wait.
const CONTEXT_RESTORE_GRACE_MS = 3000;

export function CharacterSprite({
  sprite = DEFAULT_SPRITE,
  pose,
  expression,
  mark,
  thinking,
  extras,
  tears,
  eyes,
  eyesLeft,
  eyesRight,
  mouth,
  blinking,
  talking,
  animateChanges = false,
  motion = DEFAULT_MOTION,
  label = '立ち絵',
  onAssetsLoaded,
  onRenderUnavailable,
}: {
  sprite?: SpriteConfig;
  pose: Pose;
  expression: Expression;
  mark: Mark | null;
  thinking: boolean;
  extras: string[];
  tears: boolean;
  eyes: EyeState;
  eyesLeft?: EyeState;
  eyesRight?: EyeState;
  mouth: MouthState;
  blinking: boolean;
  talking: boolean;
  animateChanges?: boolean;
  motion?: SpriteMotionSettings;
  label?: string;
  onAssetsLoaded?: (assets: ReadonlySet<string>) => void;
  /**
   * Called once when WebGL rendering turns out to be impossible
   * (no context at startup, or a lost context that did not come
   * back). There is no fallback draw: the caller is expected to
   * drop the sprite area entirely and say why.
   */
  onRenderUnavailable?: () => void;
}) {
  const { eyeFrameLeft, eyeFrameRight, mouthFrame } = useSpriteAnimation({
    eyes,
    eyesLeft,
    eyesRight,
    mouth,
    blinking,
    talking,
    hurried: isHurriedExpression(expression, sprite),
    sprite,
    animateChanges,
  });
  const groups = useMemo(
    () =>
      spriteLayerGroups(sprite, {
        pose,
        expression,
        mark,
        thinking,
        extras,
        tears,
        eyeFrameLeft,
        eyeFrameRight,
        mouthFrame,
      }),
    [
      sprite,
      pose,
      expression,
      mark,
      thinking,
      extras,
      tears,
      eyeFrameLeft,
      eyeFrameRight,
      mouthFrame,
    ],
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const images = useRef(new Map<string, HTMLImageElement>());
  const onAssetsLoadedRef = useRef(onAssetsLoaded);
  onAssetsLoadedRef.current = onAssetsLoaded;
  const onRenderUnavailableRef = useRef(onRenderUnavailable);
  onRenderUnavailableRef.current = onRenderUnavailable;
  const [ready, setReady] = useState(false);
  // Bumped when the recovery sweep below lands images after the
  // initial load, so the static draw (which otherwise only repaints
  // on visible-layer changes) picks them up.
  const [assetsVersion, setAssetsVersion] = useState(0);
  // Bumped whenever the canvas surface is resized, so a static
  // (motionless) sprite redraws at the new resolution.
  const [surface, setSurface] = useState(0);
  const visible = useRef(true);
  // The animation loop reads the latest draw inputs from refs so frame
  // changes (blinking, lip-sync) never restart it.
  const drawState = useRef({ groups, sprite, motion });
  drawState.current = { groups, sprite, motion };
  // The spring's state lives outside React: the loop advances it every
  // frame, and event impulses (below) kick it between frames.
  const motionState = useRef<MotionState>(createMotionState());
  // WebGL renderer lifecycle: created lazily on first draw, rebuilt
  // after a context restore, and gone for good once rendering has
  // been declared unavailable.
  const rendererRef = useRef<SpriteGlRenderer | null>(null);
  const contextLostRef = useRef(false);
  const restoreTimerRef = useRef<number | null>(null);
  const unavailableRef = useRef(false);
  const [renderFailed, setRenderFailed] = useState(false);

  // Rendering is impossible: tell the caller once and stop. There
  // is deliberately no degraded draw to fall back to.
  const declareUnavailable = useCallback(() => {
    if (unavailableRef.current) return;
    unavailableRef.current = true;
    setRenderFailed(true);
    onRenderUnavailableRef.current?.();
  }, []);

  const acquireRenderer = useCallback(
    (canvas: HTMLCanvasElement): SpriteGlRenderer | null => {
      if (!rendererRef.current) {
        rendererRef.current = createSpriteGlRenderer(canvas);
        if (!rendererRef.current) declareUnavailable();
      }
      return rendererRef.current;
    },
    [declareUnavailable],
  );

  // Event reaction: speech starting gives the spring a small
  // bounce, which decays back to rest on its own. Look changes do
  // not kick the body — the gaze is the mesh warp's slow glance
  // drift, not a whole-body jolt, and there is no size pulse.
  const talkingRef = useRef(talking);
  useEffect(() => {
    const wasTalking = talkingRef.current;
    talkingRef.current = talking;
    if (!wasTalking && talking) {
      const scale = sprite.image.width / 1024;
      motionState.current = impulseMotion(motionState.current, { vy: -10 * scale });
    }
  }, [talking, sprite]);

  useEffect(() => {
    let cancelled = false;
    let sweepTimer: number | undefined;
    setReady(false);
    const urls = allSpriteLayerUrls(sprite);
    void loadSpriteImages(urls).then((loaded) => {
      if (cancelled) return;
      onAssetsLoadedRef.current?.(new Set(loaded.keys()));
      images.current = loaded;
      setReady(true);
      const missing = urls.filter((url) => !loaded.has(url));
      if (missing.length === 0) return;
      // One later sweep for whatever the retries could not get: the
      // link may well recover while the page stays open, and a layer
      // missing for the whole session is worse than a late one.
      sweepTimer = window.setTimeout(() => {
        void loadSpriteImages(missing).then((recovered) => {
          if (cancelled || recovered.size === 0) return;
          const merged = new Map(images.current);
          recovered.forEach((image, url) => merged.set(url, image));
          images.current = merged;
          onAssetsLoadedRef.current?.(new Set(merged.keys()));
          setAssetsVersion((version) => version + 1);
        });
      }, 15_000);
    });
    return () => {
      cancelled = true;
      if (sweepTimer !== undefined) window.clearTimeout(sweepTimer);
    };
  }, [sprite]);

  // Size the canvas surface to what is actually displayed (capped at
  // 2x) instead of always rendering at the sprite's full resolution:
  // on a phone the sprite shows at a few hundred CSS pixels wide, and
  // rasterizing the full 1024x1536 surface every frame is the main
  // cost driver on the GPU side too.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(rect.width * dpr);
      const height = Math.round(rect.height * dpr);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        setSurface((version) => version + 1);
      }
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new IntersectionObserver((entries) => {
      visible.current = entries[0]?.isIntersecting ?? true;
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // Context loss and restoration. Losing the context mid-session
  // (a GPU reset, driver hiccup) is not immediately fatal: the
  // browser may hand it back, announced by webglcontextrestored,
  // in which case the renderer is rebuilt from scratch and drawing
  // resumes. Only a loss that does not restore within the grace
  // period degrades to "no sprite".
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onLost = (event: Event) => {
      // preventDefault is what allows the browser to restore the
      // context later; without it the loss is permanent.
      event.preventDefault();
      contextLostRef.current = true;
      if (restoreTimerRef.current !== null) window.clearTimeout(restoreTimerRef.current);
      restoreTimerRef.current = window.setTimeout(declareUnavailable, CONTEXT_RESTORE_GRACE_MS);
    };
    const onRestored = () => {
      if (restoreTimerRef.current !== null) {
        window.clearTimeout(restoreTimerRef.current);
        restoreTimerRef.current = null;
      }
      contextLostRef.current = false;
      // Every GL object died with the old context; drop the
      // renderer so the next draw builds a fresh one (and
      // re-uploads the texture).
      rendererRef.current = null;
      setSurface((version) => version + 1);
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    return () => {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      if (restoreTimerRef.current !== null) {
        window.clearTimeout(restoreTimerRef.current);
        restoreTimerRef.current = null;
      }
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [declareUnavailable]);

  // Static draw (motion off): one identity-transform pass, redone
  // whenever the visible layers change (blink and lip-sync frames
  // still swap) or the surface is resized.
  useEffect(() => {
    if (!ready || motion.enabled || renderFailed) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = acquireRenderer(canvas);
    if (!renderer) return;
    if (contextLostRef.current) return;
    const current = drawState.current;
    drawSprite(
      renderer,
      current.groups,
      images.current,
      current.sprite,
      identityTransform(current.sprite.image),
      canvas.width / current.sprite.image.width,
      0,
      { amplitude: 0, extraZoom: 1 },
    );
  }, [ready, motion.enabled, groups, surface, renderFailed, acquireRenderer, assetsVersion]);

  useEffect(() => {
    if (!ready || !motion.enabled || renderFailed) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = acquireRenderer(canvas);
    if (!renderer) return;
    const scale = () => canvas.width / drawState.current.sprite.image.width;
    const initial = drawState.current;
    drawSpriteAnimated(
      renderer,
      initial.groups,
      images.current,
      initial.sprite,
      spriteTransform(motionState.current, initial.motion, initial.sprite.image),
      scale(),
      performance.now() * initial.motion.speed,
      { ...DEFAULT_WARP, amplitude: initial.motion.amplitude },
    );
    let frame = 0;
    let lastDrawn = 0;
    let lastTick: number | null = null;
    const tick = (timeMs: number) => {
      frame = requestAnimationFrame(tick);
      // Idle motion is slow breathing and glancing: 30fps is
      // indistinguishable from 60 and halves the draw cost. Frames
      // are also skipped while the tab or the sprite is not visible,
      // and while the WebGL context is lost.
      if (document.hidden || !visible.current || contextLostRef.current) {
        lastTick = null;
        return;
      }
      if (timeMs - lastDrawn < 32) return;
      const dtMs = lastTick === null ? 32 : timeMs - lastTick;
      lastTick = timeMs;
      lastDrawn = timeMs;
      const current = drawState.current;
      motionState.current = stepMotion(motionState.current, dtMs, current.sprite.image);
      drawSpriteAnimated(
        renderer,
        current.groups,
        images.current,
        current.sprite,
        spriteTransform(motionState.current, current.motion, current.sprite.image),
        scale(),
        timeMs * current.motion.speed,
        { ...DEFAULT_WARP, amplitude: current.motion.amplitude },
      );
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [ready, motion.enabled, surface, renderFailed, acquireRenderer]);

  if (renderFailed) {
    // No fallback draw: the sprite is simply absent and the caller
    // shows the reason. An empty box keeps the layout contract of
    // the wrapping element without presenting a broken image.
    return <div className="absolute inset-0" aria-hidden="true" />;
  }

  return (
    <div className="absolute inset-0" role="img" aria-label={label}>
      <canvas
        ref={canvasRef}
        width={sprite.image.width}
        height={sprite.image.height}
        className="h-full w-full"
        aria-hidden="true"
      />
    </div>
  );
}
