import * as THREE from 'three';
import { pixelTexture } from '../space/scene/context';
import { radialGlow } from '../space/texture-data';
import type { DrawnShip } from './ship-motion';

/**
 * The rocket of the Universe's Round 7.3 look, drawn in its own screen-space layer above the
 * sky. One unit is one layout point and y points down, as in the layout. The art is the
 * prototype's six paths on a 60 x 60 board; there is no trail, no exhaust particles and no line.
 */

/** The prototype's art board, in its own units. */
const BOARD = 60;
/** The point of the board that sits on the ship's position: the middle of the body. */
const BOARD_CENTRE = { x: 30, y: 27 } as const;
/** Where the flame hangs from the body, which is also what its scale pivots on. */
const FLAME_ROOT = { x: 30, y: 44 } as const;

export const SHIP_PATHS = {
  flame: 'M24 44Q30 63 36 44Z',
  flame2: 'M27 44Q30 55 33 44Z',
  fins: 'M21.5 31L12 47L22 43ZM38.5 31L48 47L38 43Z',
  body: 'M30 5C38.5 13.5 40 30 37 44H23C20 30 21.5 13.5 30 5Z',
  shade: 'M30 5C38.5 13.5 40 30 37 44H31.5C33.5 30 33.5 14 30 5Z',
  nose: 'M30 5C33.8 8.8 36.2 13.6 37.6 19H22.4C23.8 13.6 26.2 8.8 30 5Z',
} as const;

const COLOURS = {
  flame: '#FF8A3D',
  flame2: '#FFF0B8',
  fins: '#F26A1B',
  body: '#FAF8F0',
  shade: '#D4CFBF',
  nose: '#FF8A3D',
  band: '#FF8A3D',
  porthole: '#3D8BEA',
  portholeRim: '#1F2A44',
  glow: '#FFAA50',
} as const;

const BAND = { x: 22.4, y: 37, width: 15.2, height: 3.2 } as const;
const PORTHOLE = { x: 30, y: 27.5, radius: 4.6, rim: 1.6 } as const;
const CIRCLE_SEGMENTS = 32;
const FLICKER_RATE = 40;
const GLOW_ON = 0.25;
const GLOW_STRENGTH = 0.45;
const GLOW_BEHIND = 33;
const HIDDEN_ALPHA = 0.02;
const FLAME_ON = 0.02;
const GLOW_SIZE = 64;
const CAMERA_DEPTH = 10;

const COMMAND_ARGUMENTS: Readonly<Record<string, number>> = { M: 2, L: 2, Q: 4, C: 6, H: 1 };

/**
 * Turns an SVG path made of absolute M, L, Q, C, H and Z commands into filled shapes, one per
 * sub-path. Anything else is a mistake in the art and throws.
 */
export function parseSvgPath(path: string): THREE.Shape[] {
  const tokens = path.match(/[A-Za-z]|-?\d*\.?\d+/g) ?? [];
  const shapes: THREE.Shape[] = [];
  let shape: THREE.Shape | null = null;
  let current = { x: 0, y: 0 };
  let at = 0;
  while (at < tokens.length) {
    const command = tokens[at++]!;
    if (command === 'Z') {
      shape = null;
      continue;
    }
    const count = COMMAND_ARGUMENTS[command];
    if (count === undefined) throw new Error(`Unsupported path command ${command}`);
    const numbers = tokens.slice(at, at + count).map(Number);
    if (numbers.length < count || numbers.some(Number.isNaN)) throw new Error(`Bad arguments for ${command}`);
    at += count;
    if (command === 'M') {
      shape = new THREE.Shape();
      shapes.push(shape);
      shape.moveTo(numbers[0]!, numbers[1]!);
      current = { x: numbers[0]!, y: numbers[1]! };
      continue;
    }
    if (shape === null) throw new Error(`Path draws before it starts: ${command}`);
    if (command === 'L') shape.lineTo(numbers[0]!, numbers[1]!);
    else if (command === 'H') shape.lineTo(numbers[0]!, current.y);
    else if (command === 'Q') shape.quadraticCurveTo(numbers[0]!, numbers[1]!, numbers[2]!, numbers[3]!);
    else shape.bezierCurveTo(numbers[0]!, numbers[1]!, numbers[2]!, numbers[3]!, numbers[4]!, numbers[5]!);
    current = command === 'H' ? { x: numbers[0]!, y: current.y } : { x: numbers[count - 2]!, y: numbers[count - 1]! };
  }
  return shapes;
}

export interface ShipLayer {
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  /** Sets the layer to the size of the screen, in layout points. */
  resize(width: number, height: number): void;
  /**
   * Places and paints the ship. `seconds` only drives the flame's flicker; the caller's clock
   * is the only one there is.
   */
  draw(ship: DrawnShip, seconds?: number): void;
  dispose(): void;
}

function translatedGeometry(shapes: THREE.Shape[], dx = 0, dy = 0): THREE.ShapeGeometry {
  const geometry = new THREE.ShapeGeometry(shapes, CIRCLE_SEGMENTS);
  geometry.translate(dx, dy, 0);
  return geometry;
}

function circleShape(x: number, y: number, radius: number): THREE.Shape {
  const shape = new THREE.Shape();
  shape.absarc(x, y, radius, 0, Math.PI * 2, false);
  return shape;
}

function rectangleShape({ x, y, width, height }: { x: number; y: number; width: number; height: number }): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(x, y);
  shape.lineTo(x + width, y);
  shape.lineTo(x + width, y + height);
  shape.lineTo(x, y + height);
  return shape;
}

/** Builds the ship layer. It owns its geometries, materials and texture until `dispose`. */
export function createShipLayer(): ShipLayer {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(0, 1, 0, 1, -CAMERA_DEPTH, CAMERA_DEPTH);
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  let order = 0;

  const addPart = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, colour: string): THREE.Mesh => {
    geometries.push(geometry);
    const material = new THREE.MeshBasicMaterial({
      color: colour,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = order++;
    parent.add(mesh);
    return mesh;
  };

  const glowTexture = pixelTexture(
    radialGlow(
      [
        [0, 1],
        [1, 0],
      ],
      GLOW_SIZE,
    ),
  );
  const glowMaterial = new THREE.SpriteMaterial({
    map: glowTexture,
    color: COLOURS.glow,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  materials.push(glowMaterial);

  const root = new THREE.Group();
  root.visible = false;
  const glow = new THREE.Sprite(glowMaterial);
  glow.renderOrder = order++;
  glow.position.set(0, GLOW_BEHIND, 0);
  root.add(glow);

  const board = new THREE.Group();
  board.position.set(-BOARD_CENTRE.x, -BOARD_CENTRE.y, 0);
  root.add(board);

  const flameGroup = new THREE.Group();
  flameGroup.position.set(FLAME_ROOT.x, FLAME_ROOT.y, 0);
  board.add(flameGroup);
  const aboutFlameRoot = (path: string): THREE.ShapeGeometry =>
    translatedGeometry(parseSvgPath(path), -FLAME_ROOT.x, -FLAME_ROOT.y);
  addPart(flameGroup, aboutFlameRoot(SHIP_PATHS.flame), COLOURS.flame);
  addPart(flameGroup, aboutFlameRoot(SHIP_PATHS.flame2), COLOURS.flame2);

  addPart(board, translatedGeometry(parseSvgPath(SHIP_PATHS.fins)), COLOURS.fins);
  addPart(board, translatedGeometry(parseSvgPath(SHIP_PATHS.body)), COLOURS.body);
  addPart(board, translatedGeometry(parseSvgPath(SHIP_PATHS.shade)), COLOURS.shade);
  addPart(board, translatedGeometry(parseSvgPath(SHIP_PATHS.nose)), COLOURS.nose);
  addPart(board, translatedGeometry([rectangleShape(BAND)]), COLOURS.band);
  const rim = PORTHOLE.rim / 2;
  addPart(board, translatedGeometry([circleShape(PORTHOLE.x, PORTHOLE.y, PORTHOLE.radius + rim)]), COLOURS.portholeRim);
  addPart(board, translatedGeometry([circleShape(PORTHOLE.x, PORTHOLE.y, PORTHOLE.radius - rim)]), COLOURS.porthole);
  scene.add(root);

  const partMaterials = materials.filter((material): material is THREE.MeshBasicMaterial => material !== glowMaterial);

  return {
    scene,
    camera,
    resize(width, height) {
      camera.left = 0;
      camera.right = width;
      camera.top = 0;
      camera.bottom = height;
      camera.updateProjectionMatrix();
    },
    draw(ship, seconds = 0) {
      root.visible = ship.alpha > HIDDEN_ALPHA;
      if (!root.visible) return;
      root.position.set(ship.x, ship.y, 0);
      root.rotation.z = ship.heading;
      root.scale.setScalar(ship.size / BOARD);
      for (const material of partMaterials) material.opacity = ship.alpha;
      flameGroup.visible = ship.flame > FLAME_ON;
      flameGroup.scale.set(1, 0.4 + ship.flame * (0.9 + 0.2 * Math.sin(seconds * FLICKER_RATE)), 1);
      glow.visible = ship.flame > GLOW_ON;
      const radius = BOARD * (0.4 + ship.flame * 0.8);
      glow.scale.set(radius * 2, radius * 2, 1);
      glowMaterial.opacity = GLOW_STRENGTH * ship.flame * ship.alpha;
    },
    dispose() {
      scene.remove(root);
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      glowTexture.dispose();
      geometries.length = 0;
      materials.length = 0;
    },
  };
}
