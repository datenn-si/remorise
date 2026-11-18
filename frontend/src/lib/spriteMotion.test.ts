import { describe, expect, it } from 'vitest';
import * as motionModule from './spriteMotion';
import {
  DEFAULT_MOTION,
  createMotionState,
  impulseMotion,
  maxDisplacement,
  motionFromSettings,
  overscanCovers,
  requiredOverscan,
  restTarget,
  spriteTransform,
  stepMotion,
} from './spriteMotion';
import type { OperationalSettings } from '../types/settings';

const size = { width: 1024, height: 1536 };
const FRAME_MS = 1000 / 30;

function run(state = createMotionState(), frames = 300) {
  let current = state;
  for (let frame = 0; frame < frames; frame += 1) {
    current = stepMotion(current, FRAME_MS, size);
  }
  return current;
}

describe('spriteMotion', () => {
  it('has no per-group transform API left: one transform for the whole composite', () => {
    expect(motionModule).not.toHaveProperty('groupTransform');
    expect(motionModule).not.toHaveProperty('motionGroupForSlot');
    // Every layer is drawn with this single transform value.
    const transform = spriteTransform(run(), DEFAULT_MOTION, size);
    expect(transform.pivotX).toBe(size.width / 2);
    expect(transform.pivotY).toBe(size.height / 2);
  });

  it('has no idle cycle: the target is rest, and rest is stable', () => {
    expect(restTarget()).toEqual({ dx: 0, dy: 0, rotate: 0, scale: 1 });
    // No pulsing size and no cyclic tilt: left alone, the spring
    // stays exactly where it started.
    const state = run(createMotionState(), 600);
    expect(state.dx).toBeCloseTo(0);
    expect(state.dy).toBeCloseTo(0);
    expect(state.rotate).toBeCloseTo(0);
    expect(state.scale).toBeCloseTo(1);
  });

  it('keeps an event impulse within the displacement bounds', () => {
    const kicked = impulseMotion(createMotionState(), { vx: 120, vy: -80 });
    const max = maxDisplacement(size);
    let current = kicked;
    for (let frame = 0; frame < 300; frame += 1) {
      current = stepMotion(current, FRAME_MS, size);
      expect(Math.abs(current.dx)).toBeLessThanOrEqual(max.dx);
      expect(Math.abs(current.dy)).toBeLessThanOrEqual(max.dy);
      // The bounce never turns into a tilt or a size change.
      expect(current.rotate).toBe(0);
      expect(current.scale).toBeCloseTo(1);
    }
  });

  it('decays an event impulse back to rest', () => {
    const kicked = impulseMotion(createMotionState(), { vx: 120, vy: -80 });
    const early = run(kicked, 3);
    expect(Math.abs(early.dx) + Math.abs(early.dy)).toBeGreaterThan(0.5);
    const late = run(kicked, 600);
    expect(Math.abs(late.dx)).toBeLessThan(0.05);
    expect(Math.abs(late.dy)).toBeLessThan(0.05);
  });

  it('covers the maximum displacement with the default overscan', () => {
    expect(requiredOverscan(size)).toBeLessThanOrEqual(DEFAULT_MOTION.overscan);
    expect(overscanCovers(DEFAULT_MOTION.overscan, size)).toBe(true);
    expect(overscanCovers(1, size)).toBe(false);
  });

  it('scales the impulse bounds with the canvas width', () => {
    const wide = maxDisplacement(size);
    const narrow = maxDisplacement({ width: 512, height: 768 });
    expect(narrow.dx).toBeCloseTo(wide.dx / 2);
    expect(narrow.dy).toBeCloseTo(wide.dy / 2);
  });

  it('reads the motion fields out of the operational settings', () => {
    const settings = {
      sprite_motion_enabled: false,
      sprite_motion_amplitude: 0.5,
      sprite_motion_speed: 2,
      sprite_motion_overscan: 1.2,
    } as OperationalSettings;
    expect(motionFromSettings(settings)).toEqual({
      enabled: false,
      amplitude: 0.5,
      speed: 2,
      overscan: 1.2,
    });
  });
});
