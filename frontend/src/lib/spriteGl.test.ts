import { describe, expect, it, vi } from 'vitest';
import { WARP_COLS, WARP_ROWS, type MeshPoint } from './spriteMesh';
import { buildIndexArray, buildVertexArray, createSpriteGlRenderer } from './spriteGl';

function createFakeGl() {
  const calls = {
    texImage2D: 0,
    drawElements: [] as { mode: number; count: number; type: number }[],
    bufferData: 0,
  };
  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    TRIANGLES: 0x0004,
    UNSIGNED_SHORT: 0x1403,
    TEXTURE_2D: 0x0de1,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    CLAMP_TO_EDGE: 0x812f,
    LINEAR: 0x2601,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    COLOR_BUFFER_BIT: 0x4000,
    BLEND: 0x0be2,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    drawingBufferWidth: 200,
    drawingBufferHeight: 300,
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    deleteProgram: vi.fn(),
    createBuffer: vi.fn(() => ({})),
    createTexture: vi.fn(() => ({})),
    deleteBuffer: vi.fn(),
    deleteTexture: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(() => {
      calls.bufferData += 1;
    }),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    pixelStorei: vi.fn(),
    texImage2D: vi.fn(() => {
      calls.texImage2D += 1;
    }),
    isContextLost: vi.fn(() => false),
    viewport: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    useProgram: vi.fn(),
    enable: vi.fn(),
    blendFunc: vi.fn(),
    getAttribLocation: vi.fn((_program: unknown, name: string) => (name === 'a_position' ? 0 : 1)),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    drawElements: vi.fn((mode: number, count: number, type: number) => {
      calls.drawElements.push({ mode, count, type });
    }),
  };
  return { gl, calls };
}

function canvasWith(gl: unknown): HTMLCanvasElement {
  return {
    getContext: vi.fn(() => gl),
    width: 200,
    height: 300,
  } as unknown as HTMLCanvasElement;
}

describe('buildIndexArray', () => {
  it('emits two triangles per cell, all within the vertex range', () => {
    const indices = buildIndexArray();
    expect(indices).toHaveLength(WARP_COLS * WARP_ROWS * 6);
    const vertexCount = (WARP_COLS + 1) * (WARP_ROWS + 1);
    for (const index of indices) {
      expect(index).toBeLessThan(vertexCount);
    }
  });

  it('addresses the shared corner vertices of each cell', () => {
    // 2x1 grid: vertices are numbered row-major over 3 columns.
    const indices = buildIndexArray(2, 1);
    expect(Array.from(indices)).toEqual([
      0,
      3,
      1,
      1,
      3,
      4, // first cell
      1,
      4,
      2,
      2,
      4,
      5, // second cell
    ]);
  });
});

describe('buildVertexArray', () => {
  it('maps sprite space to clip space and pairs it with grid UVs', () => {
    const mesh: MeshPoint[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ];
    const data = buildVertexArray(mesh, 1, 100, 50, 1, 1);
    expect(Array.from(data)).toEqual([
      -1,
      1,
      0,
      1, // top-left
      1,
      1,
      1,
      1, // top-right
      -1,
      -1,
      0,
      0, // bottom-left
      1,
      -1,
      1,
      0, // bottom-right
    ]);
  });

  it('applies the destination scale before normalizing', () => {
    const mesh: MeshPoint[] = [{ x: 50, y: 25 }];
    const data = buildVertexArray(mesh, 2, 200, 100, 0, 0);
    // (50*2, 25*2) is the buffer centre: NDC (0, 0).
    expect(data[0]).toBeCloseTo(0);
    expect(data[1]).toBeCloseTo(0);
  });
});

describe('createSpriteGlRenderer', () => {
  it('returns null when the canvas cannot give a WebGL context', () => {
    expect(createSpriteGlRenderer(canvasWith(null))).toBeNull();
  });

  it('draws the whole mesh in exactly one draw call', () => {
    const { gl, calls } = createFakeGl();
    const renderer = createSpriteGlRenderer(canvasWith(gl));
    expect(renderer).not.toBeNull();
    const mesh: MeshPoint[] = Array.from({ length: (WARP_COLS + 1) * (WARP_ROWS + 1) }, () => ({
      x: 0,
      y: 0,
    }));
    const composite = { width: 10, height: 15 } as HTMLCanvasElement;
    renderer?.draw(composite, mesh, 1);
    expect(calls.drawElements).toHaveLength(1);
    expect(calls.drawElements[0].count).toBe(WARP_COLS * WARP_ROWS * 6);
    expect(calls.drawElements[0].type).toBe(gl.UNSIGNED_SHORT);
  });

  it('re-uploads the texture only when the composite canvas changes', () => {
    const { gl, calls } = createFakeGl();
    const renderer = createSpriteGlRenderer(canvasWith(gl));
    const mesh: MeshPoint[] = Array.from({ length: (WARP_COLS + 1) * (WARP_ROWS + 1) }, () => ({
      x: 0,
      y: 0,
    }));
    const first = { width: 10, height: 15 } as HTMLCanvasElement;
    const second = { width: 10, height: 15 } as HTMLCanvasElement;
    renderer?.draw(first, mesh, 1);
    renderer?.draw(first, mesh, 1);
    expect(calls.texImage2D).toBe(1);
    renderer?.draw(second, mesh, 1);
    expect(calls.texImage2D).toBe(2);
  });

  it('draws a two-sheet stack back to front in a single clear', () => {
    const { gl, calls } = createFakeGl();
    const renderer = createSpriteGlRenderer(canvasWith(gl));
    const mesh: MeshPoint[] = Array.from({ length: (WARP_COLS + 1) * (WARP_ROWS + 1) }, () => ({
      x: 0,
      y: 0,
    }));
    const rear = { width: 10, height: 15 } as HTMLCanvasElement;
    const front = { width: 10, height: 15 } as HTMLCanvasElement;
    const stack = [
      { composite: rear, mesh },
      { composite: front, mesh },
    ];
    renderer?.drawStack(stack, 1);
    expect(calls.drawElements).toHaveLength(2);
    expect(calls.texImage2D).toBe(2);
    expect(gl.clear).toHaveBeenCalledTimes(1);
    // Same canvases again: each sheet keeps its own texture slot,
    // so nothing re-uploads.
    renderer?.drawStack(stack, 1);
    expect(calls.drawElements).toHaveLength(4);
    expect(calls.texImage2D).toBe(2);
  });
});
