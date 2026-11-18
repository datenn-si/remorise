export type Appearance = {
  pose: string;
  expression: string;
  mark: string | null;
  extras: string[];
  tears: boolean;
};

/**
 * Which depth group a layer belongs to. `rear` layers are the
 * character's own back-side parts (back hair, the back of a skirt):
 * they are composited into their own sheet and drawn behind the
 * `front` sheet with a dampened warp, which reads as depth. It is
 * a property of the layer, not of the scene — there is no scene
 * background involved.
 */
export type LayerDepth = 'front' | 'rear';

/**
 * One layer image reference. The original format is a plain path string:
 * a full-canvas image drawn at the origin. The parts format (produced by
 * the sprite-splitting tool) uses an offset object: a pre-trimmed image
 * drawn with its top-left corner at (x, y); x and y default to 0, so a
 * full-canvas image can also be written as an object when it needs a
 * `depth`. Both formats are accepted everywhere a reference appears.
 * A reference without `depth` is a front layer.
 */
export type LayerRef = string | { path: string; x?: number; y?: number; depth?: LayerDepth };

/**
 * A pose is either a bare layer list (no display name) or an object
 * whose `label` is the name shown in sprite debug. Adding a pose is a
 * layers.json edit; the client does not keep its own pose names.
 */
export type PoseDef = LayerRef[] | { label?: string; layers: LayerRef[] };

/**
 * How a frame's layers are composed from a frame list. `switch`
 * draws only the selected frame (each frame is a complete picture).
 * `stack` draws every frame up to the selected one, so later frames
 * are deltas drawn over the earlier ones. The mode is set per slot
 * group (eyes, tears, mouth) under `frame_mode`; an unset group
 * stays `switch`.
 */
export type FrameMode = 'switch' | 'stack';

export type FrameModes = {
  eyes?: FrameMode;
  tears?: FrameMode;
  mouth?: FrameMode;
};

/**
 * One expression: the face base and the mouth frames, plus optional
 * eye additions. A reference position that names one layer also
 * accepts a list of layers, drawn in order: the base can be several
 * images composited as the face, and a mouth frame can layer
 * several patches. Eye additions are this expression's own eye-area
 * layers, keyed by eye frame like the shared eye lists; unlike the
 * shared lists they never accumulate in stack mode — the list
 * written for a frame is the complete addition for that eye state,
 * so an addition that shows at every state (a cheek overlay, say)
 * is written into every frame.
 */
export type ExpressionDef = {
  base: LayerRef | LayerRef[] | null;
  mouth: (LayerRef | LayerRef[] | null)[];
  eyes?: LayerRef[][];
  eyes_left?: LayerRef[][];
  eyes_right?: LayerRef[][];
};

export type SpriteConfig = {
  image: { width: number; height: number };
  root: string;
  frame_mode?: FrameModes;
  /** Set by the backend: whether any referenced image file exists. */
  available?: boolean;
  /** Set by the splitting tool on converted definitions. */
  parts?: boolean;
  paint: string[];
  poses: Record<string, PoseDef>;
  expressions: Record<string, ExpressionDef>;
  eyes?: LayerRef[][];
  eyes_left?: LayerRef[][];
  eyes_right?: LayerRef[][];
  tears?: LayerRef[][];
  tears_left?: LayerRef[][];
  tears_right?: LayerRef[][];
  /** Named decoration layers (sweat, blush, ...), switched per emotion. */
  extras: Record<string, LayerRef | LayerRef[]>;
  marks: Record<string, LayerRef | LayerRef[]>;
  blink: {
    cycle: number[];
    stepMs: number;
    perMinute: number;
    hurriedPerMinute: number;
    minGapMs: number;
    hurriedExpressions: string[];
  };
  talk: { cycle: number[]; intervalMs: number };
  emotions: Record<string, Appearance>;
};

export const DEFAULT_SPRITE: SpriteConfig = {
  image: { width: 1024, height: 1536 },
  root: '/api/character/assets',
  frame_mode: {},
  paint: [],
  poses: {},
  expressions: {},
  eyes: [],
  eyes_left: [],
  eyes_right: [],
  tears: [],
  tears_left: [],
  tears_right: [],
  extras: {},
  marks: {},
  blink: {
    cycle: [1, 2, 1],
    stepMs: 80,
    perMinute: 20,
    hurriedPerMinute: 30,
    minGapMs: 400,
    hurriedExpressions: [],
  },
  talk: { cycle: [1, 2, 1, 0], intervalMs: 90 },
  emotions: {},
};

export const BLINK_STEP_MS = DEFAULT_SPRITE.blink.stepMs;
export const BLINK_MIN_GAP_MS = DEFAULT_SPRITE.blink.minGapMs;
export const BLINK_CYCLE = DEFAULT_SPRITE.blink.cycle;
export const MOUTH_INTERVAL_MS = DEFAULT_SPRITE.talk.intervalMs;
export const TALK_CYCLE = DEFAULT_SPRITE.talk.cycle;

export type Pose = string;
export type Expression = string;
export type Mark = string;
export type EyeState = 'open' | 'half' | 'closed';
export type MouthState = 'closed' | 'half' | 'open';
export type EyeFrame = 0 | 1 | 2;
export type MouthFrame = 0 | 1 | 2;

export type ResolvedLayer = {
  url: string;
  x: number;
  y: number;
  slot: string;
  depth: LayerDepth;
};

export type LayerGroup = { slot: string; layers: ResolvedLayer[] };

const NEUTRAL: Appearance = {
  pose: 'arms-down',
  expression: 'normal',
  mark: null,
  extras: [],
  tears: false,
};

export function poseLayerRefs(pose: PoseDef | undefined): LayerRef[] {
  if (Array.isArray(pose)) return pose;
  if (pose && Array.isArray(pose.layers)) return pose.layers;
  return [];
}

export function poseLabel(sprite: SpriteConfig, id: string): string {
  const pose = sprite.poses[id];
  if (pose && !Array.isArray(pose) && pose.label) return pose.label;
  return id;
}

function resolveRef(sprite: SpriteConfig, slot: string, ref: LayerRef | null): ResolvedLayer[] {
  if (ref === null || ref === undefined || ref === '') return [];
  if (typeof ref === 'string')
    return [{ url: `${sprite.root}/${ref}`, x: 0, y: 0, slot, depth: 'front' }];
  return [
    {
      url: `${sprite.root}/${ref.path}`,
      x: ref.x ?? 0,
      y: ref.y ?? 0,
      slot,
      depth: ref.depth === 'rear' ? 'rear' : 'front',
    },
  ];
}

function resolveRefs(sprite: SpriteConfig, slot: string, refs: LayerRef[]): ResolvedLayer[] {
  return refs.flatMap((ref) => resolveRef(sprite, slot, ref));
}

function resolveRefOrList(
  sprite: SpriteConfig,
  slot: string,
  ref: LayerRef | LayerRef[] | null | undefined,
): ResolvedLayer[] {
  if (Array.isArray(ref)) return resolveRefs(sprite, slot, ref);
  return resolveRef(sprite, slot, ref ?? null);
}

export function blinkGapMs(hurried: boolean, sprite = DEFAULT_SPRITE): number {
  const perMinute = hurried ? sprite.blink.hurriedPerMinute : sprite.blink.perMinute;
  const blinkMs = BLINK_CYCLE.length * BLINK_STEP_MS;
  return Math.max(0, 60000 / perMinute - blinkMs);
}

export function isHurriedExpression(expression: string, sprite = DEFAULT_SPRITE): boolean {
  return sprite.blink.hurriedExpressions.includes(expression);
}

export function appearanceForEmotion(
  emotion: string | null | undefined,
  sprite = DEFAULT_SPRITE,
): Appearance {
  if (emotion && sprite.emotions[emotion]) return sprite.emotions[emotion];
  return sprite.emotions.neutral ?? NEUTRAL;
}

export function expressionForEmotion(
  emotion: string | null | undefined,
  sprite = DEFAULT_SPRITE,
): Expression {
  return appearanceForEmotion(emotion, sprite).expression;
}

/**
 * Whether the character defines per-side eye frames. The split
 * lists and the shared list are never mixed: when either split
 * list is defined, only the split lists are read; otherwise only
 * the shared list is read.
 */
export function hasSplitEyes(sprite: SpriteConfig): boolean {
  return sprite.eyes_left !== undefined || sprite.eyes_right !== undefined;
}

function frameIndices(frame: number, mode: FrameMode): number[] {
  return mode === 'stack' ? Array.from({ length: frame + 1 }, (_, index) => index) : [frame];
}

function sharedFrameRefs(frames: LayerRef[][], frame: EyeFrame, mode: FrameMode): LayerRef[] {
  return frameIndices(frame, mode).flatMap((index) => frames[index] ?? []);
}

export type EyeGroupLists = {
  split: boolean;
  shared: LayerRef[][];
  left: LayerRef[][];
  right: LayerRef[][];
};

/**
 * The frame lists one eye-area group (eyes or tears) resolves
 * from. The split lists (`<group>_left` / `<group>_right`) and
 * the shared list are alternatives: when either split list is
 * defined, only the split lists are read and the shared list is
 * ignored; when neither split list is defined, the shared list
 * alone is read. A group with neither definition is an error.
 */
export function eyeGroupLists(sprite: SpriteConfig, group: 'eyes' | 'tears'): EyeGroupLists {
  const shared = group === 'eyes' ? sprite.eyes : sprite.tears;
  const left = group === 'eyes' ? sprite.eyes_left : sprite.tears_left;
  const right = group === 'eyes' ? sprite.eyes_right : sprite.tears_right;
  if (left !== undefined || right !== undefined)
    return { split: true, shared: [], left: left ?? [], right: right ?? [] };
  if (shared !== undefined) return { split: false, shared, left: [], right: [] };
  throw new Error(
    `layers.json に ${group} の定義がありません（${group} か ${group}_left / ${group}_right のどちらかが必要です）`,
  );
}

export type SpriteLook = {
  pose: Pose;
  expression: Expression;
  mark: Mark | null;
  /** Draw the `thinking` mark over the look's own mark. */
  thinking: boolean;
  extras: string[];
  tears: boolean;
  eyeFrameLeft: EyeFrame;
  eyeFrameRight: EyeFrame;
  mouthFrame: MouthFrame;
};

function frameMode(sprite: SpriteConfig, slot: keyof FrameModes): FrameMode {
  return sprite.frame_mode?.[slot] === 'stack' ? 'stack' : 'switch';
}

/**
 * The selected expression's own eye additions at the current
 * frames, drawn over the shared eye layers. The split additions
 * and the shared additions are alternatives, mirroring the global
 * either/or rule: when either split list is defined, only the
 * split additions are read; otherwise the shared list is drawn
 * once at the left (shared) frame. An expression with no eye
 * additions at all simply adds nothing. Additions resolve at the
 * current frame only — they do not follow the eyes frame mode —
 * so each frame's list is the complete addition for that eye
 * state.
 */
function expressionEyeRefs(sprite: SpriteConfig, input: SpriteLook): LayerRef[] {
  const expression = sprite.expressions[input.expression];
  if (!expression) return [];
  const shared = expression.eyes;
  const left = expression.eyes_left;
  const right = expression.eyes_right;
  if (left !== undefined || right !== undefined)
    return [...(left?.[input.eyeFrameLeft] ?? []), ...(right?.[input.eyeFrameRight] ?? [])];
  if (shared !== undefined) return [...(shared[input.eyeFrameLeft] ?? [])];
  return [];
}

export function spriteLayerGroups(sprite: SpriteConfig, input: SpriteLook): LayerGroup[] {
  const eyeMode = frameMode(sprite, 'eyes');
  const tearMode = frameMode(sprite, 'tears');
  const mouthMode = frameMode(sprite, 'mouth');
  const eyesGroup = eyeGroupLists(sprite, 'eyes');
  const eyeRefs = eyesGroup.split
    ? [
        ...sharedFrameRefs(eyesGroup.left, input.eyeFrameLeft, eyeMode),
        ...sharedFrameRefs(eyesGroup.right, input.eyeFrameRight, eyeMode),
      ]
    : sharedFrameRefs(eyesGroup.shared, input.eyeFrameLeft, eyeMode);
  const tearsGroup = eyeGroupLists(sprite, 'tears');
  const tearRefs = tearsGroup.split
    ? [
        ...sharedFrameRefs(tearsGroup.left, input.eyeFrameLeft, tearMode),
        ...sharedFrameRefs(tearsGroup.right, input.eyeFrameRight, tearMode),
      ]
    : sharedFrameRefs(tearsGroup.shared, input.eyeFrameLeft, tearMode);
  const mouthFrames = sprite.expressions[input.expression]?.mouth ?? [];
  const slots: Record<string, ResolvedLayer[]> = {
    pose: resolveRefs(sprite, 'pose', poseLayerRefs(sprite.poses[input.pose])),
    expression: resolveRefOrList(
      sprite,
      'expression',
      sprite.expressions[input.expression]?.base ?? null,
    ),
    mouth: frameIndices(input.mouthFrame, mouthMode).flatMap((index) =>
      resolveRefOrList(sprite, 'mouth', mouthFrames[index] ?? null),
    ),
    eyes: resolveRefs(sprite, 'eyes', [...eyeRefs, ...expressionEyeRefs(sprite, input)]),
    tears: input.tears ? resolveRefs(sprite, 'tears', tearRefs) : [],
    extras: input.extras.flatMap((name) =>
      resolveRefOrList(sprite, 'extras', sprite.extras[name] ?? null),
    ),
    mark: [
      ...resolveRefOrList(sprite, 'mark', input.mark ? (sprite.marks[input.mark] ?? null) : null),
      ...(input.thinking && input.mark !== 'thinking'
        ? resolveRefOrList(sprite, 'mark', sprite.marks.thinking ?? null)
        : []),
    ],
  };
  return sprite.paint
    .map((slot) => ({ slot, layers: slots[slot] ?? [] }))
    .filter((group) => group.layers.length > 0);
}

export function spriteLayers(sprite: SpriteConfig, input: SpriteLook): ResolvedLayer[] {
  return spriteLayerGroups(sprite, input).flatMap((group) => group.layers);
}

function collectPngs(sprite: SpriteConfig, value: unknown, urls: Set<string>) {
  if (typeof value === 'string') {
    if (value.endsWith('.png')) urls.add(`${sprite.root}/${value}`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPngs(sprite, item, urls);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectPngs(sprite, item, urls);
  }
}

export function allSpriteLayerUrls(sprite: SpriteConfig = DEFAULT_SPRITE): string[] {
  const urls = new Set<string>();
  collectPngs(sprite, sprite, urls);
  return [...urls];
}
