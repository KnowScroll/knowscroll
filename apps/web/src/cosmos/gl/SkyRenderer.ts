/**
 * The live Universe sky: the opening's star, world and gas shaders drawn in screen space at the
 * positions the DOM lays out, on a transparent canvas over the far-star background. One star
 * shader for the cinematic and the live sky is what makes them read as the same object.
 */
import { BILLBOARD_FS, BILLBOARD_VS, FULLSCREEN_VS, GAS_FS } from './shaders.ts';
import { createKit, uniforms, type GLKit, type RenderTarget } from './glkit.ts';

export interface SkyBody {
  /** CSS px relative to the canvas. */
  x: number;
  y: number;
  radius: number;
  color: [number, number, number];
  intensity: number;
  granulation: number;
  tension: number;
  /** 0 star, 1 world, 2 star with a released shell. */
  mode: 0 | 1 | 2;
  seed: number;
}

export interface SkyGas {
  x: number;
  y: number;
  radius: number;
  color: [number, number, number];
  density: number;
  kind: 'cloud' | 'seed' | 'shell';
  a: number;
  b: number;
}

const SKY_COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_scene;
uniform sampler2D u_gas;
out vec4 outColor;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  vec4 scene = texture(u_scene, v_uv);
  vec3 col = aces(scene.rgb + texture(u_gas, v_uv).rgb);
  float a = clamp(max(max(col.r, col.g), col.b) * 1.15 + scene.a * 0.85, 0.0, 1.0);
  outColor = vec4(col, a);
}
`;

const GAS_KIND = { cloud: 0, shell: 2, seed: 4 } as const;

export class SkyRenderer {
  private readonly kit: GLKit;
  private readonly gl: WebGL2RenderingContext;
  private readonly billboard: WebGLProgram;
  private readonly gas: WebGLProgram;
  private readonly composite: WebGLProgram;
  private readonly bu: (name: string) => WebGLUniformLocation | null;
  private readonly gu: (name: string) => WebGLUniformLocation | null;
  private readonly cu: (name: string) => WebGLUniformLocation | null;
  private readonly quadVao: WebGLVertexArrayObject;
  private readonly fullVao: WebGLVertexArrayObject;
  private readonly instances: WebGLBuffer;
  private readonly scene: RenderTarget;
  private readonly gasTarget: RenderTarget;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.kit = createKit(canvas, { alpha: true, premultipliedAlpha: true });
    const gl = (this.gl = this.kit.gl);
    try {
      this.billboard = this.kit.program(BILLBOARD_VS, BILLBOARD_FS);
      this.gas = this.kit.program(FULLSCREEN_VS, GAS_FS);
      this.composite = this.kit.program(FULLSCREEN_VS, SKY_COMPOSITE_FS);
      this.bu = uniforms(gl, this.billboard);
      this.gu = uniforms(gl, this.gas);
      this.cu = uniforms(gl, this.composite);
      this.quadVao = this.kit.vertexArray();
      gl.bindVertexArray(this.quadVao);
      this.kit.buffer(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.instances = this.kit.buffer(new Float32Array(12 * 32), gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
      const stride = 48;
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 16);
      gl.vertexAttribDivisor(2, 1);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 28);
      gl.vertexAttribDivisor(3, 1);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 44);
      gl.vertexAttribDivisor(4, 1);
      this.fullVao = this.kit.vertexArray();
      gl.bindVertexArray(this.fullVao);
      this.kit.buffer(new Float32Array([-1, -1, 3, -1, -1, 3]));
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      this.scene = this.kit.target(4, 4);
      this.gasTarget = this.kit.target(2, 2);
    } catch (error) {
      this.kit.dispose();
      throw error;
    }
  }

  get contextLost(): boolean {
    return this.gl.isContextLost();
  }

  resize(width: number, height: number, dpr: number): void {
    if (this.disposed) return;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = Math.min(dpr || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.scene.resize(this.canvas.width, this.canvas.height);
    this.gasTarget.resize(this.canvas.width / 2, this.canvas.height / 2);
  }

  render(bodies: SkyBody[], gas: SkyGas[], time: number): void {
    if (this.disposed || this.gl.isContextLost()) return;
    const gl = this.gl;
    const W = this.canvas.width;
    const H = this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.framebuffer);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    // Column-major orthographic projection from CSS px (y down) to clip space.
    const viewProj = new Float32Array([2 / this.width, 0, 0, 0, 0, -2 / this.height, 0, 0, 0, 0, 1, 0, -1, 1, 0, 1]);
    gl.useProgram(this.billboard);
    gl.uniformMatrix4fv(this.bu('u_viewProj'), false, viewProj);
    gl.uniform1f(this.bu('u_proj11'), 2 / this.height);
    gl.uniform1f(this.bu('u_aspect'), this.width / this.height);
    gl.uniform1f(this.bu('u_viewportH'), this.height);
    gl.uniform1f(this.bu('u_spread'), 3.4);
    gl.uniform1f(this.bu('u_time'), time);
    gl.uniform1f(this.bu('u_gain'), 1);
    gl.uniform2f(this.bu('u_light'), -0.55, 0.45);
    gl.bindVertexArray(this.quadVao);
    const upload = (items: SkyBody[]) => {
      const data = new Float32Array(items.length * 12);
      items.forEach((b, i) => data.set([b.x, b.y, 0, b.radius, ...b.color, b.intensity, b.granulation, b.tension, b.mode, b.seed], i * 12));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    };
    const stars = bodies.filter(b => b.mode !== 1);
    const worlds = bodies.filter(b => b.mode === 1);
    if (stars.length) {
      gl.blendFunc(gl.ONE, gl.ONE);
      upload(stars);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, stars.length);
    }
    if (worlds.length) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      upload(worlds);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, worlds.length);
    }
    gl.disable(gl.BLEND);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gasTarget.framebuffer);
    gl.viewport(0, 0, this.gasTarget.width, this.gasTarget.height);
    gl.useProgram(this.gas);
    const blobs = new Float32Array(32);
    const colors = new Float32Array(24);
    const extras = new Float32Array(32);
    const s = this.dpr / 2;
    const list = gas.slice(0, 8);
    list.forEach((g, i) => {
      blobs.set([g.x * s, (this.height - g.y) * s, g.radius * s, g.density], i * 4);
      colors.set(g.color, i * 3);
      extras.set([g.a, g.b, 0, GAS_KIND[g.kind]], i * 4);
    });
    gl.uniform2f(this.gu('u_res'), this.gasTarget.width, this.gasTarget.height);
    gl.uniform1f(this.gu('u_time'), time);
    gl.uniform1i(this.gu('u_count'), list.length);
    gl.uniform4fv(this.gu('u_blob'), blobs);
    gl.uniform3fv(this.gu('u_blobColor'), colors);
    gl.uniform4fv(this.gu('u_blobExtra'), extras);
    gl.uniform1f(this.gu('u_ambient'), 0);
    gl.uniform3f(this.gu('u_ambientColor'), 0, 0, 0);
    gl.uniform2f(this.gu('u_ambientCenter'), 0, 0);
    gl.bindVertexArray(this.fullVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.composite);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.texture);
    gl.uniform1i(this.cu('u_scene'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.gasTarget.texture);
    gl.uniform1i(this.cu('u_gas'), 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.kit.dispose();
  }
}
