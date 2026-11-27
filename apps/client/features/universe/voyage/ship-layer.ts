/**
 * The rocket of the Universe's voyage, drawn in its own screen-space layer above the sky. One unit is one layout point
 * and y points down, as in the layout. The art is the prototype's six paths on a 60 x 60 board (`Universe.dc.html`,
 * `SHIP` line 869 and `drawShip` lines 870-875); there is no trail, no exhaust particles and no line. It is drawn with
 * three.js, so it lives in the voyage's lazy chunk, away from the main bundle.
 */
import * as THREE from 'three';
import { pixelTexture } from '../space/scene/context';
import { radialGlow } from '../space/texture-data';
import type { DrawnShip } from './ship-motion';

/** The prototype's art board, in its own units. */
const BOARD = 60;
/** The point of the board that sits on the ship's position: the middle of the body. */
const BOARD_CENTRE = { x: 30, y: 27 } as const;
/** Where the flame hangs from the body, which is also what its scale pivots on. */
const FLAME_ROOT = { x: 30, y: 44 } as const;

/**
 * The ship's art, one SVG path per part, in board units: absolute `M`, `L`, `Q`, `C`, `H` and `Z` only, which is what
 * {@link parseSvgPath} reads. Exported so the test can check each against the board.
 */
export const SHIP_PATHS = {
  flame: 'M24 44Q30 63 36 44Z',
  flame2: 'M27 44Q30 55 33 44Z',
  fins: 'M21.5 31L12 47L22 43ZM38.5 31L48 47L38 43Z',
  body: 'M30 5C38.5 13.5 40 30 37 44H23C20 30 21.5 13.5 30 5Z',
  shade: 'M30 5C38.5 13.5 40 30 37 44H31.5C33.5 30 33.5 14 30 5Z',
  nose: 'M30 5C33.8 8.8 36.2 13.6 37.6 19H22.4C23.8 13.6 26.2 8.8 30 5Z',
} as const;

/** The prototype's `drawShip` colours, and the warm light behind the flame (line 1922). */
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

/** The coloured band across the body, and the porthole with its rim, in board units (`drawShip`, lines 873-874). */
const BAND = { x: 22.4, y: 37, width: 15.2, height: 3.2 } as const;
const PORTHOLE = { x: 30, y: 27.5, radius: 4.6, rim: 1.6 } as const;
/** How many segments a curve of the art is cut into. */
const CURVE_SEGMENTS = 32;
/** How fast the flame flickers, in radians per second: the prototype's `sin(T * 40)` (line 872). */
const FLICKER_RATE = 40;
/** The flame's length as a multiple of its full length: `0.4 + flame * (0.9 + 0.2 * sin(T * 40))` (line 872). */
const FLAME_LENGTH_MIN = 0.4;
const FLAME_LENGTH_PER_STRENGTH = 0.9;
const FLICKER_DEPTH = 0.2;
/** The flame is drawn above this strength (`drawShip`, line 872). */
const FLAME_ON = 0.02;
/** The glow is drawn above this flame strength (line 1922). */
const GLOW_ON = 0.25;
/** The glow's opacity at full flame and full presence: `0.45 * flame * fa` (line 1922). */
const GLOW_STRENGTH = 0.45;
/** How far below the middle of the board the glow sits, in board units (the prototype puts it 0.6 of the ship's size behind, line 1922). */
const GLOW_BEHIND = 33;
/** The glow's radius as a multiple of the board: `S * (0.4 + flame * 0.8)` (line 1922). */
const GLOW_RADIUS_MIN = 0.4;
const GLOW_RADIUS_PER_FLAME = 0.8;
/** The size of the glow's texture, in pixels. */
const GLOW_SIZE = 64;
/** The glow round the place a held ship bends toward: the prototype's `PICK` sprite, 88 points across at 0.95 (line 1904). */
const CATCH_GLOW = {
  size: 88,
  opacity: 0.95,
  /** The share of that opacity at the edge of a pull's reach, and the pull strength (0..1) at which it is all there. */
  faintest: 0.15,
  fullAt: 0.6,
  colour: '#FFE44D',
  /** Alpha from the middle out: `rgba(255,228,77,0.55)`, then 0.3 at 0.45 of the way, then 0 (line 272). */
  stops: [
    [0, 0.55],
    [0.45, 0.3],
    [1, 0],
  ],
} as const;
/** The ship is not drawn at or below this opacity: the prototype's `fa <= 0.02` (line 1920). */
const HIDDEN_ALPHA = 0.02;
/** How far either side of the board the layer's camera sees. Parts are ordered by `renderOrder`, not depth, so it only has to be wide enough to cut nothing. */
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

/** The ship's own scene and camera, drawn over the sky by the caller. */
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
  /** Releases the geometries, materials and glow texture the layer made. */
  dispose(): void;
}

/** The shapes as one geometry, moved by (`dx`, `dy`) so a part can turn and scale about its own root. */
function translatedGeometry(shapes: THREE.Shape[], dx = 0, dy = 0): THREE.ShapeGeometry {
  const geometry = new THREE.ShapeGeometry(shapes, CURVE_SEGMENTS);
  geometry.translate(dx, dy, 0);
  return geometry;
}

/** A full circle as a shape, for the porthole. */
function circleShape(x: number, y: number, radius: number): THREE.Shape {
  const shape = new THREE.Shape();
  shape.absarc(x, y, radius, 0, Math.PI * 2, false);
  return shape;
}

/** A rectangle as a shape, for the band. */
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
  /** The parts' materials: they share the ship's opacity; the glow's has its own. */
  const partMaterials: THREE.MeshBasicMaterial[] = [];
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
    partMaterials.push(material);
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

  // The catch glow lies under the ship, on the place it would go to, in screen points.
  const catchTexture = pixelTexture(radialGlow(CATCH_GLOW.stops, GLOW_SIZE));
  const catchMaterial = new THREE.SpriteMaterial({
    map: catchTexture,
    color: CATCH_GLOW.colour,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  materials.push(catchMaterial);
  const catchGlow = new THREE.Sprite(catchMaterial);
  // Drawn before every part of the ship (the parts count up from 0).
  catchGlow.renderOrder = -1;
  catchGlow.visible = false;
  catchGlow.scale.set(CATCH_GLOW.size, CATCH_GLOW.size, 1);

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
  scene.add(catchGlow);

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
      const catchAt = ship.catchAt ?? null;
      catchGlow.visible = root.visible && catchAt !== null;
      if (catchAt !== null) {
        catchGlow.position.set(catchAt.x, catchAt.y, 0);
        // A far body's pull is faint and its glow with it, so the glow growing is the pull growing.
        const pull = Math.min(1, (ship.pullStrength ?? 1) / CATCH_GLOW.fullAt);
        catchMaterial.opacity =
          CATCH_GLOW.opacity * ship.alpha * (CATCH_GLOW.faintest + (1 - CATCH_GLOW.faintest) * pull);
      }
      if (!root.visible) return;
      root.position.set(ship.x, ship.y, 0);
      root.rotation.z = ship.heading;
      root.scale.setScalar(ship.size / BOARD);
      for (const material of partMaterials) material.opacity = ship.alpha;
      flameGroup.visible = ship.flame > FLAME_ON;
      flameGroup.scale.set(
        1,
        FLAME_LENGTH_MIN + ship.flame * (FLAME_LENGTH_PER_STRENGTH + FLICKER_DEPTH * Math.sin(seconds * FLICKER_RATE)),
        1,
      );
      glow.visible = ship.flame > GLOW_ON;
      const radius = BOARD * (GLOW_RADIUS_MIN + ship.flame * GLOW_RADIUS_PER_FLAME);
      glow.scale.set(radius * 2, radius * 2, 1);
      glowMaterial.opacity = GLOW_STRENGTH * ship.flame * ship.alpha;
    },
    dispose() {
      scene.remove(root);
      scene.remove(catchGlow);
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      glowTexture.dispose();
      catchTexture.dispose();
      geometries.length = 0;
      materials.length = 0;
    },
  };
}
