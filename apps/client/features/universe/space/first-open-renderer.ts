import * as THREE from 'three';
import {
  CORE,
  END_POSITION,
  FIRST_OPEN,
  distanceAt,
  firstOpenFrame,
  pathPoint,
  shockAt,
  streakSpeedAt,
  streamedAt,
  warpAt,
} from '../animation/first-open-timeline';
import { smoothstep as smooth } from '../animation/easing';
import { cappedPixelRatio } from './frame-clock';
import { hexToUnit, seededRandom, TAU } from './paint';
import { planetGenome, type HazeFamily, type PlanetType } from './planet-genome';
import { buildSystem, createSceneContext } from './scene/build-scene';
import { additive, hazeUniforms } from './scene/context';
import { makeHalo } from './scene/halo';
import { makeNebula } from './scene/nebula';
import { makePlanet } from './scene/planet';
import { addSky } from './scene/sky';
import { makeSun } from './scene/sun';
import { NEBULA_FRAGMENT, PLANET_FRAGMENT, WORLD_VERTEX } from './scene/shaders';
import { paintPlanet } from './texture-data';
import type { SpaceRenderer } from './space-renderer';
import type { SpaceSurface } from './space-surface';

/**
 * The first open's picture (design "First open"): candy dust streams in along five spiral arms and builds a star
 * that trembles and bursts; a long trip past planets, galaxies, asteroids and two systems; a slow build to light
 * speed; a smooth stop on U01 Empty. One three.js scene, one camera on one straight path whose position is a pure
 * function of the animation's `t`, which `clock` supplies. The approved builders draw every body in it.
 *
 * Simplifications against the design file, kept honest in the PR: the forming star is the approved sun (no painted
 * convection cells), and the asteroids share one painted rock.
 */

const DUST = 14_000;
const SPARKLES = 2_600;
const STREAKS = 1_500;
const NEAR_STREAKS = 560;
const CANDY = ['#FF7AD9', '#C58BFF', '#EBAAFF'].map(hexToUnit);
const WARM = ['#FFB861', '#FFE08A', '#FFF3D6'].map(hexToUnit);
const SPARKLE_COLOURS = ['#FFF3D6', '#FFE08A', '#FFB3EC'].map(hexToUnit);

const DUST_VERTEX = /* glsl */ `attribute vec3 aDir; attribute vec3 aOut; attribute float aR0; attribute float aDel; attribute float aDur; attribute float aSpd; attribute float aSize; attribute vec3 aCol; attribute float aJit; attribute float aArm; attribute float aH;
uniform float T; uniform float tBang; uniform float pr; varying vec3 vC; varying float vA;
vec3 rotY(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }
void main(){ vec3 p; vec3 warm = vec3(1.0, .86, .6);
  if (T < tBang) { float k = clamp((T - aDel) / aDur, 0.0, 1.0); float rho = aR0 * (1.0 - k);
    if (aArm >= 0.0) { float a = aArm * 6.28318 / 5.0 + log(max(rho, .05) / .6) * 1.15 + T * .25 + (aJit - .5) * .38;
      p = vec3(cos(a) * rho, aH * (.3 + rho * .1), sin(a) * rho); }
    else p = rotY(aDir, (1.0 - rho / aR0) * 3.6 + T * .12 + aJit * .2) * rho;
    vC = mix(warm, aCol, smoothstep(.04, .3, rho / aR0)); vA = smoothstep(aDel, aDel + .5, T) * smoothstep(.7, 2.0, rho); }
  else { float e = T - tBang; float rho = aSpd * (1.0 - exp(-e * 2.6)) + aSpd * .12 * e; p = aOut * rho;
    vC = mix(vec3(1.0, .97, .9), aCol, smoothstep(.05, .7, e)); vA = 1.0 - smoothstep(2.2, 3.4, e); }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = min(aSize * pr * (30.0 / -mv.z), 22.0 * pr); gl_Position = projectionMatrix * mv; }`;

const SPARKLE_VERTEX = /* glsl */ `attribute vec3 aP; attribute vec3 aOut; attribute float aB; attribute float aSize; attribute vec3 aCol; attribute float aPh;
uniform float T; uniform float tBang; uniform float tShake; uniform float pr; varying vec3 vC; varying float vA;
void main(){ vec3 p;
  if (T < tBang) { float a = T * (.25 + aPh * .3), c = cos(a), s = sin(a); p = vec3(c * aP.x + s * aP.z, aP.y, -s * aP.x + c * aP.z);
    float v = smoothstep(tShake, tBang, T); p += vec3(sin(T * 31.0 + aPh * 40.0), cos(T * 27.0 + aPh * 30.0), sin(T * 23.0 + aPh * 20.0)) * .04 * v;
    p *= 1.0 - .4 * smoothstep(tBang - .22, tBang, T);
    float f = 2.0 + aPh * 3.0 + v * 6.0; vA = smoothstep(aB, aB + .35, T) * (.3 + .7 * pow(.5 + .5 * sin(T * f + aPh * 60.0), 3.0)); }
  else { float e = T - tBang; p = aP + aOut * (14.0 + aPh * 30.0) * (1.0 - exp(-e * 2.4)); vA = 1.0 - smoothstep(.6, 1.8, e); }
  vC = aCol; vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = min(aSize * pr * (30.0 / -mv.z), 26.0 * pr); gl_Position = projectionMatrix * mv; }`;

const SPARKLE_FRAGMENT = /* glsl */ `varying vec3 vC; varying float vA;
void main(){ vec2 q = gl_PointCoord - .5; float d = length(q);
  float ray = max(smoothstep(.07, 0.0, abs(q.x)) * smoothstep(.5, 0.0, abs(q.y)), smoothstep(.07, 0.0, abs(q.y)) * smoothstep(.5, 0.0, abs(q.x)));
  gl_FragColor = vec4(vC * max(smoothstep(.16, 0.0, d), ray * .85) * vA, 1.0); }`;

const RING_FRAGMENT = /* glsl */ `uniform vec3 col; uniform float a; varying vec2 vUv;
void main(){ float r = length(vUv * 2.0 - 1.0); float g = exp(-pow((r - .84) / .06, 2.0)) + exp(-pow((r - .62) / .2, 2.0)) * .22; gl_FragColor = vec4(col * g * a, 1.0); }`;

const HEAD_VERTEX = /* glsl */ `attribute vec3 color; uniform float pr; varying vec3 vC; void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = clamp(60.0 / -mv.z, 1.5, 5.0) * pr; gl_Position = projectionMatrix * mv; }`;
const HEAD_FRAGMENT = /* glsl */ `varying vec3 vC; void main(){ float d = length(gl_PointCoord - .5); gl_FragColor = vec4(vC * smoothstep(.5, .1, d), 1.0); }`;

/** A Points object over per-point attributes (3-wide unless the name says otherwise). */
function pointsOf(count: number, attributes: Record<string, Float32Array>, material: THREE.Material): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  for (const [name, values] of Object.entries(attributes))
    geometry.setAttribute(name, new THREE.BufferAttribute(values, values.length / count));
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return points;
}

/** The dust that builds the star: it falls in along five arms so the spiral is built only by what streams in. */
function makeDust(uniforms: Record<string, THREE.IUniform>): THREE.Points {
  const random = seededRandom('bigbang');
  const grid = (width: number) => new Float32Array(DUST * width);
  const a = {
    aDir: grid(3),
    aOut: grid(3),
    aR0: grid(1),
    aDel: grid(1),
    aDur: grid(1),
    aSpd: grid(1),
    aSize: grid(1),
    aCol: grid(3),
    aJit: grid(1),
    aArm: grid(1),
    aH: grid(1),
  };
  for (let grain = 0; grain < DUST; grain += 1) {
    let direction: [number, number, number] = [1, 0, 0];
    let start: number;
    if (random() < 0.8) {
      a.aArm[grain] = Math.floor(random() * 5);
      a.aH[grain] = (random() - 0.5) * 2;
      start = 22 + random() * 12;
    } else {
      a.aArm[grain] = -1;
      const up = random() * 2 - 1;
      const around = random() * TAU;
      const ring = Math.sqrt(1 - up * up);
      direction = [ring * Math.cos(around), up, ring * Math.sin(around)];
      start = 26 + random() * 12;
    }
    a.aDir.set(direction, grain * 3);
    a.aR0[grain] = start;
    const up = random() * 2 - 1;
    const around = random() * TAU;
    const ring = Math.sqrt(1 - up * up);
    a.aOut.set([ring * Math.cos(around), up * 0.8, ring * Math.sin(around)], grain * 3);
    // Grains reach the star evenly between dustFrom and dustTo, so the share that has arrived is a straight line of time.
    const arrival = FIRST_OPEN.dustFrom + (FIRST_OPEN.dustTo - FIRST_OPEN.dustFrom) * random();
    const duration = Math.min(1.8 + random() * 1.1, arrival / 0.9);
    a.aDur[grain] = duration;
    a.aDel[grain] = arrival - 0.9 * duration;
    a.aSpd[grain] = 6 + Math.pow(random(), 1.5) * 50;
    a.aSize[grain] = 1.2 + Math.pow(random(), 3) * 3.6;
    a.aJit[grain] = random();
    const palette = random() < 0.78 ? CANDY : WARM;
    a.aCol.set(palette[Math.floor(random() * 3)]!, grain * 3);
  }
  return pointsOf(
    DUST,
    a,
    new THREE.ShaderMaterial({
      vertexShader: DUST_VERTEX,
      fragmentShader: NEBULA_FRAGMENT,
      transparent: true,
      depthWrite: false,
      uniforms,
    }),
  );
}

function makeSparkles(uniforms: Record<string, THREE.IUniform>): THREE.Points {
  const random = seededRandom('sparkles');
  const grid = (width: number) => new Float32Array(SPARKLES * width);
  const a = { aP: grid(3), aOut: grid(3), aB: grid(1), aSize: grid(1), aCol: grid(3), aPh: grid(1) };
  for (let at = 0; at < SPARKLES; at += 1) {
    const arm = Math.floor(random() * 5);
    const rho = 2 + Math.pow(random(), 1.2) * 13;
    const angle = (arm * TAU) / 5 + Math.log(rho / 1.8 + 1) * 1.6 + (random() - 0.5) * 0.9;
    a.aP.set([Math.cos(angle) * rho, (random() - 0.5) * (0.4 + rho * 0.12), Math.sin(angle) * rho], at * 3);
    const up = random() * 2 - 1;
    const around = random() * TAU;
    const ring = Math.sqrt(1 - up * up);
    a.aOut.set([ring * Math.cos(around), up, ring * Math.sin(around)], at * 3);
    // More and more sparkles appear as the bang nears.
    a.aB[at] = 1.6 + (FIRST_OPEN.bang - 0.3 - 1.6) * Math.sqrt(random());
    a.aSize[at] = 4.5 + Math.pow(random(), 2) * 8;
    a.aPh[at] = random();
    a.aCol.set(SPARKLE_COLOURS[Math.floor(random() * 3)]!, at * 3);
  }
  return pointsOf(
    SPARKLES,
    a,
    new THREE.ShaderMaterial({
      vertexShader: SPARKLE_VERTEX,
      fragmentShader: SPARKLE_FRAGMENT,
      ...additive,
      uniforms,
    }),
  );
}

/** Things we pass on the way, each placed on the path where the camera will be when it is beside them. */
interface PassBy {
  readonly along: number;
  readonly add: (world: THREE.Group, light: THREE.Vector3, ticks: ((t: number) => void)[]) => void;
}

export function createFirstOpenRenderer(surface: SpaceSurface, clock: () => number): SpaceRenderer {
  const pixelRatio = cappedPixelRatio(surface.pixelRatio);
  const renderer = new THREE.WebGLRenderer({
    canvas: surface.canvas as HTMLCanvasElement,
    context: surface.context,
    antialias: true,
    powerPreference: 'low-power',
    preserveDrawingBuffer: surface.preserveDrawingBuffer === true,
  });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(surface.width, surface.height, false);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(0x020308);
  const { context, textures } = createSceneContext([160, 420], pixelRatio);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, surface.width / surface.height, 0.1, 3000);
  const ticks: ((t: number) => void)[] = [];
  const light = new THREE.Vector3();
  const endPosition = new THREE.Vector3(...END_POSITION);

  // The sky: U01 Empty's stars, carried along with the camera so they read as infinitely far; they switch on at the bang.
  const sky = new THREE.Group();
  scene.add(sky);
  addSky(sky, 'sky', context, endPosition);
  const skyMaterials: [THREE.ShaderMaterial, number][] = [];
  sky.traverse((node) => {
    const material = (node as Partial<THREE.Points>).material as THREE.ShaderMaterial | undefined;
    if (material?.uniforms?.['opacity'] !== undefined)
      skyMaterials.push([material, material.uniforms['opacity'].value as number]);
  });

  // The big bang: dust, sparkles, the forming star, the flash and two shock rings, at the core.
  const clockUniforms = {
    T: { value: 0 },
    tBang: { value: FIRST_OPEN.bang },
    tShake: { value: FIRST_OPEN.shake },
    pr: context.pixelRatio,
  };
  const bang = new THREE.Group();
  bang.position.set(...CORE);
  scene.add(bang);
  bang.add(makeDust(clockUniforms), makeSparkles(clockUniforms));
  const star = makeSun(1.15, context);
  bang.add(star.object);
  const flash = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: context.sprites.glow,
      color: new THREE.Color(1, 0.93, 0.8),
      opacity: 1,
      ...additive,
    }),
  );
  const flashBloom = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: context.sprites.bloom,
      color: new THREE.Color(1, 0.45, 0.12),
      opacity: 0.9,
      ...additive,
    }),
  );
  bang.add(flashBloom, flash);
  const rings = [
    { colour: new THREE.Vector3(1, 0.8, 0.55), lag: 0 },
    { colour: new THREE.Vector3(...hexToUnit('#FF7AD9')), lag: 0.12 },
  ].map(({ colour, lag }) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader: WORLD_VERTEX,
        fragmentShader: RING_FRAGMENT,
        ...additive,
        uniforms: { col: { value: colour }, a: { value: 0 } },
      }),
    );
    mesh.position.set(...CORE);
    scene.add(mesh);
    return { mesh, lag };
  });

  // The newborn universe we travel through, hidden until the bang.
  const world = new THREE.Group();
  world.visible = false;
  scene.add(world);
  const rockTexture = context.trackTexture(paintPlanet(planetGenome('rock', 'barren', 'teal')).surface);
  const rockMaterial = new THREE.ShaderMaterial({
    vertexShader: WORLD_VERTEX,
    fragmentShader: PLANET_FRAGMENT,
    uniforms: {
      map: { value: rockTexture },
      sun: { value: light },
      atmo: { value: new THREE.Vector3(0.42, 0.36, 0.58) },
      cloudLayer: { value: 0 },
      ...hazeUniforms(context),
    },
  });
  const rockGeometry = new THREE.SphereGeometry(1, 20, 12);
  const belt = (along: number, count: number, seed: string, spread = 60): PassBy => ({
    along,
    add(group) {
      const random = seededRandom(seed);
      for (let rock = 0; rock < count; rock += 1) {
        const angle = random() * TAU;
        const reach = 4.5 + Math.pow(random(), 0.8) * 16;
        const mesh = new THREE.Mesh(rockGeometry, rockMaterial);
        const size = 0.5 + Math.pow(random(), 2) * 2.2;
        mesh.scale.set(size, size * (0.7 + random() * 0.3), size * (0.85 + random() * 0.25));
        mesh.position.set(
          ...pathPoint(along + (random() - 0.5) * spread, Math.cos(angle) * reach, Math.sin(angle) * reach * 1.3),
        );
        const axis = new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize();
        const speed = 0.4 + random() * 1.2;
        ticks.push((t) => mesh.setRotationFromAxisAngle(axis, t * speed));
        group.add(mesh);
      }
    },
  });
  const planet = (
    id: string,
    type: PlanetType,
    along: number,
    across: number,
    high: number,
    radius: number,
    options: { rings?: boolean; moon?: boolean } = {},
  ): PassBy => ({
    along,
    add(group, sun) {
      const built = makePlanet(planetGenome(id, type, 'teal', options), radius, sun, context);
      built.object.position.set(...pathPoint(along, across, high));
      group.add(built.object);
      ticks.push(built.tick);
    },
  });
  const galaxy = (
    family: HazeFamily,
    radius: number,
    along: number,
    across: number,
    high: number,
    tilt: [number, number, number],
  ): PassBy => ({
    along,
    add(group) {
      const galaxyGroup = new THREE.Group();
      galaxyGroup.add(makeHalo(radius, family, context, 0.75));
      const core = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: context.sprites.glow,
          color: new THREE.Color(1, 0.9, 0.8),
          opacity: 0.9,
          ...additive,
        }),
      );
      core.scale.setScalar(radius * 0.28);
      galaxyGroup.add(core);
      galaxyGroup.position.set(...pathPoint(along, across, high));
      galaxyGroup.rotation.set(...tilt);
      group.add(galaxyGroup);
    },
  });
  const system = (
    id: string,
    family: HazeFamily,
    along: number,
    across: number,
    high: number,
    sunRadius: number,
    planets: readonly { type: PlanetType; orbit: number; angle: number; rings?: boolean; moon?: boolean }[],
  ): PassBy => ({
    along,
    add(group) {
      const at = pathPoint(along, across, high);
      const built = buildSystem(
        {
          id,
          name: id,
          family,
          position: { x: at[0], z: at[2] },
          sunRadius,
          planetRadius: sunRadius * 0.45,
          speed: 0.35,
          orbitFalloff: 0.8,
          planets: planets.map((entry, order) => ({
            id: `${id}-${String(order)}`,
            name: id,
            type: entry.type,
            orbitRadius: entry.orbit,
            startAngle: entry.angle,
            ...(entry.rings === true ? { rings: true } : {}),
            ...(entry.moon === true ? { moon: true } : {}),
          })),
        },
        context,
        undefined,
      );
      built.built.object.position.y = at[1];
      group.add(built.built.object);
      ticks.push(built.built.tick);
    },
  });
  const nebula = (along: number): PassBy => ({
    along,
    add(group) {
      const cloud = makeNebula(20, 2600, 'pass-neb', context, 14);
      cloud.object.position.set(...pathPoint(along, -14, 32));
      cloud.object.rotation.x = 0.8;
      group.add(cloud.object);
      ticks.push(cloud.tick);
    },
  });
  const passes: PassBy[] = [
    belt(150, 14, 'beltA'),
    planet('pass-lush', 'lush', 290, -14, 5, 5.5, { moon: true }),
    galaxy('violet', 60, 400, 22, 62, [1.0, 0.3, 0.4]),
    planet('pass-gas', 'gas', 480, 16, -8, 6.2, { rings: true }),
    nebula(590),
    system('pass-amber', 'amber', 680, 3, -15, 3, [
      { type: 'scorched', orbit: 6.5, angle: 0.6 },
      { type: 'frozen', orbit: 10, angle: 2.4, rings: true },
      { type: 'barren', orbit: 13.5, angle: -1.2 },
    ]),
    belt(790, 12, 'beltB'),
    galaxy('teal', 70, 860, -26, 70, [1.1, 0.5, -0.3]),
    planet('pass-ocean', 'ocean', 920, 9, 10, 3.4),
    planet('pass-barren', 'barren', 1040, -11, -9, 4.5, { moon: true }),
    galaxy('cobalt', 75, 1130, -30, -80, [1.15, -0.4, -0.6]),
    system('pass-teal', 'teal', 1210, 15, 10, 2.6, [{ type: 'barren', orbit: 7.5, angle: 2.2, moon: true }]),
    belt(1310, 20, 'beltC', 80),
    galaxy('pink', 55, 1400, 18, -40, [1.2, 0.2, 0.7]),
  ];
  for (const pass of passes) pass.add(world, light, ticks);

  // Speed: stars stretch into streaks while we move; at light speed many more rush at us, then we drop out.
  const streakRandom = seededRandom('streaks');
  const streakStars = Array.from({ length: STREAKS }, (_, at) => {
    const angle = streakRandom() * TAU;
    const reach =
      at < NEAR_STREAKS ? 2.2 + Math.pow(streakRandom(), 0.65) * 42 : 3 + Math.pow(streakRandom(), 1.3) * 26;
    const tint = streakRandom();
    const brightness = 0.45 + streakRandom() * 0.55;
    const colour = (tint < 0.15 ? [1, 0.86, 0.7] : tint < 0.3 ? [0.75, 0.85, 1] : [1, 1, 1]).map(
      (value) => value * brightness,
    );
    return {
      x: Math.cos(angle) * reach,
      y: Math.sin(angle) * reach,
      z0: streakRandom() * 340,
      length: 0.5 + streakRandom() * 0.9,
      colour: colour as [number, number, number],
    };
  });
  const linePositions = new Float32Array(STREAKS * 6);
  const lineColours = new Float32Array(STREAKS * 6);
  const headPositions = new Float32Array(STREAKS * 3);
  const headColours = new Float32Array(STREAKS * 3);
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
  lineGeometry.setAttribute('color', new THREE.BufferAttribute(lineColours, 3));
  const lines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ vertexColors: true, ...additive }));
  lines.frustumCulled = false;
  const headGeometry = new THREE.BufferGeometry();
  headGeometry.setAttribute('position', new THREE.BufferAttribute(headPositions, 3));
  headGeometry.setAttribute('color', new THREE.BufferAttribute(headColours, 3));
  const heads = new THREE.Points(
    headGeometry,
    new THREE.ShaderMaterial({
      vertexShader: HEAD_VERTEX,
      fragmentShader: HEAD_FRAGMENT,
      ...additive,
      uniforms: { pr: context.pixelRatio },
    }),
  );
  heads.frustumCulled = false;
  const rush = new THREE.Group();
  rush.add(lines, heads);
  scene.add(rush);
  const forward = new THREE.Vector3(...pathPoint(1)).sub(new THREE.Vector3(...pathPoint(0))).normalize();
  rush.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), forward);

  function streaks(t: number, base: THREE.Vector3): void {
    const { bang, arrive, warp, full, exit } = FIRST_OPEN;
    rush.position.copy(base);
    const streamed = streamedAt(t);
    const velocity = streakSpeedAt(t);
    const warping = warpAt(t);
    const visible = smooth(bang + 0.1, bang + 0.85, t) * (1 - smooth(exit + 0.8, arrive - 0.2, t));
    const more = smooth(warp, full - 0.5, t);
    rush.visible = visible > 0;
    if (!rush.visible) return;
    streakStars.forEach((star, at) => {
      const z = -334 + ((star.z0 + streamed) % 340);
      const length = Math.min(160, velocity * 26 * star.length);
      const f = visible * smooth(-334, -240, z) * (at < NEAR_STREAKS ? 1 : more) * (1 + 0.25 * warping);
      const k = at * 6;
      const h = at * 3;
      linePositions[k] = linePositions[k + 3] = headPositions[h] = star.x;
      linePositions[k + 1] = linePositions[k + 4] = headPositions[h + 1] = star.y;
      linePositions[k + 2] = headPositions[h + 2] = z;
      linePositions[k + 5] = z - length;
      lineColours[k] = star.colour[0] * f;
      lineColours[k + 1] = star.colour[1] * f;
      lineColours[k + 2] = star.colour[2] * f;
      lineColours[k + 3] = lineColours[k + 4] = lineColours[k + 5] = 0;
      headColours[h] = lineColours[k] * warping;
      headColours[h + 1] = lineColours[k + 1]! * warping;
      headColours[h + 2] = lineColours[k + 2]! * warping;
    });
    lineGeometry.attributes['position']!.needsUpdate = true;
    lineGeometry.attributes['color']!.needsUpdate = true;
    headGeometry.attributes['position']!.needsUpdate = true;
    headGeometry.attributes['color']!.needsUpdate = true;
  }

  const target = new THREE.Vector3();
  const along = new THREE.Vector3();

  return {
    draw(sceneTime) {
      const T = Math.min(Math.max(clock(), 0), FIRST_OPEN.seconds);
      const frame = firstOpenFrame(T);
      context.time.value = sceneTime;
      clockUniforms.T.value = T;
      for (const tick of ticks) tick(sceneTime);
      const born = T >= FIRST_OPEN.bang;
      const pose = frame.camera;
      camera.up.set(Math.sin(pose.roll), Math.cos(pose.roll), 0);
      camera.position.set(...pose.position);
      camera.fov = pose.fov;
      camera.updateProjectionMatrix();
      camera.lookAt(target.set(...pose.target));
      // The sky and the light travel with the camera.
      sky.position.copy(camera.position).sub(endPosition);
      light.copy(camera.position).add(new THREE.Vector3(80, 60, -20));
      for (const [material, opacity] of skyMaterials) material.uniforms['opacity']!.value = opacity * frame.sky;
      world.visible = born && T < FIRST_OPEN.warp + 1.5;
      bang.visible = T < FIRST_OPEN.bang + 4;
      // The forming star: grows with the dust, floats, trembles, squeezes.
      star.object.visible = frame.star.visible;
      if (frame.star.visible) {
        const heat = frame.star.heat;
        star.object.scale.setScalar(frame.star.size * frame.star.squeeze);
        star.object.position.set(
          Math.sin(sceneTime * 0.6) * 0.22 + Math.sin(T * 41) * 0.06 * heat,
          Math.sin(sceneTime * 0.9) * 0.3 + Math.cos(T * 37) * 0.05 * heat,
          Math.cos(sceneTime * 0.5) * 0.18,
        );
        star.tick(sceneTime);
      }
      const since = T - FIRST_OPEN.bang;
      flash.visible = flashBloom.visible = since >= 0;
      if (since >= 0) {
        const open = 1 - Math.pow(1 - Math.min(1, since / 0.6), 3);
        flash.scale.setScalar(3 + 40 * open);
        flash.material.opacity = 1 - smooth(0, 0.5, since);
        flashBloom.scale.setScalar(14 + 80 * (1 - Math.pow(1 - Math.min(1, since / 0.8), 3)));
        flashBloom.material.opacity = 0.9 * (1 - smooth(0, 0.45, since));
      }
      for (const { mesh, lag } of rings) {
        const ring = shockAt(T, lag);
        mesh.visible = ring.visible;
        if (!ring.visible) continue;
        mesh.scale.setScalar(ring.scale);
        mesh.material.uniforms['a']!.value = ring.opacity;
        mesh.quaternion.copy(camera.quaternion);
      }
      streaks(T, along.set(...(born ? pathPoint(distanceAt(T)) : pose.position)));
      renderer.render(scene, camera);
      surface.present?.();
    },
    resize(width, height) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    },
    setDefinition() {},
    setCamera() {},
    setScript() {},
    setHighlight() {},
    anchors: () => [],
    isFar: () => false,
    probe: () => ({ litPixels: 0, sampledPixels: 0, signature: 0 }),
    dispose(options) {
      scene.traverse((node) => {
        const drawable = node as Partial<THREE.Mesh>;
        drawable.geometry?.dispose();
        const material = drawable.material;
        for (const entry of Array.isArray(material) ? material : material ? [material] : []) entry.dispose();
      });
      for (const texture of textures) texture.dispose();
      renderer.dispose();
      if (options?.releaseContext === true && surface.context === undefined) renderer.forceContextLoss();
    },
  };
}
