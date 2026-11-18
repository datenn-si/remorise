import type { OperationalSettings } from '../types/settings';

/**
 * Sprite motion, global part: ONE transform for the whole
 * composite. Layers are never moved relative to each other — the
 * only per-layer change is swapping (blink, mouth, expression).
 *
 * The sprite's idle life (breathing, glancing) is a mesh
 * deformation of the composited image and lives in spriteMesh.ts.
 * This module's spring has no idle cycle of its own: its target
 * is rest, and it carries the overscan zoom plus brief event
 * reactions (a small bounce when speech starts) that decay back
 * to rest. Nothing here pulses the figure's size or tilts it in
 * a cycle — a pulsing size reads as moving toward or away from
 * the viewer, and a cyclic tilt reads as the body leaning.
 *
 * The parameters come from the operational server settings
 * (DB-overridable, no restart); the warp's amount and rate come
 * from the amplitude / speed settings, and overscan zooms the
 * composite just enough that the motion never pulls an edge away
 * from the frame.
 */
export type SpriteMotionSettings = {
  enabled: boolean;
  amplitude: number;
  speed: number;
  overscan: number;
};

export const DEFAULT_MOTION: SpriteMotionSettings = {
  enabled: true,
  amplitude: 1,
  speed: 1,
  overscan: 1.06,
};

export function motionFromSettings(
  settings: Pick<
    OperationalSettings,
    | 'sprite_motion_enabled'
    | 'sprite_motion_amplitude'
    | 'sprite_motion_speed'
    | 'sprite_motion_overscan'
  >,
): SpriteMotionSettings {
  return {
    enabled: settings.sprite_motion_enabled,
    amplitude: settings.sprite_motion_amplitude,
    speed: settings.sprite_motion_speed,
    overscan: settings.sprite_motion_overscan,
  };
}

export type SpriteTransform = {
  dx: number;
  dy: number;
  /** Rotation in radians, applied around (pivotX, pivotY). */
  rotate: number;
  /** Total scale, including the overscan zoom. */
  scale: number;
  pivotX: number;
  pivotY: number;
};

export function identityTransform(size: { width: number; height: number }): SpriteTransform {
  return {
    dx: 0,
    dy: 0,
    rotate: 0,
    scale: 1,
    pivotX: size.width / 2,
    pivotY: size.height / 2,
  };
}

export type MotionState = {
  dx: number;
  dy: number;
  rotate: number;
  scale: number;
  vx: number;
  vy: number;
  vrotate: number;
  vscale: number;
};

export function createMotionState(): MotionState {
  return { dx: 0, dy: 0, rotate: 0, scale: 1, vx: 0, vy: 0, vrotate: 0, vscale: 0 };
}

// Headroom that event impulses may use. The spring state is
// clamped to this bound, so the overscan bound below holds no
// matter how impulses stack up.
const IMPULSE_DX = 8;
const IMPULSE_DY = 7;

/**
 * The farthest each channel can ever get from rest, at the
 * 1024-wide design size scaled by the actual width. With no idle
 * cycle, only the event-impulse headroom remains — the mesh
 * warp's own displacement is covered by its extra zoom, not by
 * this bound — and rotation never leaves zero.
 */
export function maxDisplacement(size: { width: number; height: number }): {
  dx: number;
  dy: number;
  rotate: number;
} {
  const scale = size.width / 1024;
  return { dx: IMPULSE_DX * scale, dy: IMPULSE_DY * scale, rotate: 0 };
}

/**
 * The overscan zoom at which the frame still covers the sprite at
 * maximum displacement: zooming by S around the centre leaves
 * (S-1)/2 of the width/height as margin on each side.
 */
export function requiredOverscan(size: { width: number; height: number }): number {
  const max = maxDisplacement(size);
  return Math.max(1 + (2 * max.dx) / size.width, 1 + (2 * max.dy) / size.height);
}

export function overscanCovers(overscan: number, size: { width: number; height: number }): boolean {
  return overscan >= requiredOverscan(size);
}

/**
 * The target the spring chases: rest. The idle motion lives in
 * the mesh warp, so between event reactions the global transform
 * settles to no offset, no tilt, and no size change at all.
 */
export function restTarget(): { dx: number; dy: number; rotate: number; scale: number } {
  return { dx: 0, dy: 0, rotate: 0, scale: 1 };
}

const SPRING_STIFFNESS = 55;
const SPRING_DAMPING = 2 * Math.sqrt(SPRING_STIFFNESS) * 0.85;
const MAX_DT_MS = 50;

function clamp(value: number, bound: number): number {
  return Math.min(bound, Math.max(-bound, value));
}

function stepChannel(
  value: number,
  velocity: number,
  target: number,
  dt: number,
  bound: number,
): [number, number] {
  const nextVelocity =
    velocity + (SPRING_STIFFNESS * (target - value) - SPRING_DAMPING * velocity) * dt;
  return [clamp(value + nextVelocity * dt, bound), nextVelocity];
}

/**
 * Advance the spring one frame toward rest. Distances are tuned
 * at the 1024x1536 design size and scaled by the canvas width, so
 * the motion looks the same for any sprite size.
 */
export function stepMotion(
  state: MotionState,
  dtMs: number,
  size: { width: number; height: number },
): MotionState {
  const dt = Math.min(Math.max(dtMs, 0), MAX_DT_MS) / 1000;
  if (dt === 0) return state;
  const target = restTarget();
  const max = maxDisplacement(size);
  const [dx, vx] = stepChannel(state.dx, state.vx, target.dx, dt, max.dx);
  const [dy, vy] = stepChannel(state.dy, state.vy, target.dy, dt, max.dy);
  const [rotate, vrotate] = stepChannel(state.rotate, state.vrotate, target.rotate, dt, max.rotate);
  // The scale channel is stepped as its offset from 1 so it can be
  // clamped like the others.
  const [scaleOffset, vscale] = stepChannel(
    state.scale - 1,
    state.vscale,
    target.scale - 1,
    dt,
    0.03,
  );
  return { dx, dy, rotate, scale: 1 + scaleOffset, vx, vy, vrotate, vscale };
}

export function impulseMotion(
  state: MotionState,
  impulse: Partial<Pick<MotionState, 'vx' | 'vy' | 'vrotate' | 'vscale'>>,
): MotionState {
  return {
    ...state,
    vx: state.vx + (impulse.vx ?? 0),
    vy: state.vy + (impulse.vy ?? 0),
    vrotate: state.vrotate + (impulse.vrotate ?? 0),
    vscale: state.vscale + (impulse.vscale ?? 0),
  };
}

export function spriteTransform(
  state: MotionState,
  motion: SpriteMotionSettings,
  size: { width: number; height: number },
): SpriteTransform {
  return {
    dx: state.dx,
    dy: state.dy,
    rotate: state.rotate,
    scale: state.scale * motion.overscan,
    pivotX: size.width / 2,
    pivotY: size.height / 2,
  };
}
