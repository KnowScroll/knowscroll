import * as THREE from 'three';
import { createShipLayer, parseSvgPath, SHIP_PATHS } from './ship-layer';
import type { DrawnShip } from './ship-motion';

const SHIP: DrawnShip = { x: 100, y: 200, size: 32, heading: 0.3, flame: 0.5, alpha: 1 };

const meshes = (scene: THREE.Scene): THREE.Mesh[] => {
  const found: THREE.Mesh[] = [];
  scene.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) found.push(node as THREE.Mesh);
  });
  return found;
};
const sprites = (scene: THREE.Scene): THREE.Sprite[] => {
  const found: THREE.Sprite[] = [];
  scene.traverse((node) => {
    if ((node as THREE.Sprite).isSprite) found.push(node as THREE.Sprite);
  });
  return found;
};

describe('the ship path parser', () => {
  it.each(Object.entries(SHIP_PATHS))('turns %s into a shape with area', (_name, path) => {
    const shapes = parseSvgPath(path);
    expect(shapes.length).toBeGreaterThan(0);
    for (const shape of shapes) {
      expect(shape.getPoints(8).length).toBeGreaterThan(2);
      expect(Math.abs(THREE.ShapeUtils.area(shape.getPoints(8)))).toBeGreaterThan(1);
    }
  });

  it('makes one shape per sub-path, so the two fins are two shapes', () => {
    expect(parseSvgPath(SHIP_PATHS.fins)).toHaveLength(2);
  });

  it('keeps the body inside the 60 x 60 board, from its nose at (30, 5)', () => {
    const points = parseSvgPath(SHIP_PATHS.body)[0]!.getPoints(12);
    const box = new THREE.Box2().setFromPoints(points);
    expect(box.min.y).toBeCloseTo(5, 5);
    expect(box.max.y).toBeCloseTo(44, 5);
    expect(box.min.x).toBeGreaterThan(19);
    expect(box.max.x).toBeLessThan(41);
  });

  it('reads H as a horizontal line at the current height', () => {
    const [shape] = parseSvgPath('M0 0L10 5H20L0 10Z');
    expect(shape!.getPoints(1).some((point) => point.x === 20 && point.y === 5)).toBe(true);
  });

  it('refuses a command it does not draw', () => {
    expect(() => parseSvgPath('M0 0A5 5 0 0 1 10 10Z')).toThrow(/Unsupported/);
  });
});

describe('the ship layer', () => {
  it('draws a ship at the given place, turn and size', () => {
    const layer = createShipLayer();
    layer.resize(390, 844);
    layer.draw(SHIP, 1);
    const root = layer.scene.children[0]!;
    expect(root.visible).toBe(true);
    expect(root.position.x).toBe(100);
    expect(root.position.y).toBe(200);
    expect(root.rotation.z).toBeCloseTo(0.3, 5);
    expect(root.scale.x).toBeCloseTo(32 / 60, 5);
    expect(layer.camera.right).toBe(390);
    expect(layer.camera.bottom).toBe(844);
    layer.dispose();
  });

  it('is invisible at alpha 0 and when almost faded', () => {
    const layer = createShipLayer();
    layer.draw({ ...SHIP, alpha: 0 });
    expect(layer.scene.children[0]!.visible).toBe(false);
    layer.draw({ ...SHIP, alpha: 0.01 });
    expect(layer.scene.children[0]!.visible).toBe(false);
    layer.draw({ ...SHIP, alpha: 0.5 });
    expect(layer.scene.children[0]!.visible).toBe(true);
    for (const mesh of meshes(layer.scene)) expect((mesh.material as THREE.Material).opacity).toBe(0.5);
    layer.dispose();
  });

  it('stretches the flame with its strength and flickers, and lights the glow only when strong', () => {
    const layer = createShipLayer();
    const flame = (): THREE.Object3D => meshes(layer.scene)[0]!.parent!;
    const [glow] = sprites(layer.scene);
    layer.draw({ ...SHIP, flame: 0 });
    expect(flame().visible).toBe(false);
    expect(glow!.visible).toBe(false);
    layer.draw({ ...SHIP, flame: 0.2 }, 0);
    expect(flame().scale.y).toBeCloseTo(0.4 + 0.2 * 0.9, 5);
    expect(glow!.visible).toBe(false);
    layer.draw({ ...SHIP, flame: 1 }, Math.PI / 80);
    expect(flame().scale.y).toBeCloseTo(0.4 + 1.1, 5);
    expect(glow!.visible).toBe(true);
    expect(glow!.material.blending).toBe(THREE.AdditiveBlending);
    layer.dispose();
  });

  it('makes no trail and no lines: only filled shapes, the flame glow, the catch glow and the ground shadow', () => {
    const layer = createShipLayer();
    let lines = 0;
    layer.scene.traverse((node) => {
      if ((node as THREE.Line).isLine || (node as THREE.Points).isPoints) lines += 1;
    });
    expect(lines).toBe(0);
    expect(meshes(layer.scene)).toHaveLength(9);
    expect(sprites(layer.scene)).toHaveLength(3);
    layer.dispose();
  });

  it('lights the place a held ship would go to, under the ship, and nothing when there is none', () => {
    const layer = createShipLayer();
    const catchGlow = layer.scene.children[1] as THREE.Sprite;
    layer.draw({ ...SHIP, catchAt: { x: 140, y: 260 } });
    expect(catchGlow.visible).toBe(true);
    expect(catchGlow.position.x).toBe(140);
    expect(catchGlow.position.y).toBe(260);
    expect(catchGlow.scale.x).toBe(88);
    expect(catchGlow.renderOrder).toBeLessThan(Math.min(...meshes(layer.scene).map((mesh) => mesh.renderOrder)));
    layer.draw({ ...SHIP, catchAt: null });
    expect(catchGlow.visible).toBe(false);
    layer.draw({ ...SHIP, alpha: 0, catchAt: { x: 140, y: 260 } });
    expect(catchGlow.visible).toBe(false);
    layer.dispose();
  });

  it('lays a soft shadow on the land under a ship on the ground, below the ship, and none elsewhere', () => {
    const layer = createShipLayer();
    const shadow = layer.scene.children[2] as THREE.Sprite;
    layer.draw(SHIP);
    expect(shadow.visible).toBe(false);
    layer.draw({ ...SHIP, shadow: { x: 104, y: 222, width: 30, height: 8, opacity: 0.4 } });
    expect(shadow.visible).toBe(true);
    expect([shadow.position.x, shadow.position.y]).toEqual([104, 222]);
    expect([shadow.scale.x, shadow.scale.y]).toEqual([30, 8]);
    expect(shadow.material.opacity).toBeCloseTo(0.4, 6);
    // A soft ellipse from a gradient: a sprite of a radial texture, never a line or a ring, and under everything else.
    expect(shadow.material.map).toBeTruthy();
    expect(shadow.renderOrder).toBeLessThan(Math.min(...meshes(layer.scene).map((mesh) => mesh.renderOrder)));
    expect(shadow.renderOrder).toBeLessThan((layer.scene.children[1] as THREE.Sprite).renderOrder);
    // It does not turn or rise with the ship: it is placed on the ground, not under the ship's group.
    expect(shadow.parent).toBe(layer.scene);
    layer.draw({ ...SHIP, shadow: { x: 104, y: 222, width: 30, height: 8, opacity: 0 } });
    expect(shadow.visible).toBe(false);
    layer.dispose();
  });

  it('releases every geometry, material and the glow texture on dispose', () => {
    const layer = createShipLayer();
    const geometryDisposals = meshes(layer.scene).map((mesh) => jest.spyOn(mesh.geometry, 'dispose'));
    const materialDisposals = meshes(layer.scene).map((mesh) => jest.spyOn(mesh.material as THREE.Material, 'dispose'));
    const [glow] = sprites(layer.scene);
    const glowDisposal = jest.spyOn(glow!.material, 'dispose');
    const textureDisposal = jest.spyOn(glow!.material.map!, 'dispose');
    layer.dispose();
    for (const spy of [...geometryDisposals, ...materialDisposals, glowDisposal, textureDisposal]) {
      expect(spy).toHaveBeenCalled();
    }
    expect(layer.scene.children).toHaveLength(0);
  });
});
