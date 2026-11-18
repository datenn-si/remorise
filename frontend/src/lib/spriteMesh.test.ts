import { describe, expect, it } from 'vitest';
import { identityTransform } from './spriteMotion';
import {
  applyGlobalTransform,
  buildMesh,
  PARALLAX_REAR_ENLARGE,
  PARALLAX_WARP_FACTOR,
  rearWarpSettings,
  warpDisplacement,
  WARP_COLS,
  WARP_ROWS,
  type WarpSettings,
} from './spriteMesh';

const SIZE = { width: 1024, height: 1536 };

describe('warpDisplacement', () => {
  it('is zero at the feet, so the figure stays planted', () => {
    for (const t of [0, 1234, 9999]) {
      const d = warpDisplacement(300, SIZE.height, t, SIZE, 1);
      expect(d.x).toBeCloseTo(0);
      expect(d.y).toBeCloseTo(0);
    }
  });

  it('stays within its declared bounds everywhere', () => {
    // The glance drift peaks at 3px and the breathing lift at 5px
    // (design size, amplitude 1) — small by design.
    for (let t = 0; t < 30000; t += 977) {
      for (let y = 0; y <= SIZE.height; y += 128) {
        for (let x = 0; x <= SIZE.width; x += 128) {
          const d = warpDisplacement(x, y, t, SIZE, 1);
          expect(Math.abs(d.x)).toBeLessThanOrEqual(3.1);
          expect(Math.abs(d.y)).toBeLessThanOrEqual(5.1);
        }
      }
    }
  });

  it('has no sideways motion below mid-torso', () => {
    for (let t = 0; t < 30000; t += 613) {
      const d = warpDisplacement(512, SIZE.height * 0.75, t, SIZE, 1);
      expect(d.x).toBeCloseTo(0);
    }
  });

  it('breathes vertically: the head lifts, and far more than the mid-body', () => {
    let topLift = 0;
    let midLift = 0;
    for (let t = 0; t < 9200; t += 100) {
      const top = warpDisplacement(512, 0, t, SIZE, 1);
      const mid = warpDisplacement(512, SIZE.height / 2, t, SIZE, 1);
      topLift = Math.max(topLift, Math.abs(top.y));
      midLift = Math.max(midLift, Math.abs(mid.y));
    }
    // The lift reaches most of its 5px peak at the head and stays
    // a fraction of that at mid-height, where the profile fades in.
    expect(topLift).toBeGreaterThan(4);
    expect(topLift).toBeGreaterThan(2 * midLift);
  });

  it('is continuous: neighbouring points move nearly together (no tearing)', () => {
    const step = 16;
    for (let t = 0; t < 30000; t += 1733) {
      for (let y = 0; y < SIZE.height; y += 96) {
        for (let x = 0; x < SIZE.width; x += 96) {
          const here = warpDisplacement(x, y, t, SIZE, 1);
          const right = warpDisplacement(x + step, y, t, SIZE, 1);
          const below = warpDisplacement(x, y + step, t, SIZE, 1);
          expect(Math.abs(right.x - here.x)).toBeLessThan(0.6);
          expect(Math.abs(right.y - here.y)).toBeLessThan(0.6);
          expect(Math.abs(below.x - here.x)).toBeLessThan(0.6);
          expect(Math.abs(below.y - here.y)).toBeLessThan(0.6);
        }
      }
    }
  });

  it('scales with amplitude: amplitude 0 is a perfectly still sheet', () => {
    const d = warpDisplacement(512, 200, 4321, SIZE, 0);
    expect(Math.abs(d.x)).toBe(0);
    expect(Math.abs(d.y)).toBe(0);
  });
});

describe('buildMesh', () => {
  it('returns one point per grid node', () => {
    const mesh = buildMesh(1000, SIZE, identityTransform(SIZE), {
      amplitude: 1,
      extraZoom: 1.02,
    });
    expect(mesh).toHaveLength((WARP_COLS + 1) * (WARP_ROWS + 1));
  });

  it('keeps adjacent mesh nodes close (the sheet never folds or tears)', () => {
    const mesh = buildMesh(7777, SIZE, identityTransform(SIZE), {
      amplitude: 1,
      extraZoom: 1.02,
    });
    const cols = WARP_COLS + 1;
    const cellW = SIZE.width / WARP_COLS;
    const cellH = SIZE.height / WARP_ROWS;
    for (let row = 0; row <= WARP_ROWS; row += 1) {
      for (let col = 0; col <= WARP_COLS; col += 1) {
        const here = mesh[row * cols + col];
        if (col < WARP_COLS) {
          const right = mesh[row * cols + col + 1];
          expect(Math.abs(right.x - here.x)).toBeGreaterThan(cellW * 0.5);
          expect(Math.abs(right.x - here.x)).toBeLessThan(cellW * 1.6);
          expect(Math.abs(right.y - here.y)).toBeLessThan(cellH * 0.4);
        }
        if (row < WARP_ROWS) {
          const below = mesh[(row + 1) * cols + col];
          expect(Math.abs(below.y - here.y)).toBeGreaterThan(cellH * 0.5);
          expect(Math.abs(below.y - here.y)).toBeLessThan(cellH * 1.6);
        }
      }
    }
  });
});

describe('applyGlobalTransform', () => {
  it('matches the canvas pivot transform for a rotated, scaled case', () => {
    const transform = {
      dx: 5,
      dy: -3,
      rotate: 0.02,
      scale: 1.06,
      pivotX: 512,
      pivotY: 768,
    };
    const point = applyGlobalTransform({ x: 512, y: 768 }, transform);
    expect(point.x).toBeCloseTo(512 + 5);
    expect(point.y).toBeCloseTo(768 - 3);
  });
});

describe('rearWarpSettings', () => {
  it('dampens the warp gain and leaves the zoom shared with the front sheet', () => {
    const front: WarpSettings = { amplitude: 1.4, extraZoom: 1.02 };
    const rear = rearWarpSettings(front);
    expect(rear.amplitude).toBeCloseTo(1.4 * PARALLAX_WARP_FACTOR);
    expect(rear.extraZoom).toBe(1.02);
    expect(PARALLAX_WARP_FACTOR).toBeLessThan(1);
    expect(PARALLAX_REAR_ENLARGE).toBeGreaterThan(1);
  });

  it('keeps the rear sheet close to the front: same field, a few pixels at most', () => {
    const transform = identityTransform(SIZE);
    const frontMesh = buildMesh(1200, SIZE, transform, { amplitude: 1, extraZoom: 1.02 });
    const rearMesh = buildMesh(
      1200,
      SIZE,
      transform,
      rearWarpSettings({ amplitude: 1, extraZoom: 1.02 }),
    );
    let maxDrift = 0;
    frontMesh.forEach((point, index) => {
      const drift = Math.hypot(point.x - rearMesh[index].x, point.y - rearMesh[index].y);
      maxDrift = Math.max(maxDrift, drift);
    });
    // The sheets separate (the parallax is real) but only by the
    // gain difference of a deliberately tiny field.
    expect(maxDrift).toBeGreaterThan(0);
    expect(maxDrift).toBeLessThan(10);
  });
});
