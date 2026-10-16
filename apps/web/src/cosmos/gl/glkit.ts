/**
 * A small WebGL2 toolkit shared by the origin opening and the live Universe sky. Everything it
 * creates is tracked so `dispose()` releases every GPU object and the context itself when a
 * surface exits (the opening must stop rendering and release its resources after it ends).
 */

export interface GLKit {
  gl: WebGL2RenderingContext;
  /** True when half-float render targets are available; otherwise the scene renders into RGBA8. */
  hdr: boolean;
  program(vertex: string, fragment: string): WebGLProgram;
  buffer(data: Float32Array, target?: number, usage?: number): WebGLBuffer;
  vertexArray(): WebGLVertexArrayObject;
  target(width: number, height: number): RenderTarget;
  dispose(): void;
}

export interface RenderTarget {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
  resize(width: number, height: number): void;
}

class GLUnavailableError extends Error {}

export function createKit(canvas: HTMLCanvasElement, options: WebGLContextAttributes = {}): GLKit {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: true, powerPreference: 'high-performance', ...options });
  } catch {
    gl = null;
  }
  if (!gl) throw new GLUnavailableError('WebGL2 is not available');
  const context = gl;
  const hdr = !!context.getExtension('EXT_color_buffer_float') || !!context.getExtension('EXT_color_buffer_half_float');
  const programs: WebGLProgram[] = [];
  const buffers: WebGLBuffer[] = [];
  const arrays: WebGLVertexArrayObject[] = [];
  const targets: RenderTarget[] = [];

  const compile = (type: number, source: string): WebGLShader => {
    const shader = context.createShader(type);
    if (!shader) throw new GLUnavailableError('Could not create a shader');
    context.shaderSource(shader, source);
    context.compileShader(shader);
    if (!context.getShaderParameter(shader, context.COMPILE_STATUS) && !context.isContextLost()) {
      const log = context.getShaderInfoLog(shader) ?? 'unknown';
      context.deleteShader(shader);
      throw new GLUnavailableError(`Shader compile failed: ${log}`);
    }
    return shader;
  };

  const makeTarget = (width: number, height: number): RenderTarget => {
    const texture = context.createTexture();
    const framebuffer = context.createFramebuffer();
    if (!texture || !framebuffer) throw new GLUnavailableError('Could not create a render target');
    const target: RenderTarget = {
      framebuffer,
      texture,
      width: 0,
      height: 0,
      resize(w: number, h: number) {
        const nextW = Math.max(1, Math.round(w));
        const nextH = Math.max(1, Math.round(h));
        if (nextW === target.width && nextH === target.height) return;
        target.width = nextW;
        target.height = nextH;
        context.bindTexture(context.TEXTURE_2D, texture);
        if (hdr) context.texImage2D(context.TEXTURE_2D, 0, context.RGBA16F, nextW, nextH, 0, context.RGBA, context.HALF_FLOAT, null);
        else context.texImage2D(context.TEXTURE_2D, 0, context.RGBA8, nextW, nextH, 0, context.RGBA, context.UNSIGNED_BYTE, null);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
        context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
        context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
        context.bindFramebuffer(context.FRAMEBUFFER, null);
      },
    };
    target.resize(width, height);
    targets.push(target);
    return target;
  };

  return {
    gl: context,
    hdr,
    program(vertex, fragment) {
      const program = context.createProgram();
      if (!program) throw new GLUnavailableError('Could not create a program');
      const vs = compile(context.VERTEX_SHADER, vertex);
      const fs = compile(context.FRAGMENT_SHADER, fragment);
      context.attachShader(program, vs);
      context.attachShader(program, fs);
      context.linkProgram(program);
      context.deleteShader(vs);
      context.deleteShader(fs);
      if (!context.getProgramParameter(program, context.LINK_STATUS) && !context.isContextLost()) {
        const log = context.getProgramInfoLog(program) ?? 'unknown';
        context.deleteProgram(program);
        throw new GLUnavailableError(`Program link failed: ${log}`);
      }
      programs.push(program);
      return program;
    },
    buffer(data, target = context.ARRAY_BUFFER, usage = context.STATIC_DRAW) {
      const buffer = context.createBuffer();
      if (!buffer) throw new GLUnavailableError('Could not create a buffer');
      context.bindBuffer(target, buffer);
      context.bufferData(target, data, usage);
      buffers.push(buffer);
      return buffer;
    },
    vertexArray() {
      const array = context.createVertexArray();
      if (!array) throw new GLUnavailableError('Could not create a vertex array');
      arrays.push(array);
      return array;
    },
    target: makeTarget,
    dispose() {
      for (const program of programs) context.deleteProgram(program);
      for (const buffer of buffers) context.deleteBuffer(buffer);
      for (const array of arrays) context.deleteVertexArray(array);
      for (const target of targets) {
        context.deleteFramebuffer(target.framebuffer);
        context.deleteTexture(target.texture);
      }
      programs.length = 0;
      buffers.length = 0;
      arrays.length = 0;
      targets.length = 0;
      context.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

/** Uniform locations are looked up once per program and cached by name. */
export function uniforms(gl: WebGL2RenderingContext, program: WebGLProgram) {
  const cache = new Map<string, WebGLUniformLocation | null>();
  return (name: string): WebGLUniformLocation | null => {
    if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name));
    return cache.get(name) ?? null;
  };
}

/** A seeded generator so every frame of the opening is reproducible. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Vec3 = [number, number, number];

export function perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

export function lookAt(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): Float32Array {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

export function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!;
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/** Projects a world point to CSS pixels; `w <= 0` means behind the camera. */
export function project(viewProj: Float32Array, p: Vec3, width: number, height: number): { x: number; y: number; w: number } {
  const x = viewProj[0]! * p[0] + viewProj[4]! * p[1] + viewProj[8]! * p[2] + viewProj[12]!;
  const y = viewProj[1]! * p[0] + viewProj[5]! * p[1] + viewProj[9]! * p[2] + viewProj[13]!;
  const w = viewProj[3]! * p[0] + viewProj[7]! * p[1] + viewProj[11]! * p[2] + viewProj[15]!;
  if (w <= 1e-6) return { x: -9999, y: -9999, w };
  return { x: (x / w * 0.5 + 0.5) * width, y: (1 - (y / w * 0.5 + 0.5)) * height, w };
}
