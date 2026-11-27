import * as THREE from 'three';
import type { BuiltSpace } from '../space/scene/build-scene';
import { createSceneContext } from '../space/scene/build-scene';
import { addSky, bendSky, type BentSky } from '../space/scene/sky';
import { createSkyBend } from './sky-bend';

const SIZE = { width: 390, height: 844 };

/** A scene with one star at `at`, seen by a camera on the z axis looking at the origin, and its real bent sky. */
function sceneWith(at: THREE.Vector3, radius = 4) {
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  scene.add(group);
  const { context } = createSceneContext([10, 100], 1);
  const shells = addSky(group, 'sky', context, new THREE.Vector3(0, 0, 60));
  const camera = new THREE.PerspectiveCamera(40, SIZE.width / SIZE.height, 0.1, 3000);
  camera.position.set(0, 0, 60);
  camera.lookAt(0, 0, 0);
  const holder = new THREE.Group();
  const star = new THREE.Object3D();
  star.position.copy(at);
  holder.add(star);
  scene.add(holder);
  let bent: BentSky | null = null;
  const space = {
    scene,
    camera,
    anchors: [{ id: 'star', kind: 'system', name: 'Star', systemId: 'star', object: star, radius }],
    bentSky: () => (bent ??= bendSky(shells, group, context)),
  } as unknown as BuiltSpace;
  const lens = () => {
    const uniforms = (shells[0]!.material as THREE.ShaderMaterial).uniforms;
    return (uniforms['lenses']!.value as THREE.Vector4[])[0]!;
  };
  return { space, holder, camera, lens };
}

const frame = (dt: number, reducedMotion = false, stop: 'universe' | 'ground' = 'universe') => ({
  stop,
  size: SIZE,
  dt,
  reducedMotion,
});

describe('the bent sky, drawn', () => {
  it('puts a body’s lens where the body is: one in the top of the view bends the top of the sky', () => {
    const { space, lens } = sceneWith(new THREE.Vector3(0, 12, 0));
    const bend = createSkyBend();
    bend.attach(space);
    bend.draw(space, frame(1 / 30, true));
    const { y, z } = lens();
    expect(z).toBeGreaterThan(0);
    // The shader measures from the bottom: a body above the middle has its lens above the middle too.
    expect(y).toBeGreaterThan(SIZE.height / 2);
  });

  it('eases a lens in, and sets it at once under reduced motion', () => {
    const eased = sceneWith(new THREE.Vector3(0, 0, 0));
    const easing = createSkyBend();
    easing.attach(eased.space);
    easing.draw(eased.space, frame(1 / 30));
    const still = sceneWith(new THREE.Vector3(0, 0, 0));
    const snapping = createSkyBend();
    snapping.attach(still.space);
    snapping.draw(still.space, frame(1 / 30, true));
    expect(eased.lens().z).toBeGreaterThan(0);
    expect(eased.lens().z).toBeLessThan(still.lens().z);
  });

  it('bends nothing round a body that is not drawn, and nothing on the ground', () => {
    const hidden = sceneWith(new THREE.Vector3(0, 0, 0));
    hidden.holder.visible = false;
    const bend = createSkyBend();
    bend.attach(hidden.space);
    bend.draw(hidden.space, frame(1 / 30, true));
    expect(hidden.lens().z).toBe(0);

    const onGround = sceneWith(new THREE.Vector3(0, 0, 0));
    const groundBend = createSkyBend();
    groundBend.attach(onGround.space);
    groundBend.draw(onGround.space, frame(1 / 30, true, 'ground'));
    expect(onGround.lens().z).toBe(0);
  });

  it('leaves alone a scene it is no longer attached to', () => {
    const first = sceneWith(new THREE.Vector3(0, 0, 0));
    const second = sceneWith(new THREE.Vector3(0, 0, 0));
    const bend = createSkyBend();
    bend.attach(first.space);
    bend.attach(second.space);
    bend.draw(first.space, frame(1 / 30, true));
    expect(first.lens().z).toBe(0);
  });
});
