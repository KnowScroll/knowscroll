import * as THREE from 'three';

/**
 * The planet you are at, as one sphere: from orbit and on the ground it is the same drawing (Round 7.3), so going
 * down is the camera falling toward it, never a cross-fade. It wears the planet's world texture (`world-texture.ts`),
 * painted from the `worldmap.v1` globe band. The band's height is a Mercator strip (its edges near ±79°), so the shader
 * turns a point's latitude into a band row and continents keep their shape; above the band are the palette's caps.
 *
 * The light comes from the planet's real sun. Nearer the ground the night side, the rim of air and the shading fade
 * out, so the land reads as a map.
 */

/** Band units per radian of longitude: the band is 480 units round. */
const BAND_UNITS_PER_RADIAN = 480 / (2 * Math.PI);

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
    float bandY = 180.0 - K * log(tan(PI * 0.25 + lat * 0.5));
    float v = bandY / 360.0;
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
 * The point of the unit sphere that wears band point (`bandX`, `latitude`): the shader's longitude is
 * `atan(x, z)`, and band x 0 is the shader's −π (texture u 0).
 */
export function localPointOf(bandX: number, latitude: number): THREE.Vector3 {
  const longitude = (bandX / 480) * 2 * Math.PI - Math.PI;
  return new THREE.Vector3(
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude),
    Math.cos(latitude) * Math.cos(longitude),
  );
}

export interface GlobeColours {
  readonly sea: string;
  readonly cap: string;
  readonly air: string;
}

export interface Globe {
  readonly mesh: THREE.Mesh;
  /** Wears a painted world (RGBA, equirectangular over the band), or nothing while it is being painted. */
  setTexture(texture: { readonly width: number; readonly height: number; readonly data: Uint8Array } | null): void;
  setColours(colours: GlobeColours): void;
  /**
   * Where the light comes from (world direction toward the sun), how near the ground the camera is (0 in orbit, 1 on
   * the ground) and how visible the globe is (it grows out of the painted planet beneath it).
   */
  setLight(toSun: THREE.Vector3, near: number, opacity: number): void;
  dispose(): void;
}

export function createGlobe(): Globe {
  const geometry = new THREE.SphereGeometry(1, 96, 64);
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
      texture = new THREE.DataTexture(next.data, next.width, next.height, THREE.RGBAFormat);
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      // No mipmaps: the longitude wraps inside the shader, and a mip chosen across the seam would draw a line.
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
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
