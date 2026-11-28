import * as THREE from 'three';
import { HALO_REACH, type BuiltSpace } from '../space/scene/build-scene';
import { BACKGROUND_LAYER } from '../space/scene/sky';
import { createSkyBend, type SkyBendFrame } from './sky-bend';

const SIZE = { width: 390, height: 844 };
/** Orbit radius of the one planet, in scene units: 10 units are 193 points across at the distance the camera stands. */
const ORBIT = 10;
const POINTS_PER_UNIT = 19.3;

interface Drawn {
  readonly scene: THREE.Object3D;
  readonly mask: number;
  readonly autoClear: boolean;
}

/** A renderer that only notes what it was asked to draw. */
function recorder() {
  const calls: Drawn[] = [];
  const renderer = {
    autoClear: true,
    getDrawingBufferSize: (into: THREE.Vector2) => into.set(SIZE.width, SIZE.height),
    setRenderTarget: () => {},
    render(scene: THREE.Object3D, camera: THREE.Camera) {
      calls.push({ scene, mask: camera.layers.mask, autoClear: this.autoClear });
    },
  };
  return { renderer: renderer as unknown as THREE.WebGLRenderer, calls };
}

/**
 * A scene seen by a camera on the z axis, 60 units from the origin: one system with its sun at `sunAt`, and a planet
 * on an orbit of {@link ORBIT} units unless `lone`. Its sky is split by `splitSky`.
 */
function sceneWith({ sunAt = new THREE.Vector3(0, 0, 0), lone = false } = {}) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, SIZE.width / SIZE.height, 0.1, 3000);
  camera.position.set(0, 0, 60);
  camera.lookAt(0, 0, 0);
  const holder = new THREE.Group();
  const sun = new THREE.Object3D();
  sun.position.copy(sunAt);
  const world = new THREE.Object3D();
  world.position.copy(sunAt).add(new THREE.Vector3(ORBIT, 0, 0));
  holder.add(sun, world);
  scene.add(holder);
  const splitSky = jest.fn();
  const space = {
    scene,
    camera,
    splitSky,
    anchors: [
      { id: 'star', kind: 'system', name: 'Star', systemId: 'star', object: sun, radius: 1 },
      ...(lone ? [] : [{ id: 'world', kind: 'planet', name: 'World', systemId: 'star', object: world, radius: 0.6 }]),
    ],
  } as unknown as BuiltSpace;
  return { space, holder, world, splitSky };
}

const frame = (over: Partial<SkyBendFrame> = {}): SkyBendFrame => ({
  target: { stop: 'universe', systemId: null, planetId: null },
  size: SIZE,
  dt: 1 / 30,
  reducedMotion: true,
  globe: null,
  ...over,
});

/** The lenses the pass drew this frame, as the shader reads them: (x from the left, y from the bottom, R, θE). */
function lensesOf(calls: readonly Drawn[]): number[][] {
  const screen = calls[1]!.scene as THREE.Scene;
  const material = (screen.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
  return (material.uniforms['lenses']!.value as THREE.Vector4[])
    .map((slot) => slot.toArray())
    .filter((slot) => slot[3] > 0);
}

function drawn(options: Parameters<typeof sceneWith>[0], over: Partial<SkyBendFrame> = {}) {
  const scene = sceneWith(options);
  const bend = createSkyBend();
  bend.attach(scene.space);
  const { renderer, calls } = recorder();
  bend.draw(renderer, scene.space, frame(over));
  return { ...scene, bend, renderer, calls };
}

describe('the bent sky, drawn', () => {
  it('splits the sky off when attached, and draws it alone, then the bent picture, then the bodies over it', () => {
    const { calls, splitSky, renderer } = drawn({});
    expect(splitSky).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.mask).toBe(1 << BACKGROUND_LAYER);
    expect(calls[2]!.mask).toBe(1);
    // The bodies are drawn over the picture, never clearing it.
    expect(calls[2]!.autoClear).toBe(false);
    expect(renderer.autoClear).toBe(true);
  });

  it('rings a system as one mass: centred on its sun, as wide as its planets’ orbits', () => {
    const [lens] = lensesOf(drawn({}).calls);
    expect(lens![0]).toBeCloseTo(SIZE.width / 2, 0);
    // The shader measures from the bottom: a sun in the middle of the view is in the middle either way.
    expect(lens![1]).toBeCloseTo(SIZE.height / 2, 0);
    expect(lens![2]).toBeCloseTo(ORBIT * POINTS_PER_UNIT, -1);
    expect(lens![3]).toBeGreaterThan(0);
    expect(lens![3]).toBeLessThan(lens![2]!);
  });

  it('puts the lens where the sun is: a sun in the top of the view bends the top of the sky', () => {
    const [lens] = lensesOf(drawn({ sunAt: new THREE.Vector3(0, 12, 0) }).calls);
    expect(lens![1]).toBeGreaterThan(SIZE.height / 2);
  });

  it('bends a lone star round its glow', () => {
    const [lens] = lensesOf(drawn({ lone: true }).calls);
    expect(lens![2]).toBeCloseTo(HALO_REACH * POINTS_PER_UNIT, -1);
  });

  it('bends round one planet alone at its planet stop, as wide as its globe (which hides the painted body), and not round its star', () => {
    const scene = sceneWith();
    // The globe sets the painted planet aside while it is drawn.
    scene.world.visible = false;
    const bend = createSkyBend();
    bend.attach(scene.space);
    const { renderer, calls } = recorder();
    bend.draw(
      renderer,
      scene.space,
      frame({
        target: { stop: 'planet', systemId: 'star', planetId: 'world' },
        globe: { x: 120, y: 300, radiusPx: 80 },
      }),
    );
    const lenses = lensesOf(calls);
    expect(lenses).toHaveLength(1);
    expect(lenses[0]!.slice(0, 3)).toEqual([120, SIZE.height - 300, 80]);
  });

  it('bends round the star the camera is at, and not the planets beside it', () => {
    expect(lensesOf(drawn({}, { target: { stop: 'star', systemId: 'star', planetId: null } }).calls)).toHaveLength(1);
  });

  it('bends nothing on the ground, nor round a system that is not drawn', () => {
    expect(lensesOf(drawn({}, { target: { stop: 'ground', systemId: 'star', planetId: 'world' } }).calls)).toHaveLength(
      0,
    );
    const hidden = sceneWith();
    hidden.holder.visible = false;
    const bend = createSkyBend();
    bend.attach(hidden.space);
    const { renderer, calls } = recorder();
    bend.draw(renderer, hidden.space, frame());
    expect(lensesOf(calls)).toHaveLength(0);
  });

  it('eases a lens in, and sets it at once under reduced motion', () => {
    const easing = lensesOf(drawn({}, { reducedMotion: false }).calls)[0]!;
    const still = lensesOf(drawn({}).calls)[0]!;
    expect(easing[3]).toBeGreaterThan(0);
    expect(easing[3]).toBeLessThan(still[3]!);
  });

  it('draws a scene it is not attached to plainly, and is left holding nothing of it', () => {
    const first = sceneWith();
    const second = sceneWith();
    const bend = createSkyBend();
    bend.attach(first.space);
    bend.attach(second.space);
    const { renderer, calls } = recorder();
    bend.draw(renderer, first.space, frame());
    expect(calls).toHaveLength(1);
  });
});
