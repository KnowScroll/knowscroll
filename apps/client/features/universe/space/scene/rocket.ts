import * as THREE from 'three';
import { additive, hazeUniforms, type SceneContext } from './context';
import { PLANET_FRAGMENT, WORLD_VERTEX } from './shaders';

/**
 * The little rocket of "Enter a system" (design, 29 Oct): a small cartoon ship lit like the worlds, with a
 * short flame. White body, orange nose, band and fins, a blue window with a cream rim, a grey nozzle.
 * About one unit long, drawn at the size the animation asks for. It is a mark, never a person.
 */

export interface RocketPose {
  readonly position: readonly [number, number, number];
  /** Where the nose points. */
  readonly direction: readonly [number, number, number];
  /** Length in scene units. */
  readonly size: number;
  /** Engine strength, 0 to 1. */
  readonly heat: number;
  readonly visible: boolean;
}

export interface Rocket {
  readonly object: THREE.Group;
  /** Poses the rocket for one frame at scene time `t`. */
  readonly set: (pose: RocketPose, t: number) => void;
}

function paint(hex: string, context: SceneContext, light: THREE.Vector3): THREE.ShaderMaterial {
  const colour = new THREE.Color(hex);
  const swatch = context.trackTexture({
    data: new Uint8Array([colour.r * 255, colour.g * 255, colour.b * 255, 255].map(Math.round)),
    width: 1,
    height: 1,
  });
  return new THREE.ShaderMaterial({
    vertexShader: WORLD_VERTEX,
    fragmentShader: PLANET_FRAGMENT,
    uniforms: {
      map: { value: swatch },
      sun: { value: light },
      atmo: { value: new THREE.Vector3(0.4, 0.5, 0.8) },
      cloudLayer: { value: 0 },
      ...hazeUniforms(context),
    },
  });
}

const WHITE = '#FAF8F0';
const ORANGE = '#FF8A3D';
const BLUE = '#3D8BEA';
const CREAM = '#EDE6D6';
const NOZZLE = '#566962';

function flame(radius: number, length: number, from: THREE.Color, to: THREE.Color): THREE.Mesh {
  const geometry = new THREE.ConeGeometry(radius, length, 20, 1, true);
  // The cone's tip points up; turned over and moved down, its base is at the nozzle and its tip trails below.
  geometry.rotateX(Math.PI);
  geometry.translate(0, -length / 2, 0);
  return new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      ...additive,
      side: THREE.DoubleSide,
      uniforms: { c0: { value: from }, c1: { value: to }, strength: { value: 1 } },
      vertexShader: /* glsl */ `varying float vU; void main(){ vU = clamp(-position.y / ${length.toFixed(4)}, 0.0, 1.0); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `uniform vec3 c0; uniform vec3 c1; uniform float strength; varying float vU;
void main(){ vec3 col = mix(c0, c1, smoothstep(0.0, 0.8, vU)); gl_FragColor = vec4(col * pow(1.0 - vU, 1.1) * strength * 1.6, 1.0); }`,
    }),
  );
}

/** Builds the rocket, hidden, with its light at `light` (up and to the left of the camera, so it always reads). */
export function makeRocket(context: SceneContext, light: THREE.Vector3): Rocket {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const lathe = (points: readonly [number, number][]) =>
    new THREE.LatheGeometry(
      points.map(([x, y]) => new THREE.Vector2(x, y)),
      28,
    );
  body.add(
    new THREE.Mesh(
      lathe([
        [0, -0.38],
        [0.16, -0.3],
        [0.2, -0.05],
        [0.17, 0.22],
        [0.07, 0.36],
        [0, 0.4],
      ]),
      paint(WHITE, context, light),
    ),
  );
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.115, 0.22, 24), paint(ORANGE, context, light));
  nose.position.y = 0.4;
  body.add(nose);
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.03, 10, 28), paint(ORANGE, context, light));
  band.rotation.x = Math.PI / 2;
  band.position.y = -0.1;
  body.add(band);
  for (let fin = 0; fin < 3; fin += 1) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.22, 0.17), paint(ORANGE, context, light));
    const angle = (fin * Math.PI * 2) / 3;
    mesh.position.set(Math.cos(angle) * 0.2, -0.27, Math.sin(angle) * 0.2);
    mesh.rotation.y = -angle;
    body.add(mesh);
  }
  const window = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), paint(BLUE, context, light));
  window.position.set(0, 0.14, 0.17);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.02, 8, 20), paint(CREAM, context, light));
  rim.position.copy(window.position);
  body.add(window, rim);
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.07, 18), paint(NOZZLE, context, light));
  nozzle.position.y = -0.42;
  body.add(nozzle);
  // Two short cones out of the nozzle, no trail: an outer flame orange to pink, a hot core white to yellow.
  const outer = flame(0.1, 0.72, new THREE.Color(1, 0.55, 0.15), new THREE.Color(1, 0.6, 0.75));
  const core = flame(0.062, 0.4, new THREE.Color(1, 1, 1), new THREE.Color(1, 0.85, 0.3));
  for (const part of [outer, core]) part.position.y = -0.45;
  body.add(outer, core);
  group.visible = false;

  const up = new THREE.Vector3(0, 1, 0);
  const aim = new THREE.Vector3();
  return {
    object: group,
    set(pose, t) {
      group.visible = pose.visible;
      if (!pose.visible) return;
      group.position.set(...pose.position);
      aim.set(...pose.direction).normalize();
      group.quaternion.setFromUnitVectors(up, aim);
      group.scale.setScalar(Math.max(pose.size, 1e-4));
      // A calm flicker (about 3.5 per cent); the flame grows with thrust.
      const flicker = 1 + 0.035 * Math.sin(t * 13) + 0.015 * Math.sin(t * 21);
      for (const [part, length] of [
        [outer, 1],
        [core, 1],
      ] as const) {
        part.scale.set(flicker, Math.max(pose.heat, 0.05) * flicker * length, flicker);
        (part.material as THREE.ShaderMaterial).uniforms['strength']!.value = pose.heat;
      }
    },
  };
}
