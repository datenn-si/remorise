import { WARP_COLS, WARP_ROWS, type MeshPoint } from './spriteMesh';

/**
 * WebGL rasterizer for the sprite mesh. The composited sprite
 * images (2D canvases, see CharacterSprite) are uploaded as
 * textures and the warped mesh from spriteMesh.ts is drawn as
 * indexed triangle draws — vertices are shared between cells, so
 * no seam can open and none of the per-triangle grow-to-hide-gaps
 * tricks of the old Canvas 2D mapping are needed. A sprite is one
 * sheet (one draw), or two when it has rear layers: the rear
 * sheet is drawn first and the front sheet over it, in a single
 * clear. WebGL1 only; no extensions are required (the index
 * count fits in 16 bits).
 *
 * Alpha handling mirrors what Canvas 2D did: the source canvas
 * is already premultiplied, the texture upload asks for
 * premultiplied data, blending is premultiplied source-over, and
 * the drawing buffer itself is premultiplied, so the browser
 * composites the canvas over the page exactly as before.
 */

const VERTEX_SHADER = `
attribute vec2 a_position;
attribute vec2 a_texcoord;
varying vec2 v_texcoord;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texcoord = a_texcoord;
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec2 v_texcoord;
uniform sampler2D u_texture;
void main() {
  gl_FragColor = texture2D(u_texture, v_texcoord);
}
`;

/**
 * Triangle indices for the grid, two triangles per cell, as one
 * Uint16Array shared by every draw. Vertex order is row-major,
 * matching buildMesh.
 */
export function buildIndexArray(cols: number = WARP_COLS, rows: number = WARP_ROWS): Uint16Array {
  const indices = new Uint16Array(cols * rows * 6);
  const stride = cols + 1;
  let offset = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const topLeft = row * stride + col;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + stride;
      const bottomRight = bottomLeft + 1;
      indices[offset] = topLeft;
      indices[offset + 1] = bottomLeft;
      indices[offset + 2] = topRight;
      indices[offset + 3] = topRight;
      indices[offset + 4] = bottomLeft;
      indices[offset + 5] = bottomRight;
      offset += 6;
    }
  }
  return indices;
}

/**
 * Interleaved vertex data for one draw: [ndcX, ndcY, u, v] per
 * mesh point. `mesh` points are in sprite space; `destScale` maps
 * sprite space onto the drawing buffer (as the old drawWarped
 * did), and the buffer size converts that to clip space. The
 * texture is uploaded flipped (UNPACK_FLIP_Y_WEBGL), so v is
 * 1 at the image's top row and 0 at the bottom; sprite space
 * runs downward, hence v = 1 - row / rows.
 */
export function buildVertexArray(
  mesh: MeshPoint[],
  destScale: number,
  bufferWidth: number,
  bufferHeight: number,
  cols: number = WARP_COLS,
  rows: number = WARP_ROWS,
): Float32Array {
  const data = new Float32Array(mesh.length * 4);
  let offset = 0;
  for (let row = 0; row <= rows; row += 1) {
    for (let col = 0; col <= cols; col += 1) {
      const point = mesh[row * (cols + 1) + col];
      const px = point.x * destScale;
      const py = point.y * destScale;
      data[offset] = (px / bufferWidth) * 2 - 1;
      data[offset + 1] = 1 - (py / bufferHeight) * 2;
      data[offset + 2] = col / cols;
      data[offset + 3] = 1 - row / rows;
      offset += 4;
    }
  }
  return data;
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * A live WebGL renderer bound to one canvas. Created through
 * createSpriteGlRenderer, which returns null when WebGL is not
 * available at all — the caller treats that as "no sprite", not
 * as a degraded draw.
 */
export type SpriteSheet = { composite: HTMLCanvasElement; mesh: MeshPoint[] };

export class SpriteGlRenderer {
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private vertexBuffer: WebGLBuffer;
  private indexBuffer: WebGLBuffer;
  private textures: WebGLTexture[] = [];
  private textureSources: (HTMLCanvasElement | null)[] = [];
  private indexCount: number;

  private constructor(
    gl: WebGLRenderingContext,
    program: WebGLProgram,
    vertexBuffer: WebGLBuffer,
    indexBuffer: WebGLBuffer,
    texture: WebGLTexture,
    indexCount: number,
  ) {
    this.gl = gl;
    this.program = program;
    this.vertexBuffer = vertexBuffer;
    this.indexBuffer = indexBuffer;
    this.textures = [texture];
    this.textureSources = [null];
    this.indexCount = indexCount;
  }

  static create(canvas: HTMLCanvasElement): SpriteGlRenderer | null {
    let gl: WebGLRenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl', {
        antialias: true,
        alpha: true,
        premultipliedAlpha: true,
        depth: false,
        stencil: false,
      }) as WebGLRenderingContext | null;
    } catch {
      gl = null;
    }
    if (!gl) return null;
    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vertexShader || !fragmentShader) return null;
    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return null;
    }
    const vertexBuffer = gl.createBuffer();
    const indexBuffer = gl.createBuffer();
    const texture = gl.createTexture();
    if (!vertexBuffer || !indexBuffer || !texture) return null;
    const indices = buildIndexArray();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // The composite is not a power-of-two size in general, so no
    // mipmaps and clamp-to-edge; linear filtering in premultiplied
    // space keeps soft edges free of dark fringes.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    return new SpriteGlRenderer(gl, program, vertexBuffer, indexBuffer, texture, indices.length);
  }

  isContextLost(): boolean {
    return this.gl.isContextLost();
  }

  /**
   * The texture for one sheet slot, created and configured on
   * first use. Extra slots exist only while a sprite has rear
   * layers, so the common case keeps exactly one texture.
   */
  private textureForSlot(slot: number): WebGLTexture | null {
    const gl = this.gl;
    if (!this.textures[slot]) {
      const texture = gl.createTexture();
      if (!texture) return null;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // The composite is not a power-of-two size in general, so no
      // mipmaps and clamp-to-edge; linear filtering in premultiplied
      // space keeps soft edges free of dark fringes.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      this.textures[slot] = texture;
      this.textureSources[slot] = null;
    }
    return this.textures[slot];
  }

  draw(composite: HTMLCanvasElement, mesh: MeshPoint[], destScale: number): void {
    this.drawStack([{ composite, mesh }], destScale);
  }

  /**
   * Draw a stack of sheets back to front (rear sheet first) in a
   * single clear. Each sheet's texture is re-uploaded only when
   * its composite canvas object changes (the compositor hands
   * over a fresh canvas whenever that sheet's layer set or the
   * surface scale changed).
   */
  drawStack(sheets: SpriteSheet[], destScale: number): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    const bufferWidth = gl.drawingBufferWidth;
    const bufferHeight = gl.drawingBufferHeight;
    if (bufferWidth < 1 || bufferHeight < 1) return;
    gl.viewport(0, 0, bufferWidth, bufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const positionLoc = gl.getAttribLocation(this.program, 'a_position');
    const texcoordLoc = gl.getAttribLocation(this.program, 'a_texcoord');
    gl.enableVertexAttribArray(positionLoc);
    gl.enableVertexAttribArray(texcoordLoc);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    sheets.forEach((sheet, slot) => {
      const texture = this.textureForSlot(slot);
      if (!texture) return;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      if (this.textureSources[slot] !== sheet.composite) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sheet.composite);
        this.textureSources[slot] = sheet.composite;
      }
      const vertices = buildVertexArray(sheet.mesh, destScale, bufferWidth, bufferHeight);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 16, 0);
      gl.vertexAttribPointer(texcoordLoc, 2, gl.FLOAT, false, 16, 8);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    });
  }

  /** Release the GL objects. The context itself belongs to the canvas. */
  dispose(): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteBuffer(this.indexBuffer);
    for (const texture of this.textures) gl.deleteTexture(texture);
    gl.deleteProgram(this.program);
    this.textures = [];
    this.textureSources = [];
  }
}

export function createSpriteGlRenderer(canvas: HTMLCanvasElement): SpriteGlRenderer | null {
  return SpriteGlRenderer.create(canvas);
}
