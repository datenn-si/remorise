import { describe, expect, it } from 'vitest';
import {
  allSpriteLayerUrls,
  appearanceForEmotion,
  DEFAULT_SPRITE,
  expressionForEmotion,
  poseLabel,
  spriteLayerGroups,
  spriteLayers,
  type SpriteConfig,
  type SpriteLook,
} from './spriteLayers';

const sprite: SpriteConfig = {
  ...DEFAULT_SPRITE,
  root: '/api/character/assets',
  paint: ['pose', 'expression', 'mouth', 'eyes', 'tears', 'extras', 'mark'],
  poses: { still: ['body.png'] },
  expressions: { smile: { base: 'face.png', mouth: ['mouth.png', null, null] } },
  eyes: [['eyes.png']],
  tears: [['tears.png']],
  extras: { sweat: 'sweat.png', blush: ['blush-base.png', 'blush-top.png'] },
  marks: { sign: 'mark.png', thinking: 'thinking.png' },
  emotions: {
    neutral: { pose: 'still', expression: 'smile', mark: null, extras: [], tears: false },
    happy: { pose: 'still', expression: 'smile', mark: 'sign', extras: [], tears: false },
  },
};
// The shared fixture is a shared-only definition: DEFAULT_SPRITE
// carries empty split lists, which would select split mode under
// the either/or rule, so they are removed here.
delete sprite.eyes_left;
delete sprite.eyes_right;
delete sprite.tears_left;
delete sprite.tears_right;

const still: SpriteLook = {
  pose: 'still',
  expression: 'smile',
  mark: null,
  thinking: false,
  extras: [] as string[],
  tears: false,
  eyeFrameLeft: 0,
  eyeFrameRight: 0,
  mouthFrame: 0,
};

describe('spriteLayers', () => {
  it('builds asset URLs from the runtime character configuration', () => {
    expect(
      spriteLayers(sprite, { ...still, mark: 'sign', extras: ['sweat'], tears: true }),
    ).toEqual([
      { url: '/api/character/assets/body.png', x: 0, y: 0, slot: 'pose', depth: 'front' },
      { url: '/api/character/assets/face.png', x: 0, y: 0, slot: 'expression', depth: 'front' },
      { url: '/api/character/assets/mouth.png', x: 0, y: 0, slot: 'mouth', depth: 'front' },
      { url: '/api/character/assets/eyes.png', x: 0, y: 0, slot: 'eyes', depth: 'front' },
      { url: '/api/character/assets/tears.png', x: 0, y: 0, slot: 'tears', depth: 'front' },
      { url: '/api/character/assets/sweat.png', x: 0, y: 0, slot: 'extras', depth: 'front' },
      { url: '/api/character/assets/mark.png', x: 0, y: 0, slot: 'mark', depth: 'front' },
    ]);
  });

  it('draws list-form base, mouth and mark entries in order', () => {
    const listed: SpriteConfig = {
      ...sprite,
      expressions: {
        smile: {
          base: ['face-back.png', 'face-front.png'],
          mouth: [null, ['mouth-a.png', 'mouth-b.png'], null],
        },
      },
      marks: { sign: ['mark-back.png', 'mark-front.png'] },
    };
    const layers = spriteLayers(listed, { ...still, mark: 'sign', mouthFrame: 1 });
    const bySlot = (slot: string) =>
      layers.filter((layer) => layer.slot === slot).map((layer) => layer.url);
    expect(bySlot('expression')).toEqual([
      '/api/character/assets/face-back.png',
      '/api/character/assets/face-front.png',
    ]);
    expect(bySlot('mouth')).toEqual([
      '/api/character/assets/mouth-a.png',
      '/api/character/assets/mouth-b.png',
    ]);
    expect(bySlot('mark')).toEqual([
      '/api/character/assets/mark-back.png',
      '/api/character/assets/mark-front.png',
    ]);
  });

  it('draws the active extras in the order the look lists them', () => {
    const layers = spriteLayers(sprite, { ...still, extras: ['blush', 'sweat'] });
    expect(layers.filter((layer) => layer.slot === 'extras').map((layer) => layer.url)).toEqual([
      '/api/character/assets/blush-base.png',
      '/api/character/assets/blush-top.png',
      '/api/character/assets/sweat.png',
    ]);
    expect(spriteLayers(sprite, { ...still, extras: ['gone'] })).toEqual(
      spriteLayers(sprite, still),
    );
  });

  it('layers the thinking mark over the look mark', () => {
    const markUrls = (look: typeof still) =>
      spriteLayers(sprite, look)
        .filter((layer) => layer.slot === 'mark')
        .map((layer) => layer.url);
    expect(markUrls({ ...still, mark: 'sign', thinking: true })).toEqual([
      '/api/character/assets/mark.png',
      '/api/character/assets/thinking.png',
    ]);
    expect(markUrls({ ...still, thinking: true })).toEqual(['/api/character/assets/thinking.png']);
    // A look whose mark already is the thinking mark does not draw it twice.
    expect(markUrls({ ...still, mark: 'thinking', thinking: true })).toEqual([
      '/api/character/assets/thinking.png',
    ]);
    expect(markUrls({ ...still, mark: 'sign' })).toEqual(['/api/character/assets/mark.png']);
  });

  it('draws expression eye additions at the current frame, over the shared eyes', () => {
    const withAdditions: SpriteConfig = {
      ...sprite,
      frame_mode: { eyes: 'stack' },
      eyes: [[], ['eye-half.png'], ['eye-closed.png']],
      expressions: {
        smile: {
          base: 'face.png',
          mouth: ['mouth.png', null, null],
          eyes_left: [['cheek.png'], ['cheek.png'], ['cheek.png', 'closed-overlay.png']],
          eyes_right: [['cheek-right.png'], ['cheek-right.png'], ['cheek-right.png']],
        },
      },
    };
    const bySlot = (look: typeof still) =>
      spriteLayers(withAdditions, look)
        .filter((layer) => layer.slot === 'eyes')
        .map((layer) => layer.url);
    // Frame 0: no shared eye layer, but the additions for state 0 draw.
    expect(bySlot(still)).toEqual([
      '/api/character/assets/cheek.png',
      '/api/character/assets/cheek-right.png',
    ]);
    // Frame 2 in stack mode: the shared frames accumulate, while the
    // additions stay the frame-2 list alone (drawn once, not stacked).
    expect(bySlot({ ...still, eyeFrameLeft: 2, eyeFrameRight: 2 })).toEqual([
      '/api/character/assets/eye-half.png',
      '/api/character/assets/eye-closed.png',
      '/api/character/assets/cheek.png',
      '/api/character/assets/closed-overlay.png',
      '/api/character/assets/cheek-right.png',
    ]);
    // Another expression has no additions.
    const plain: SpriteConfig = {
      ...withAdditions,
      expressions: {
        smile: withAdditions.expressions.smile,
        plain: { base: 'face.png', mouth: [null, null, null] },
      },
    };
    expect(
      spriteLayers(plain, { ...still, expression: 'plain', eyeFrameLeft: 2, eyeFrameRight: 2 })
        .filter((layer) => layer.slot === 'eyes')
        .map((layer) => layer.url),
    ).toEqual(['/api/character/assets/eye-half.png', '/api/character/assets/eye-closed.png']);
  });

  it('groups layers by paint slot for per-group motion', () => {
    const groups = spriteLayerGroups(sprite, { ...still, tears: true });
    expect(groups.map((group) => group.slot)).toEqual([
      'pose',
      'expression',
      'mouth',
      'eyes',
      'tears',
    ]);
    expect(groups[0].layers).toHaveLength(1);
  });

  it('resolves split eyes and tears per side without reading the shared lists', () => {
    const split: SpriteConfig = {
      ...sprite,
      eyes: [['shared-open.png'], ['shared-half.png'], ['shared-closed.png']],
      eyes_left: [['left-open.png'], ['left-half.png'], ['left-closed.png']],
      eyes_right: [['right-open.png']],
      tears_left: [[], [], ['left-tears.png']],
      tears_right: [[], [], ['right-tears.png']],
    };
    const layers = spriteLayers(split, {
      ...still,
      tears: true,
      eyeFrameLeft: 2,
      eyeFrameRight: 1,
    });
    const bySlot = (slot: string) =>
      layers.filter((layer) => layer.slot === slot).map((layer) => layer.url);
    // The right side has no frame 1 of its own, and the shared list
    // is never read in split mode, so only the left side draws;
    // tears follow each side the same way.
    expect(bySlot('eyes')).toEqual(['/api/character/assets/left-closed.png']);
    expect(bySlot('tears')).toEqual(['/api/character/assets/left-tears.png']);
  });

  it('throws when an eye-area group has neither a split nor a shared definition', () => {
    const noEyes: SpriteConfig = { ...sprite };
    delete noEyes.eyes;
    expect(() => spriteLayers(noEyes, still)).toThrow(/eyes/);
    const noTears: SpriteConfig = { ...sprite };
    delete noTears.tears;
    expect(() => spriteLayers(noTears, { ...still, tears: true })).toThrow(/tears/);
  });

  it('stacks every frame up to the selected one in stack mode', () => {
    const stacked: SpriteConfig = {
      ...sprite,
      frame_mode: { eyes: 'stack', mouth: 'stack' },
      eyes: [['eye-open.png'], ['eye-half.png'], ['eye-closed.png']],
      expressions: {
        smile: { base: 'face.png', mouth: ['mouth-closed.png', null, 'mouth-open.png'] },
      },
    };
    const layers = spriteLayers(stacked, {
      ...still,
      eyeFrameLeft: 2,
      eyeFrameRight: 2,
      mouthFrame: 2,
    });
    const bySlot = (slot: string) =>
      layers.filter((layer) => layer.slot === slot).map((layer) => layer.url);
    expect(bySlot('eyes')).toEqual([
      '/api/character/assets/eye-open.png',
      '/api/character/assets/eye-half.png',
      '/api/character/assets/eye-closed.png',
    ]);
    expect(bySlot('mouth')).toEqual([
      '/api/character/assets/mouth-closed.png',
      '/api/character/assets/mouth-open.png',
    ]);
    // The mode is per slot group: with only the eyes stacked, the
    // mouth still switches to just its selected frame.
    const eyesOnly = spriteLayers(
      { ...stacked, frame_mode: { eyes: 'stack' } },
      { ...still, eyeFrameLeft: 2, eyeFrameRight: 2, mouthFrame: 2 },
    );
    expect(eyesOnly.filter((layer) => layer.slot === 'mouth').map((layer) => layer.url)).toEqual([
      '/api/character/assets/mouth-open.png',
    ]);
  });

  it('maps known emotions and falls back to neutral for unknown values', () => {
    expect(expressionForEmotion('happy', sprite)).toBe('smile');
    expect(appearanceForEmotion('happy', sprite).mark).toBe('sign');
    expect(appearanceForEmotion('unknown', sprite)).toEqual(sprite.emotions.neutral);
    expect(appearanceForEmotion(null, sprite)).toEqual(sprite.emotions.neutral);
  });

  it('collects unique configured assets and supports an image-free character', () => {
    const urls = allSpriteLayerUrls(sprite);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls).toHaveLength(10);
    expect(allSpriteLayerUrls(DEFAULT_SPRITE)).toEqual([]);
    expect(spriteLayers(DEFAULT_SPRITE, still)).toEqual([]);
  });

  it('reads a pose display name and its layers from the object form', () => {
    const labeled: SpriteConfig = {
      ...sprite,
      poses: { still: { label: '静止', layers: ['body.png'] } },
    };
    expect(poseLabel(labeled, 'still')).toBe('静止');
    expect(poseLabel(sprite, 'still')).toBe('still');
    expect(spriteLayers(labeled, still)[0]).toEqual({
      url: '/api/character/assets/body.png',
      x: 0,
      y: 0,
      slot: 'pose',
      depth: 'front',
    });
  });

  it('resolves parts-format offset entries', () => {
    const parts: SpriteConfig = {
      ...sprite,
      parts: true,
      poses: { still: [{ path: 'parts/body.png', x: 10, y: 20 }] },
      expressions: {
        smile: {
          base: { path: 'parts/face.png', x: 4, y: 6 },
          mouth: [{ path: 'parts/mouth.png', x: 100, y: 120 }, null, null],
        },
      },
    };
    expect(spriteLayers(parts, still)).toEqual([
      { url: '/api/character/assets/parts/body.png', x: 10, y: 20, slot: 'pose', depth: 'front' },
      {
        url: '/api/character/assets/parts/face.png',
        x: 4,
        y: 6,
        slot: 'expression',
        depth: 'front',
      },
      {
        url: '/api/character/assets/parts/mouth.png',
        x: 100,
        y: 120,
        slot: 'mouth',
        depth: 'front',
      },
      { url: '/api/character/assets/eyes.png', x: 0, y: 0, slot: 'eyes', depth: 'front' },
    ]);
    const urls = allSpriteLayerUrls(parts);
    expect(urls).toContain('/api/character/assets/parts/face.png');
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('resolves the depth attribute, defaulting to front', () => {
    const layered: SpriteConfig = {
      ...sprite,
      poses: {
        still: [
          { path: 'back-hair.png', depth: 'rear' },
          'body.png',
          { path: 'parts/skirt-back.png', x: 30, y: 400, depth: 'rear' },
          { path: 'parts/skirt.png', x: 28, y: 398, depth: 'front' },
        ],
      },
    };
    const layers = spriteLayers(layered, still);
    expect(layers.slice(0, 4)).toEqual([
      { url: '/api/character/assets/back-hair.png', x: 0, y: 0, slot: 'pose', depth: 'rear' },
      { url: '/api/character/assets/body.png', x: 0, y: 0, slot: 'pose', depth: 'front' },
      {
        url: '/api/character/assets/parts/skirt-back.png',
        x: 30,
        y: 400,
        slot: 'pose',
        depth: 'rear',
      },
      { url: '/api/character/assets/parts/skirt.png', x: 28, y: 398, slot: 'pose', depth: 'front' },
    ]);
    const groups = spriteLayerGroups(layered, still);
    expect(groups[0].layers.map((layer) => layer.depth)).toEqual([
      'rear',
      'front',
      'rear',
      'front',
    ]);
  });
});
