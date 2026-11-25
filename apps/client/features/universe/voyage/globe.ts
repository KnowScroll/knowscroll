import * as THREE from 'three';
import { pixelTexture } from '../space/scene/context';
import { BAND_HEIGHT, BAND_UNITS_PER_RADIAN, BAND_WIDTH, type WorldTexture } from './world-texture';

/**
 * The planet you are at, as one sphere: from orbit and on the ground it is the same drawing, as the
 * design prototype's planet is, so going down is the camera falling toward it, never a cross-fade. It
 * wears the planet's world texture (`world-texture.ts`), painted from the `worldmap.v1` globe band.
 * The band is a Mercator strip (its edges near +-79 degrees), so the shader turns a point's latitude
 * into a band row and continents keep their shape; above the band are the palette's caps. A sphere
 * with a texture, rather than the prototype's canvas drawing of loops re-projected every frame, so
 * the phone paints the land once and the GPU turns it.
 *
 * The light comes from the planet's real sun, as the prototype's does. Nearer the ground the night
 * side, the rim of air and the shading fade out, so the land reads as a map (the prototype fades the
 * same three as the globe turns into the map).
 */

/** Passes the unit-sphere position (the point's own longitude and latitude), the world normal and the view direction to the fragment shader. */
const VERTEX = /* glsl */ `
  varying vec3 vLocal;
  varying vec3 vWorldNormal;
  varying vec3 vView;
  void main() {
    vLocal = normalize(position);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vView = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/**
 * Longitude is `atan(x, z)` and texture u is that turn plus a half, so band x 0 is longitude -PI;
 * `K` and the half and whole band height are the band's own size (`world-texture.ts`), and the band row
 * is the Mercator row of the latitude, the inverse of `latitudeOfBandY`. Row 0 of the painted band is
 * its north edge and a `DataTexture`'s row 0 is at v = 0, so v is not flipped.
 *
 * The shading numbers are this shader's own, not the prototype's (it has canvas gradients, no shader).
 * The day side is 1.04 of the colour and the night side 0.38, met over a sun angle of -0.25 to 0.35;
 * the rim of air is `pow(1 - n.v, 2.6)` at 0.55, which is the prototype's rim alpha at the limb
 * (`drawGlobe`, `Universe.dc.html` line 1364); the cap is met over 0.02 of v.
 */
const FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform float painted;
  uniform vec3 sea;
  uniform vec3 cap;
  uniform vec3 air;
  uniform vec3 lightDir;
  uniform float near;
  uniform float opacity;
  varying vec3 vLocal;
  varying vec3 vWorldNormal;
  varying vec3 vView;
  const float PI = 3.141592653589793;
  const float K = ${BAND_UNITS_PER_RADIAN.toFixed(6)};
  void main() {
    float lon = atan(vLocal.x, vLocal.z);
    float lat = asin(clamp(vLocal.y, -1.0, 1.0));
    float bandY = ${(BAND_HEIGHT / 2).toFixed(1)} - K * log(tan(PI * 0.25 + lat * 0.5));
    float v = bandY / ${BAND_HEIGHT.toFixed(1)};
    vec2 uv = vec2(fract(lon / (2.0 * PI) + 0.5), clamp(v, 0.0, 1.0));
    // Row 0 of the painted band is its top (north), and a DataTexture's row 0 is at v = 0: no flip.
    vec3 land = mix(sea, texture2D(map, uv).rgb, painted);
    // Above the band's edges: the palette's cap, met softly.
    float outside = smoothstep(0.0, 0.02, max(-v, v - 1.0));
    vec3 colour = mix(land, cap, outside);
    vec3 n = normalize(vWorldNormal);
    float sun = dot(n, normalize(lightDir));
    float day = smoothstep(-0.25, 0.35, sun);
    float lit = mix(0.38, 1.04, day);
    float rim = pow(1.0 - max(dot(n, normalize(vView)), 0.0), 2.6);
    vec3 shaded = colour * mix(lit, 1.0, near) + air * rim * 0.55 * (1.0 - near) * (0.35 + 0.65 * day);
    gl_FragColor = vec4(shaded, opacity);
  }
`;

/**
 * The point of the unit sphere that wears band point (`bandX`, `latitude`), so a name or a tap target
 * can be put where the land is on the sphere: the shader's longitude is `atan(x, z)`, and band x 0 is
 * the shader's -PI (texture u 0).
 */
export function localPointOf(bandX: number, latitude: number): THREE.Vector3 {
  const longitude = (bandX / BAND_WIDTH) * 2 * Math.PI - Math.PI;
  return new THREE.Vector3(
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude),
    Math.cos(latitude) * Math.cos(longitude),
  );
}

/** The three colours the planet's palette gives the globe: the open sea, the polar caps above the band, and the rim of air. */
export interface GlobeColours {
  readonly sea: string;
  readonly cap: string;
  readonly air: string;
}

/** The planet sphere and what the voyage changes on it as the camera moves. */
export interface Globe {
  readonly mesh: THREE.Mesh;
  /**
   * Wears a painted world (RGBA, as `createWorldPainter` paints it: x is longitude, y is the band row),
   * or nothing while it is being painted: the sea colour shows until the texture is ready. Frees the
   * texture it wore before.
   */
  setTexture(texture: WorldTexture | null): void;
  /** Sets the sea, cap and air colours of the planet being shown. */
  setColours(colours: GlobeColours): void;
  /**
   * Where the light comes from (world direction toward the sun), how near the ground the camera is (0 in orbit, 1 on
   * the ground) and how visible the globe is (it grows out of the painted planet beneath it).
   */
  setLight(toSun: THREE.Vector3, near: number, opacity: number): void;
  /** Frees the sphere, its material and the texture it wears. */
  dispose(): void;
}

/** How finely the sphere is cut, round and from pole to pole. */
const SPHERE_WIDTH_SEGMENTS = 96;
const SPHERE_HEIGHT_SEGMENTS = 64;

/**
 * Makes the planet sphere, hidden until the voyage shows it. It starts with the prototype's lush
 * palette's flat-sea first stop (`#1d7d97`) and `atmo` (`#83f2ea`), a pale cap, and the prototype's
 * default light direction `[-0.45, -0.55, 0.7]` with y up; `setColours` and `setLight` replace them.
 */
export function createGlobe(): Globe {
  const geometry = new THREE.SphereGeometry(1, SPHERE_WIDTH_SEGMENTS, SPHERE_HEIGHT_SEGMENTS);
  const uniforms = {
    map: { value: null as THREE.DataTexture | null },
    painted: { value: 0 },
    sea: { value: new THREE.Color('#1d7d97') },
    cap: { value: new THREE.Color('#eef6f8') },
    air: { value: new THREE.Color('#83f2ea') },
    lightDir: { value: new THREE.Vector3(-0.45, 0.55, 0.7) },
    near: { value: 0 },
    opacity: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.visible = false;
  let texture: THREE.DataTexture | null = null;
  return {
    mesh,
    setTexture(next) {
      texture?.dispose();
      texture = null;
      uniforms.painted.value = 0;
      uniforms.map.value = null;
      if (next === null) return;
      // Repeat across, clamped up and down, linear, and no mipmaps (a `DataTexture` has none): the longitude
      // wraps inside the shader, and a mip chosen across the seam would draw a line.
      texture = pixelTexture(next);
      uniforms.map.value = texture;
      uniforms.painted.value = 1;
    },
    setColours(colours) {
      uniforms.sea.value.set(colours.sea);
      uniforms.cap.value.set(colours.cap);
      uniforms.air.value.set(colours.air);
    },
    setLight(toSun, near, opacity) {
      uniforms.lightDir.value.copy(toSun).normalize();
      uniforms.near.value = near;
      uniforms.opacity.value = opacity;
    },
    dispose() {
      texture?.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
