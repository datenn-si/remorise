import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPRITE } from '../../lib/spriteLayers';
import { DEFAULT_MOTION } from '../../lib/spriteMotion';
import { CharacterSprite } from './CharacterSprite';

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function createFakeGl() {
  return {
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
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    deleteShader: () => {},
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    deleteProgram: () => {},
    createBuffer: () => ({}),
    createTexture: () => ({}),
    deleteBuffer: () => {},
    deleteTexture: () => {},
    bindBuffer: () => {},
    bufferData: () => {},
    bindTexture: () => {},
    texParameteri: () => {},
    pixelStorei: () => {},
    texImage2D: () => {},
    isContextLost: () => false,
    viewport: () => {},
    clearColor: () => {},
    clear: () => {},
    useProgram: () => {},
    enable: () => {},
    blendFunc: () => {},
    getAttribLocation: () => 0,
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    drawElements: () => {},
  };
}

const baseProps = {
  sprite: DEFAULT_SPRITE,
  pose: 'arms-down',
  expression: 'normal',
  mark: null,
  thinking: false,
  extras: [],
  tears: false,
  eyes: 'open' as const,
  mouth: 'closed' as const,
  blinking: false,
  talking: false,
  motion: { ...DEFAULT_MOTION, enabled: false },
};

describe('CharacterSprite WebGL availability', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopObserver);
    vi.stubGlobal('IntersectionObserver', NoopObserver);
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stubContexts(webgl: unknown) {
    HTMLCanvasElement.prototype.getContext = function (type: string) {
      return type === 'webgl' ? webgl : null;
    } as typeof HTMLCanvasElement.prototype.getContext;
  }

  it('reports unavailability once and renders nothing when WebGL is missing', async () => {
    stubContexts(null);
    const onRenderUnavailable = vi.fn();
    const { container } = render(
      <CharacterSprite {...baseProps} onRenderUnavailable={onRenderUnavailable} />,
    );
    await act(async () => {});
    expect(onRenderUnavailable).toHaveBeenCalledTimes(1);
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('draws without reporting when WebGL works', async () => {
    stubContexts(createFakeGl());
    const onRenderUnavailable = vi.fn();
    const { container } = render(
      <CharacterSprite {...baseProps} onRenderUnavailable={onRenderUnavailable} />,
    );
    await act(async () => {});
    expect(onRenderUnavailable).not.toHaveBeenCalled();
    expect(container.querySelector('canvas')).not.toBeNull();
  });

  it('draws the initial frame before waiting for animation frames', async () => {
    const gl = createFakeGl();
    const drawElements = vi.spyOn(gl, 'drawElements');
    stubContexts(gl);
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { container } = render(<CharacterSprite {...baseProps} motion={DEFAULT_MOTION} />);
    await act(async () => {});

    expect(drawElements).toHaveBeenCalledTimes(1);
    expect(container.querySelector('canvas')).not.toBeNull();
  });

  it('degrades when a lost context does not come back within the grace period', async () => {
    vi.useFakeTimers();
    stubContexts(createFakeGl());
    const onRenderUnavailable = vi.fn();
    const { container } = render(
      <CharacterSprite {...baseProps} onRenderUnavailable={onRenderUnavailable} />,
    );
    await act(async () => {});
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    act(() => {
      canvas?.dispatchEvent(new Event('webglcontextlost'));
    });
    expect(onRenderUnavailable).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onRenderUnavailable).toHaveBeenCalledTimes(1);
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('recovers silently when the context is restored in time', async () => {
    vi.useFakeTimers();
    stubContexts(createFakeGl());
    const onRenderUnavailable = vi.fn();
    const { container } = render(
      <CharacterSprite {...baseProps} onRenderUnavailable={onRenderUnavailable} />,
    );
    await act(async () => {});
    const canvas = container.querySelector('canvas');
    act(() => {
      canvas?.dispatchEvent(new Event('webglcontextlost'));
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      canvas?.dispatchEvent(new Event('webglcontextrestored'));
    });
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(onRenderUnavailable).not.toHaveBeenCalled();
    expect(container.querySelector('canvas')).not.toBeNull();
  });
});
