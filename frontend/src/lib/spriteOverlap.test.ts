import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPRITE_OVERLAP,
  SPRITE_OVERLAP_MAX,
  SPRITE_OVERLAP_MIN,
  clampSpriteOverlap,
  effectiveSpriteOverlap,
  overlapFromBoundary,
} from './spriteOverlap';

describe('clampSpriteOverlap', () => {
  it('keeps values inside the range and rounds them', () => {
    expect(clampSpriteOverlap(50)).toBe(50);
    expect(clampSpriteOverlap(41.6)).toBe(42);
    expect(clampSpriteOverlap(SPRITE_OVERLAP_MIN)).toBe(SPRITE_OVERLAP_MIN);
    expect(clampSpriteOverlap(SPRITE_OVERLAP_MAX)).toBe(SPRITE_OVERLAP_MAX);
  });

  it('never reaches no overlap at all or a fully covered sprite', () => {
    expect(clampSpriteOverlap(0)).toBe(SPRITE_OVERLAP_MIN);
    expect(clampSpriteOverlap(-30)).toBe(SPRITE_OVERLAP_MIN);
    expect(clampSpriteOverlap(100)).toBe(SPRITE_OVERLAP_MAX);
    expect(clampSpriteOverlap(400)).toBe(SPRITE_OVERLAP_MAX);
  });

  it('falls back to the default for a non-finite value', () => {
    expect(clampSpriteOverlap(Number.NaN)).toBe(DEFAULT_SPRITE_OVERLAP);
  });
});

describe('effectiveSpriteOverlap', () => {
  it('uses the layout default while nothing is stored', () => {
    expect(effectiveSpriteOverlap(null)).toBe(DEFAULT_SPRITE_OVERLAP);
    expect(effectiveSpriteOverlap(55)).toBe(55);
  });
});

describe('overlapFromBoundary', () => {
  it('reads the boundary as the visible remainder of the box', () => {
    // A boundary 300px into a 500px box leaves 60% visible, so the
    // messages overlap the other 40% — the layout default.
    expect(overlapFromBoundary(300, 500)).toBe(40);
    expect(overlapFromBoundary(200, 500)).toBe(60);
    expect(overlapFromBoundary(400, 1000)).toBe(60);
  });

  it('clamps a boundary dragged past either end of the box', () => {
    expect(overlapFromBoundary(0, 500)).toBe(SPRITE_OVERLAP_MAX);
    expect(overlapFromBoundary(-50, 500)).toBe(SPRITE_OVERLAP_MAX);
    expect(overlapFromBoundary(500, 500)).toBe(SPRITE_OVERLAP_MIN);
    expect(overlapFromBoundary(900, 500)).toBe(SPRITE_OVERLAP_MIN);
  });

  it('falls back to the default for a heightless box', () => {
    expect(overlapFromBoundary(100, 0)).toBe(DEFAULT_SPRITE_OVERLAP);
  });
});
