/**
 * Renders any frame of the origin opening (timeline.ts) with WebGL2. Matter is generated once,
 * seeded, and moved entirely on the GPU, so a frame depends only on its time: `render(t)` at the
 * same `t` draws the same picture, which is what lets the reduced-motion stills, the preview
 * scrubber and the live playback share one renderer.
 */
import { BILLBOARD_FS, BILLBOARD_VS, BRIGHT_FS, COMPOSITE_FS, DOWN_FS, FULLSCREEN_VS, GAS_FS, PARTICLE_FS, PARTICLE_VS, POINTS_FS, POINTS_VS, STREAK_FS, UP_FS } from './shaders.ts';
import { createKit, lookAt, multiply, perspective, project, seeded, uniforms, type GLKit, type RenderTarget, type Vec3 } from './glkit.ts';
import { CORES, DISK, frameAt, ORIGIN_DURATION, type Billboard, type OriginFrame } from '../timeline.ts';
import { farStarField } from '../farStars.ts';

export interface SeedTarget {
  /** CSS pixels relative to the canvas. */
  x: number;
  y: number;
  radius: number;
}

export interface RendererQuality {
  webParticles: number;
  materialParticles: number;
  maxDpr: number;
  /** Bloom levels (0 turns the lens treatment off) and whether streaks and light shafts are drawn. */
  bloomLevels: number;
  lensExtras: boolean;
}

export function chooseQuality(width: number, height: number): RendererQuality {
  const small = Math.min(width, height) < 620;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 4 : 4;
  const modest = cores <= 4;
  if (small || modest) return { webParticles: 15000, materialParticles: 5200, maxDpr: 1.5, bloomLevels: 4, lensExtras: false };
  return { webParticles: 30000, materialParticles: 9000, maxDpr: 1.75, bloomLevels: 5, lensExtras: true };
}

const GAS_KIND: Record<string, number> = { cloud: 0, bang: 1, shell: 2, disk: 3, seed: 4 };

export class OriginRenderer {
  private readonly kit: GLKit;
  private readonly gl: WebGL2RenderingContext;
  private readonly particleProgram: WebGLProgram;
  private readonly billboardProgram: WebGLProgram;
  private readonly gasProgram: WebGLProgram;
  private readonly compositeProgram: WebGLProgram;
  private readonly pointsProgram: WebGLProgram;
  private readonly brightProgram: WebGLProgram;
  private readonly downProgram: WebGLProgram;
  private readonly upProgram: WebGLProgram;
  private readonly streakProgram: WebGLProgram;
  private down: RenderTarget[] = [];
  private up: RenderTarget[] = [];
  private streakA!: RenderTarget;
  private streakB!: RenderTarget;
  private readonly particleVao: WebGLVertexArrayObject;
  private readonly billboardVao: WebGLVertexArrayObject;
  private readonly fullscreenVao: WebGLVertexArrayObject;
  private readonly pointsVao: WebGLVertexArrayObject;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly pointsBuffer: WebGLBuffer;
  private readonly particleCount: number;
  private pointsCount = 0;
  private scene: RenderTarget;
  private gasTarget: RenderTarget;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private disposed = false;
  private readonly u: Record<'particle' | 'billboard' | 'gas' | 'composite' | 'points' | 'bright' | 'down' | 'up' | 'streak', (name: string) => WebGLUniformLocation | null>;
  seedTarget: SeedTarget | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly quality: RendererQuality) {
    this.kit = createKit(canvas);
    this.gl = this.kit.gl;
    const gl = this.gl;
    try {
      this.particleProgram = this.kit.program(PARTICLE_VS, PARTICLE_FS);
      this.billboardProgram = this.kit.program(BILLBOARD_VS, BILLBOARD_FS);
      this.gasProgram = this.kit.program(FULLSCREEN_VS, GAS_FS);
      this.compositeProgram = this.kit.program(FULLSCREEN_VS, COMPOSITE_FS);
      this.pointsProgram = this.kit.program(POINTS_VS, POINTS_FS);
      this.brightProgram = this.kit.program(FULLSCREEN_VS, BRIGHT_FS);
      this.downProgram = this.kit.program(FULLSCREEN_VS, DOWN_FS);
      this.upProgram = this.kit.program(FULLSCREEN_VS, UP_FS);
      this.streakProgram = this.kit.program(FULLSCREEN_VS, STREAK_FS);
      this.u = {
        bright: uniforms(gl, this.brightProgram),
        down: uniforms(gl, this.downProgram),
        up: uniforms(gl, this.upProgram),
        streak: uniforms(gl, this.streakProgram),
        particle: uniforms(gl, this.particleProgram),
        billboard: uniforms(gl, this.billboardProgram),
        gas: uniforms(gl, this.gasProgram),
        composite: uniforms(gl, this.compositeProgram),
        points: uniforms(gl, this.pointsProgram),
      };

      const { data, count } = buildMatter(quality);
      this.particleCount = count;
      this.particleVao = this.kit.vertexArray();
      gl.bindVertexArray(this.particleVao);
      this.kit.buffer(data);
      const stride = 9 * 4;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 28);

      const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
      this.billboardVao = this.kit.vertexArray();
      gl.bindVertexArray(this.billboardVao);
      this.kit.buffer(quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.instanceBuffer = this.kit.buffer(new Float32Array(12 * 16), gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
      const istride = 12 * 4;
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, istride, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, istride, 16);
      gl.vertexAttribDivisor(2, 1);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 4, gl.FLOAT, false, istride, 28);
      gl.vertexAttribDivisor(3, 1);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 1, gl.FLOAT, false, istride, 44);
      gl.vertexAttribDivisor(4, 1);

      this.fullscreenVao = this.kit.vertexArray();
      gl.bindVertexArray(this.fullscreenVao);
      this.kit.buffer(new Float32Array([-1, -1, 3, -1, -1, 3]));
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      this.pointsVao = this.kit.vertexArray();
      gl.bindVertexArray(this.pointsVao);
      this.pointsBuffer = this.kit.buffer(new Float32Array(6 * 200), gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
      gl.bindVertexArray(null);

      this.scene = this.kit.target(4, 4);
      this.gasTarget = this.kit.target(2, 2);
      // Bloom pyramid: level 0 is half resolution, each next level half again.
      for (let i = 0; i < Math.max(1, quality.bloomLevels); i++) this.down.push(this.kit.target(2, 2));
      for (let i = 0; i < Math.max(1, quality.bloomLevels) - 1; i++) this.up.push(this.kit.target(2, 2));
      this.streakA = this.kit.target(2, 2);
      this.streakB = this.kit.target(2, 2);
    } catch (error) {
      // A shader that fails after the context exists must not leave the context behind.
      this.kit.dispose();
      throw error;
    }
  }

  get contextLost(): boolean {
    return this.gl.isContextLost();
  }

  resize(width: number, height: number, devicePixelRatio: number): void {
    if (this.disposed) return;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = Math.min(devicePixelRatio || 1, this.quality.maxDpr);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.scene.resize(this.canvas.width, this.canvas.height);
    this.gasTarget.resize(this.canvas.width / 2, this.canvas.height / 2);
    this.down.forEach((target, i) => target.resize(this.canvas.width / 2 ** (i + 1), this.canvas.height / 2 ** (i + 1)));
    this.up.forEach((target, i) => target.resize(this.canvas.width / 2 ** (i + 1), this.canvas.height / 2 ** (i + 1)));
    this.streakA.resize(this.canvas.width / 4, this.canvas.height / 8);
    this.streakB.resize(this.canvas.width / 4, this.canvas.height / 8);
    const stars = farStarField(this.width, this.height);
    const data = new Float32Array(stars.length * 6);
    stars.forEach((star, i) => {
      data.set([star.x, star.y, star.radius, star.color[0] * star.alpha, star.color[1] * star.alpha, star.color[2] * star.alpha], i * 6);
    });
    this.pointsCount = stars.length;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointsBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }

  /** Draws the frame at time `t` (seconds into the opening). `wall` drives only idle shimmer. */
  render(t: number, wall = t): OriginFrame {
    const frame = frameAt(t);
    if (this.disposed || this.gl.isContextLost()) return frame;
    const gl = this.gl;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const aspect = this.width / this.height;
    // Portrait screens see the same scene with a wider vertical field, so the centre stays central.
    const fovY = aspect < 1 ? 2 * Math.atan(Math.tan(frame.camera.fovY / 2) / Math.max(aspect, 0.46) * 0.82) : frame.camera.fovY;
    const proj = perspective(fovY, aspect, 0.02, 80);
    const view = lookAt(frame.camera.eye, frame.camera.target);
    const viewProj = multiply(proj, view);
    const proj11 = proj[5]!;

    // 1. Matter and stars into the HDR scene.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.framebuffer);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    const m = frame.matter;
    const pu = this.u.particle;
    gl.useProgram(this.particleProgram);
    gl.uniformMatrix4fv(pu('u_viewProj'), false, viewProj);
    gl.uniform1f(pu('u_proj11'), proj11);
    gl.uniform1f(pu('u_viewportH'), this.height);
    gl.uniform1f(pu('u_px'), this.dpr);
    gl.uniform1f(pu('u_time'), wall);
    gl.uniform1f(pu('u_scale'), m.scale);
    gl.uniform1f(pu('u_heat'), m.heat);
    gl.uniform1f(pu('u_web'), m.web);
    gl.uniform1f(pu('u_gather'), m.gather);
    gl.uniform1f(pu('u_compress'), m.compress);
    gl.uniform1f(pu('u_consume'), m.consume);
    gl.uniform3fv(pu('u_cores'), new Float32Array(CORES.flat()));
    gl.uniform3fv(pu('u_star'), CORES[0]!);
    gl.uniform1f(pu('u_envR'), m.envR);
    gl.uniform1f(pu('u_eject'), m.eject);
    gl.uniform1f(pu('u_matFade'), m.matFade);
    gl.uniform1f(pu('u_stream'), m.stream);
    gl.uniform3fv(pu('u_disk'), DISK);
    gl.uniform1f(pu('u_diskForm'), m.diskForm);
    gl.uniform1f(pu('u_diskSpin'), m.diskSpin);
    gl.uniform1f(pu('u_diskFade'), m.diskFade);
    gl.uniform1f(pu('u_fragments'), m.fragments);
    gl.uniform1f(pu('u_focus'), frame.dof.focus);
    gl.uniform1f(pu('u_aperture'), frame.dof.aperture);
    gl.uniform1f(pu('u_gain'), frame.gain * (this.kit.hdr ? 1 : 0.6) * (this.quality.webParticles < 20000 ? 1.45 : 1));
    gl.bindVertexArray(this.particleVao);
    gl.drawArrays(gl.POINTS, 0, this.particleCount);

    this.drawBillboards(frame.billboards, viewProj, proj11, aspect, wall);

    // 2. Gas at half resolution.
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gasTarget.framebuffer);
    gl.viewport(0, 0, this.gasTarget.width, this.gasTarget.height);
    const gu = this.u.gas;
    gl.useProgram(this.gasProgram);
    const blobs = new Float32Array(32);
    const colors = new Float32Array(24);
    const extras = new Float32Array(32);
    let count = 0;
    for (const blob of frame.gas) {
      if (count >= 8) break;
      let x: number;
      let y: number;
      let r: number;
      const p = project(viewProj, blob.pos, this.width, this.height);
      const pr = blob.radius * proj11 / Math.max(p.w, 0.05) * this.height * 0.5;
      if (blob.screen === 'seed-target' && this.seedTarget) {
        const k = Math.min(1, Math.max(0, (frame.t - 25.2) / 2.2));
        const e = k * k * (3 - 2 * k);
        x = p.x + (this.seedTarget.x - p.x) * e;
        y = p.y + (this.seedTarget.y - p.y) * e;
        r = Math.max(30, this.seedTarget.radius * 1.15 * (0.6 + 0.4 * e));
      } else {
        if (p.w <= 0) continue;
        x = p.x;
        y = p.y;
        r = blob.screen === 'seed-target' ? Math.min(this.width, this.height) * 0.09 : pr;
      }
      // Gas works in half-resolution pixels with y up.
      const s = this.dpr / 2;
      blobs.set([x * s, (this.height - y) * s, r * s, blob.density], count * 4);
      colors.set(blob.color, count * 3);
      extras.set([blob.a, blob.b, 0, GAS_KIND[blob.kind] ?? 0], count * 4);
      count++;
    }
    gl.uniform2f(gu('u_res'), this.gasTarget.width, this.gasTarget.height);
    gl.uniform1f(gu('u_time'), wall);
    gl.uniform1i(gu('u_count'), count);
    gl.uniform4fv(gu('u_blob'), blobs);
    gl.uniform3fv(gu('u_blobColor'), colors);
    gl.uniform4fv(gu('u_blobExtra'), extras);
    gl.uniform1f(gu('u_ambient'), frame.ambient * 0.16);
    gl.uniform3f(gu('u_ambientColor'), 0.07, 0.235, 0.26);
    gl.uniform2f(gu('u_ambientCenter'), this.gasTarget.width * 0.58, this.gasTarget.height * (1 - 0.43));
    gl.bindVertexArray(this.fullscreenVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 3. Lens: a bright pass, a bloom pyramid and an anamorphic streak.
    const lens = this.quality.bloomLevels > 0;
    if (lens) this.drawLens(frame);

    // 4. Composite to the screen with the film treatment, then the far sky inside the picture.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    const cu = this.u.composite;
    gl.useProgram(this.compositeProgram);
    const bind = (unit: number, texture: WebGLTexture, name: string) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(cu(name), unit);
    };
    bind(0, this.scene.texture, 'u_scene');
    bind(1, this.gasTarget.texture, 'u_gas');
    bind(2, (this.up[0] ?? this.down[0]!).texture, 'u_bloom');
    bind(3, this.streakA.texture, 'u_streak');
    const pf = frame.post;
    const rayScreen = pf.rayFrom ? project(viewProj, pf.rayFrom, this.width, this.height) : null;
    const letterbox = this.letterboxFraction() * pf.letterbox;
    gl.uniform3fv(cu('u_ground'), frame.ground);
    gl.uniform1f(cu('u_exposure'), frame.exposure);
    gl.uniform1f(cu('u_vignette'), pf.vignette * (1 - frame.ambient * 0.6));
    gl.uniform1f(cu('u_time'), wall % 100);
    gl.uniform1f(cu('u_black'), frame.black);
    gl.uniform1i(cu('u_effects'), lens ? 1 : 0);
    gl.uniform1f(cu('u_bloomStrength'), pf.bloom);
    gl.uniform1f(cu('u_streakStrength'), this.quality.lensExtras ? pf.streak : 0);
    gl.uniform2f(cu('u_rayPos'), rayScreen && rayScreen.w > 0 ? rayScreen.x / this.width : 0.5, rayScreen && rayScreen.w > 0 ? 1 - rayScreen.y / this.height : 0.5);
    gl.uniform1f(cu('u_rayStrength'), this.quality.lensExtras && rayScreen && rayScreen.w > 0 ? pf.rays : 0);
    const shockAt = project(viewProj, [0, 0, 0], this.width, this.height);
    gl.uniform4f(cu('u_shock'), shockAt.w > 0 ? shockAt.x / this.width : 0.5, shockAt.w > 0 ? 1 - shockAt.y / this.height : 0.5, pf.shockRadius, pf.shock);
    gl.uniform1f(cu('u_aspect'), aspect);
    gl.uniform1f(cu('u_chroma'), pf.chroma);
    gl.uniform1f(cu('u_grain'), pf.grain);
    gl.uniform1f(cu('u_letterbox'), letterbox);
    gl.uniform1f(cu('u_grade'), pf.grade);
    gl.bindVertexArray(this.fullscreenVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.letterboxNow = letterbox;

    if (frame.farStars > 0.001 && this.pointsCount > 0) {
      const bar = Math.round(letterbox * H);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, bar, W, Math.max(0, H - 2 * bar));
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      const qu = this.u.points;
      gl.useProgram(this.pointsProgram);
      gl.uniform2f(qu('u_res'), this.width, this.height);
      gl.uniform1f(qu('u_dpr'), this.dpr);
      gl.uniform1f(qu('u_alpha'), Math.min(1, frame.farStars) * (1 - frame.black));
      const drift = (1 - Math.min(1, frame.farStars)) * 18;
      gl.uniform2f(qu('u_offset'), drift * Math.sin(frame.t * 0.1), drift * 0.5);
      gl.bindVertexArray(this.pointsVao);
      gl.drawArrays(gl.POINTS, 0, this.pointsCount);
      gl.disable(gl.BLEND);
      gl.disable(gl.SCISSOR_TEST);
    }
    gl.bindVertexArray(null);
    return frame;
  }

  /** The fraction of the height each cinema bar takes at full strength: 2.39:1 framing on wide
   * screens, nothing on tall ones (a phone keeps its whole picture). */
  letterboxFraction(): number {
    const aspect = this.width / this.height;
    if (aspect < 1.15) return 0;
    const picture = this.width / 2.39;
    return Math.min(0.14, Math.max(0, (this.height - picture) / 2 / this.height));
  }

  /** How much of the height each bar covered in the last frame (for the live captions). */
  letterboxNow = 0;

  private drawLens(frame: OriginFrame): void {
    const gl = this.gl;
    const full = (target: RenderTarget) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
    };
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.fullscreenVao);
    const bu = this.u.bright;
    full(this.down[0]!);
    gl.useProgram(this.brightProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.texture);
    gl.uniform1i(bu('u_scene'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.gasTarget.texture);
    gl.uniform1i(bu('u_gas'), 1);
    gl.uniform2f(bu('u_texel'), 1 / this.scene.width, 1 / this.scene.height);
    gl.uniform1f(bu('u_threshold'), this.kit.hdr ? 0.85 : 0.6);
    gl.uniform1f(bu('u_knee'), 0.45);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const du = this.u.down;
    gl.useProgram(this.downProgram);
    gl.uniform1i(du('u_src'), 0);
    for (let i = 1; i < this.down.length; i++) {
      const source = this.down[i - 1]!;
      full(this.down[i]!);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      gl.uniform2f(du('u_texel'), 1 / source.width, 1 / source.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    const uu = this.u.up;
    gl.useProgram(this.upProgram);
    gl.uniform1i(uu('u_low'), 0);
    gl.uniform1i(uu('u_high'), 1);
    for (let i = this.down.length - 2; i >= 0; i--) {
      const low = i === this.down.length - 2 ? this.down[i + 1]! : this.up[i + 1]!;
      full(this.up[i]!);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, low.texture);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.down[i]!.texture);
      gl.uniform2f(uu('u_texel'), 1 / low.width, 1 / low.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    if (!this.quality.lensExtras || frame.post.streak <= 0.001) return;
    const su = this.u.streak;
    gl.useProgram(this.streakProgram);
    gl.uniform1i(su('u_src'), 0);
    const passes: [RenderTarget, RenderTarget, number][] = [
      [this.down[1] ?? this.down[0]!, this.streakA, 1.5],
      [this.streakA, this.streakB, 5],
      [this.streakB, this.streakA, 10],
    ];
    passes.forEach(([source, target, step], i) => {
      full(target);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      gl.uniform2f(su('u_texel'), 1 / target.width, 1 / target.height);
      gl.uniform1f(su('u_step'), step);
      gl.uniform1f(su('u_gain'), i === 0 ? 1.4 : 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    });
  }

  private drawBillboards(list: Billboard[], viewProj: Float32Array, proj11: number, aspect: number, wall: number): void {
    if (list.length === 0) return;
    const gl = this.gl;
    const bu = this.u.billboard;
    gl.useProgram(this.billboardProgram);
    gl.uniformMatrix4fv(bu('u_viewProj'), false, viewProj);
    gl.uniform1f(bu('u_proj11'), proj11);
    gl.uniform1f(bu('u_aspect'), aspect);
    gl.uniform1f(bu('u_viewportH'), this.height);
    gl.uniform1f(bu('u_spread'), 3.2);
    gl.uniform1f(bu('u_time'), wall);
    gl.uniform1f(bu('u_gain'), 1);
    gl.bindVertexArray(this.billboardVao);
    const stars = list.filter(item => item.mode !== 1);
    const worlds = list.filter(item => item.mode === 1);
    const upload = (items: Billboard[]) => {
      const data = new Float32Array(items.length * 12);
      items.forEach((b, i) => data.set([...b.pos, b.radius, ...b.color, b.intensity, b.granulation, b.tension, b.mode, b.seed], i * 12));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    };
    if (stars.length > 0) {
      gl.blendFunc(gl.ONE, gl.ONE);
      upload(stars);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, stars.length);
    }
    if (worlds.length > 0) {
      // Worlds are lit by the young star at the centre of their disk.
      const star = list.find(item => item.mode === 0 && item.pos === DISK);
      const light = star ? [star.pos[0] - worlds[0]!.pos[0], star.pos[1] - worlds[0]!.pos[1]] : [0.6, 0.4];
      const len = Math.hypot(light[0]!, light[1]!) || 1;
      gl.uniform2f(bu('u_light'), light[0]! / len, light[1]! / len);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      upload(worlds);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, worlds.length);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.kit.dispose();
  }
}

/**
 * The cosmic web: nodes joined to their nearest neighbours by filaments, dense knots at the nodes,
 * a thin population in the voids, and extra gas around the five cores that later become the first
 * stars. Then the material the central star will shed. Seeded: the same web every time.
 */
function buildMatter(quality: RendererQuality): { data: Float32Array; count: number } {
  const rand = seeded(20261016);
  const gauss = () => {
    const u = Math.max(1e-6, rand());
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const nodes: Vec3[] = [...CORES];
  while (nodes.length < 30) nodes.push([(rand() - 0.5) * 15, (rand() - 0.5) * 9.5, (rand() - 0.5) * 13 - 1.2]);
  const edges: [number, number][] = [];
  nodes.forEach((a, i) => {
    const nearest = nodes
      .map((b, j) => ({ j, d: Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) }))
      .filter(item => item.j !== i)
      .sort((x, y) => x.d - y.d)
      .slice(0, 3);
    for (const { j } of nearest) if (!edges.some(([p, q]) => (p === i && q === j) || (p === j && q === i))) edges.push([i, j]);
  });

  const total = quality.webParticles + quality.materialParticles;
  const data = new Float32Array(total * 9);
  let n = 0;
  const push = (pos: Vec3, kind: number, core: number) => {
    data.set([pos[0], pos[1], pos[2], rand(), rand(), rand(), rand(), kind, core], n * 9);
    n++;
  };
  const coreOf = (pos: Vec3): number => {
    for (let c = 0; c < CORES.length; c++) {
      const core = CORES[c]!;
      if (Math.hypot(pos[0] - core[0], pos[1] - core[1], pos[2] - core[2]) < (c === 0 ? 1.5 : 1.1)) return c;
    }
    return -1;
  };
  const cloudBudget = Math.floor(quality.webParticles * 0.24);
  const filamentBudget = Math.floor(quality.webParticles * 0.52);
  const knotBudget = Math.floor(quality.webParticles * 0.16);
  const voidBudget = quality.webParticles - cloudBudget - filamentBudget - knotBudget;
  for (let i = 0; i < filamentBudget; i++) {
    const [a, b] = edges[Math.floor(rand() * edges.length)]!;
    const p = nodes[a]!;
    const q = nodes[b]!;
    const t = rand();
    const thickness = 0.06 + 0.16 * Math.abs(Math.sin(t * Math.PI));
    const pos: Vec3 = [p[0] + (q[0] - p[0]) * t + gauss() * thickness, p[1] + (q[1] - p[1]) * t + gauss() * thickness, p[2] + (q[2] - p[2]) * t + gauss() * thickness];
    push(pos, 0, coreOf(pos));
  }
  for (let i = 0; i < knotBudget; i++) {
    const node = nodes[Math.floor(rand() * nodes.length)]!;
    const pos: Vec3 = [node[0] + gauss() * 0.32, node[1] + gauss() * 0.32, node[2] + gauss() * 0.32];
    push(pos, 0, coreOf(pos));
  }
  for (let i = 0; i < cloudBudget; i++) {
    const c = i % 3 === 0 ? 0 : 1 + (i % 4);
    const core = CORES[c]!;
    const spread = c === 0 ? 0.75 : 0.55;
    push([core[0] + gauss() * spread, core[1] + gauss() * spread, core[2] + gauss() * spread], 0, c);
  }
  for (let i = 0; i < voidBudget; i++) {
    const pos: Vec3 = [(rand() - 0.5) * 16, (rand() - 0.5) * 10, (rand() - 0.5) * 14 - 1];
    push(pos, 0, -1);
  }
  for (let i = 0; i < quality.materialParticles; i++) {
    const z = rand() * 2 - 1;
    const phi = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    push([r * Math.cos(phi), z, r * Math.sin(phi)], 1, -1);
  }
  return { data, count: n };
}

export { ORIGIN_DURATION };
