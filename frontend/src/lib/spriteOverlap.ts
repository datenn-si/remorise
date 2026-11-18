// How deeply the message column overlaps the sprite box, as set by
// dragging the boundary handle in height-adjust mode. The sprite box
// itself never resizes: the stored value is the overlap as a
// percentage of the box height (the message column is pulled up over
// that share of the box, so the visible boundary sits at
// 100 - overlap percent of the box height). The clamp keeps both
// sides usable — the messages always overlap somewhat, and some of
// the character always stays visible.
export const SPRITE_OVERLAP_MIN = 15;
export const SPRITE_OVERLAP_MAX = 85;

// Must match the 0.4 in ChatPage's --sprite-overlap definition: the
// overlap the default layout uses while nothing is stored.
export const DEFAULT_SPRITE_OVERLAP = 40;

export function clampSpriteOverlap(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPRITE_OVERLAP;
  return Math.min(SPRITE_OVERLAP_MAX, Math.max(SPRITE_OVERLAP_MIN, Math.round(value)));
}

export function effectiveSpriteOverlap(stored: number | null): number {
  return stored === null ? DEFAULT_SPRITE_OVERLAP : clampSpriteOverlap(stored);
}

export function overlapFromBoundary(boundaryPx: number, boxHeightPx: number): number {
  if (boxHeightPx <= 0) return DEFAULT_SPRITE_OVERLAP;
  return clampSpriteOverlap((1 - boundaryPx / boxHeightPx) * 100);
}
