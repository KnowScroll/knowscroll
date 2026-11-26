import * as THREE from 'three';
import { hexToUnit } from '../space/paint';
import type { SpaceSurface } from '../space/space-surface';
import type { CrossingFrame } from './crossing-frame';
import { CROSSING_FRAGMENT, CROSSING_VERTEX, crossingPixelRatio } from './crossing-shader';

/** The crossing's shader on a surface: one full-screen pass, drawn from a {@link CrossingFrame}. */
export interface CrossingRenderer {
  /** Draws the shader's part of `frame` (the marks over it are not this renderer's). */
  draw(frame: CrossingFrame): void;
  /** Layout size changed. The caller draws again: a resize clears the buffer. */
  resize(width: number, height: number): void;
  /** Releases the GPU resources; `releaseContext` also frees the browser's WebGL context. */
  dispose(options?: { releaseContext?: boolean }): void;
}

/**
 * Makes the crossing's renderer on a surface. Loaded on demand (`load-crossing-renderer.ts`), so three.js and the shader
 * are not in the bundle every other screen loads. The picture is a pure function of the frame: no clock in here.
 */
export function createCrossingRenderer(surface: SpaceSurface): CrossingRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas: surface.canvas as HTMLCanvasElement,
    context: surface.context,
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    powerPreference: 'low-power',
    preserveDrawingBuffer: surface.preserveDrawingBuffer === true,
  });
  renderer.setPixelRatio(crossingPixelRatio(surface.pixelRatio));
  renderer.setSize(surface.width, surface.height, false);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

  const uniforms = {
    uRes: { value: new THREE.Vector2(1, 1) },
    uC: { value: new THREE.Vector2() },
    uT: { value: 0 },
    uR: { value: 0 },
    uOpen: { value: 0 },
    uK: { value: 0 },
    uTwist: { value: 0 },
    uSpeed: { value: 0 },
    uFar: { value: 0 },
    uDark: { value: 0 },
    uGlow: { value: 0 },
    uSeed: { value: 0 },
    uA: { value: new THREE.Vector3() },
    uM: { value: new THREE.Vector3() },
    uB: { value: new THREE.Vector3() },
  };
  const material = new THREE.ShaderMaterial({
    vertexShader: CROSSING_VERTEX,
    fragmentShader: CROSSING_FRAGMENT,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
  const geometry = new THREE.PlaneGeometry(2, 2);
  const pass = new THREE.Mesh(geometry, material);
  pass.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(pass);
  const camera = new THREE.Camera();
  const bufferSize = new THREE.Vector2();

  return {
    draw(frame) {
      const shader = frame.shader;
      // The shader works in drawing-buffer pixels, so the buffer's own size is asked for, not the layout's.
      renderer.getDrawingBufferSize(bufferSize);
      uniforms.uRes.value.copy(bufferSize);
      uniforms.uC.value.set(shader.centre[0], shader.centre[1]);
      uniforms.uT.value = shader.time;
      uniforms.uR.value = shader.ballRadius;
      uniforms.uOpen.value = shader.open;
      uniforms.uK.value = shader.tint;
      uniforms.uTwist.value = shader.twist;
      uniforms.uSpeed.value = shader.speed;
      uniforms.uFar.value = shader.farRadius;
      uniforms.uDark.value = shader.dark;
      uniforms.uGlow.value = shader.glow;
      uniforms.uSeed.value = shader.seed;
      uniforms.uA.value.set(...hexToUnit(shader.colours.a));
      uniforms.uM.value.set(...hexToUnit(shader.colours.m));
      uniforms.uB.value.set(...hexToUnit(shader.colours.b));
      renderer.render(scene, camera);
      surface.present?.();
    },
    resize(width, height) {
      renderer.setSize(width, height, false);
    },
    dispose(options) {
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (options?.releaseContext === true && surface.context === undefined) renderer.forceContextLoss();
    },
  };
}
