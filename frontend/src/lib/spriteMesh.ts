import type { SpriteTransform } from './spriteMotion';

/**
 * Mesh-warp model for the standing sprite. The layers are first
 * composited into offscreen images — from that point on there
 * is nothing per-layer left to drift — and the composites are
 * drawn through a grid mesh whose vertices are displaced by a
 * smooth field: breathing that lifts the figure above its planted
 * feet, and a very small sideways glance drift across the head
 * and upper body. Because the field is a continuous function of
 * position and the mesh warps whole images, each picture bends
 * as one sheet: no seam can open anywhere.
 *
 * Layers carry a depth group (`src/lib/spriteLayers.ts`): the
 * `rear` layers (back-side parts) form a second sheet behind the
 * front one, warped by the same field at a reduced gain and a
 * slight enlargement (rearWarpSettings), so the two sheets drift
 * against each other by a few pixels at most — parallax without
 * per-layer motion. With no rear layers there is only the one
 * sheet, exactly as before.
 *
 * The whole-composite spring transform from spriteMotion still
 * applies on top (it is folded into the destination points) and
 * contributes the overscan zoom plus brief event reactions. The
 * rasterization itself lives in spriteGl.ts (WebGL); this module
 * only computes where the mesh vertices go.
 */

export type WarpSettings = {
  /** Master scale for the warp amounts (the motion amplitude). */
  amplitude: number;
  /** Extra zoom compensating the warp's own displacement. */
  extraZoom: number;
};

// The displacement field varies with height only, so vertical
// resolution is what limits how faithfully the curved breathing
// and glance profiles are reproduced; columns are raised to keep
// the cells near-square, so diagonal silhouette edges stay smooth
// when the sheet shifts under the global transform. On the GPU
// this density costs one indexed draw call either way (609
// vertices, 3360 indices), so the mesh is sized for fidelity,
// not for the rasterizer's budget as the Canvas 2D one was.
export const WARP_COLS = 20;
export const WARP_ROWS = 28;
export const DEFAULT_WARP: WarpSettings = { amplitude: 1, extraZoom: 1.02 };

// Parallax between the two depth sheets. Layers marked `rear`
// (the character's back-side parts) are composited into a second
// sheet that is drawn behind the front sheet through the SAME
// displacement field at half gain — the sheets bend together, so
// no seam opens, and the gain difference (a few pixels at most)
// is what reads as depth. The rear sheet is also composited a
// little larger (PARALLAX_REAR_ENLARGE, applied about the canvas
// center in CharacterSprite) so it keeps covering behind the
// front sheet's silhouette while the two drift apart. Both
// effects scale with the motion amplitude setting.
export const PARALLAX_WARP_FACTOR = 0.5;
export const PARALLAX_REAR_ENLARGE = 1.02;

export function rearWarpSettings(warp: WarpSettings): WarpSettings {
  return { amplitude: warp.amplitude * PARALLAX_WARP_FACTOR, extraZoom: warp.extraZoom };
}

export type MeshPoint = { x: number; y: number };

const BREATH_PERIOD_MS = 4600;
const GLANCE_PERIOD_A_MS = 9700;
const GLANCE_PERIOD_B_MS = 15300;
// Peak amounts at the 1024-wide design size, scaled by the actual
// width and by the motion amplitude. Both are deliberately small:
// the breathing lift tops out at a few pixels at the head, and the
// glance drift is smaller still.
const BREATH_RISE_PX = 5;
const GLANCE_SHIFT_PX = 3;

function smoothstep01(value: number): number {
  const v = Math.min(Math.max(value, 0), 1);
  return v * v * (3 - 2 * v);
}

/**
 * The warp displacement at one sprite-space point. Smooth in both
 * axes and zero at the feet, so the figure stays planted. Two
 * motions only, both deformations of the sheet — never a size
 * change (which reads as moving toward or away from the viewer)
 * and never a lean:
 *
 * - Breathing: a slow vertical lift whose size grows smoothly
 *   with height, so the feet and lower body stay put while the
 *   upper body and head rise and settle.
 * - Glance: a very small sideways drift, weighted to the head
 *   and upper body and gone by mid-torso. Two slow incommensurate
 *   sines make it wander instead of swaying in a fixed rhythm.
 *
 * The current field varies only with height, not with x.
 */
export function warpDisplacement(
  _x: number,
  y: number,
  timeMs: number,
  size: { width: number; height: number },
  amplitude: number,
): MeshPoint {
  const scale = size.width / 1024;
  // Height above the feet: 0 at the bottom edge, 1 at the top.
  const h = 1 - y / size.height;
  const breath = Math.sin((2 * Math.PI * timeMs) / BREATH_PERIOD_MS);
  const dy = -amplitude * scale * BREATH_RISE_PX * breath * Math.pow(h, 1.8);
  const wander =
    0.65 * Math.sin((2 * Math.PI * timeMs) / GLANCE_PERIOD_A_MS + 0.9) +
    0.35 * Math.sin((2 * Math.PI * timeMs) / GLANCE_PERIOD_B_MS + 2.1);
  const upperBody = smoothstep01((h - 0.42) / 0.33);
  const dx = amplitude * scale * GLANCE_SHIFT_PX * wander * upperBody;
  return { x: dx, y: dy };
}

export function applyGlobalTransform(point: MeshPoint, transform: SpriteTransform): MeshPoint {
  const dx = point.x - transform.pivotX;
  const dy = point.y - transform.pivotY;
  const cos = Math.cos(transform.rotate);
  const sin = Math.sin(transform.rotate);
  return {
    x: transform.pivotX + (cos * dx - sin * dy) * transform.scale + transform.dx,
    y: transform.pivotY + (sin * dx + cos * dy) * transform.scale + transform.dy,
  };
}

/**
 * The destination mesh: one point per grid node, warped and then
 * carried by the global transform. Points are returned in row-major
 * order, (WARP_COLS + 1) per row.
 */
export function buildMesh(
  timeMs: number,
  size: { width: number; height: number },
  transform: SpriteTransform,
  warp: WarpSettings,
): MeshPoint[] {
  const zoomed: SpriteTransform = {
    ...transform,
    scale: transform.scale * warp.extraZoom,
  };
  const points: MeshPoint[] = [];
  for (let row = 0; row <= WARP_ROWS; row += 1) {
    for (let col = 0; col <= WARP_COLS; col += 1) {
      const x = (col / WARP_COLS) * size.width;
      const y = (row / WARP_ROWS) * size.height;
      const d = warpDisplacement(x, y, timeMs, size, warp.amplitude);
      points.push(applyGlobalTransform({ x: x + d.x, y: y + d.y }, zoomed));
    }
  }
  return points;
}
