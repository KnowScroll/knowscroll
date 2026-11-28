/**
 * The trial's way of drawing a frame: the background (the sky shells and the deep field, on their own layer) is drawn
 * alone into a render target, then drawn to the screen in one full-screen pass that bends it round up to six group
 * lenses (`sky-lens.ts`), and everything else (suns, planets, glows, rings, the globe) is drawn over it as it always
 * was, so a body is never bent, only the sky behind it. The profile in the fragment shader mirrors `sourceOf` in
 * `sky-lens.ts`, which is tested.
 *
 * Made once per driver and only used by it: the shipping map draws its one pass as ever and never reaches this file.
 */
import * as THREE from 'three';
import { BACKGROUND_LAYER } from '../space/scene/sky';
import { FADE_END, FADE_START, LENS_SLOTS, type Lens } from './sky-lens';

const VERTEX = /* glsl */ `varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/**
 * `lenses[i]` is a lens's centre measured from the bottom left of the view (y up, as the texture is), its group radius R
 * and its Einstein radius θE, all in layout points (`view` is the view's size in the same points; θE 0 is no lens). A
 * pixel at offset `d` from a lens reads the background at `d · (1 - θE² / max(|d|, R)²)` from that lens's centre, the
 * shift faded out between 3R and 6R; shifts add. Where that falls off the picture it is the sky's own colour (the
 * renderer's clear colour, 0x020308), never a smear of the edge.
 */
const FRAGMENT = /* glsl */ `uniform sampler2D map; uniform vec4 lenses[${LENS_SLOTS}]; uniform vec2 view; varying vec2 vUv;
void main(){
  vec2 p = vUv * view; vec2 shift = vec2(0.0);
  for (int i = 0; i < ${LENS_SLOTS}; i++) { vec4 l = lenses[i]; if (l.w <= 0.0) continue;
    vec2 d = p - l.xy; float r = length(d); float reach = max(r, l.z);
    shift -= d * (l.w * l.w / (reach * reach)) * (1.0 - smoothstep(${FADE_START.toFixed(1)} * l.z, ${FADE_END.toFixed(1)} * l.z, r)); }
  vec2 src = vUv + shift / view;
  bool off = src.x < 0.0 || src.y < 0.0 || src.x > 1.0 || src.y > 1.0;
  gl_FragColor = off ? vec4(0.0078, 0.0118, 0.0314, 1.0) : texture2D(map, src); }`;

export interface SkyPass {
  /**
   * Draws `space` for one frame: its background bent by `lenses` (layout points, y down, `size` the view's size in
   * layout points), then the rest of the scene over it.
   */
  draw(
    renderer: THREE.WebGLRenderer,
    space: { readonly scene: THREE.Scene; readonly camera: THREE.Camera },
    lenses: readonly Lens[],
    size: { readonly width: number; readonly height: number },
  ): void;
  /** Frees the render target and the pass's own program. */
  dispose(): void;
}

export function createSkyPass(): SkyPass {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    depthBuffer: false,
    // As smooth as the screen's own picture (it is drawn with antialiasing): with no lens the pass changes nothing.
    samples: 4,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const slots = Array.from({ length: LENS_SLOTS }, () => new THREE.Vector4(0, 0, 0, 0));
  const view = new THREE.Vector2(1, 1);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    depthTest: false,
    depthWrite: false,
    uniforms: { map: { value: target.texture }, lenses: { value: slots }, view: { value: view } },
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const screen = new THREE.Scene();
  screen.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const buffer = new THREE.Vector2();

  return {
    draw(renderer, space, lenses, size) {
      renderer.getDrawingBufferSize(buffer);
      if (target.width !== buffer.x || target.height !== buffer.y) target.setSize(buffer.x, buffer.y);
      view.set(Math.max(1, size.width), Math.max(1, size.height));
      slots.forEach((slot, index) => {
        const lens = lenses[index];
        // The shader measures from the bottom of the view; layout measures from the top.
        if (lens === undefined) slot.set(0, 0, 0, 0);
        else slot.set(lens.x, view.y - lens.y, lens.radius, lens.einstein);
      });

      const layers = space.camera.layers.mask;
      const autoClear = renderer.autoClear;
      try {
        space.camera.layers.set(BACKGROUND_LAYER);
        renderer.setRenderTarget(target);
        renderer.render(space.scene, space.camera);
        renderer.setRenderTarget(null);
        renderer.render(screen, camera);
        // Everything but the background, over the bent picture, depth freshly cleared by the pass above.
        space.camera.layers.mask = layers;
        renderer.autoClear = false;
        renderer.render(space.scene, space.camera);
      } finally {
        space.camera.layers.mask = layers;
        renderer.autoClear = autoClear;
        renderer.setRenderTarget(null);
      }
    },
    dispose() {
      target.dispose();
      quad.geometry.dispose();
      material.dispose();
    },
  };
}
