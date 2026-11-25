import * as THREE from 'three';
import { pixelTexture } from '../space/scene/context';
import {
  BAND_HEIGHT,
  BAND_UNITS_PER_RADIAN,
  BAND_WIDTH,
  type BandWindow,
  type WorldLook,
  type WorldTexture,
} from './world-texture';

/**
 * The planet you are at, as one sphere: from orbit and on the ground it is the same drawing, as the
 * design prototype's planet is, so going down is the camera falling toward it, never a cross-fade. It
 * wears the planet's world texture (`world-texture.ts`), painted from the `worldmap.v1` globe band.
 * The band is a Mercator strip (its edges near +-79 degrees), so the shader turns a point's latitude
 * into a band row and continents keep their shape; above the band are the palette's caps where it has
 * them, and its sea where it has none. A sphere with a texture, rather than the prototype's canvas
 * drawing of loops re-projected every frame, so the phone paints the land once and the GPU turns it.
 *
 * The sea is not in the texture (those pixels are transparent): the shader lays it under the land, as
 * the prototype does, one way from orbit and another on the ground. From orbit it is the ball, a radial
 * gradient of the palette's four `sea` stops centred toward the light with a radius of 1.5 of the
 * planet's (`drawGlobe`, `Universe.dc.html` line 1307). On the ground it is the flat sea, a gradient of
 * the palette's two `flatSea` stops down the whole screen (line 1308), which is why the globe measures
 * the screen. `near` (0 in orbit, 1 on the ground) mixes the two, as the prototype's `flat` does.
 *
 * The light comes from the planet's real sun, as the prototype's does, and is the prototype's: a soft
 * white highlight toward the light, a dark blue limb and a rim of air (lines 1363 to 1365), laid over the
 * land with `mix`, so nothing goes above its own colour and whites do not clip. Beyond the disc is a halo
 * of air (line 1306). Nearer the ground the night side, the rim and the halo fade out, so the land reads
 * as a map (the prototype fades the same ones as the globe turns into the map).
 *
 * Over the ground the landing faces is the patch, a second texture of just a window of the band (`world-texture.ts`,
 * `groundPatchOf`): the same drawing, painted dense enough to be crisp through the ground's lens. The shader wears it
 * where the surface falls inside its window and the whole-band texture elsewhere, and cross-fades the two over
 * `PATCH_SOFT_EDGE` band units inside the window's edge so no seam shows. Both are premultiplied, so the blend is a
 * plain `mix`.
 *
 * Colours reach the shader as the palette's own numbers (hex over 255, in `Vector3`s): the renderer
 * outputs linear sRGB and does no conversion, so a `THREE.Color` (which turns hex into linear) would
 * come out darker than the palette.
 */

/** The patch comes in from this far down (`near`, 0 in orbit, 1 on the ground) and is whole on the ground. */
const PATCH_FROM_NEAR = 0.5;
/** The patch gives way to the whole-band texture over this many band units inside its window's edge (about 70 points on the ground). */
const PATCH_SOFT_EDGE = 10;
/** The halo of air reaches this many planet radii (the prototype's `R * 1.34`). */
const HALO_RADIUS = 1.34;

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
 * The texture is premultiplied, so the colour is `texture + sea * (1 - alpha)`, and a coast sampled
 * between sea and land mixes without a fringe. `nv` and `lv` are the normal and the light in view
 * space (x right, y up), so `nv.xy` is the point's place on the disc in planet radii, the prototype's
 * screen offset over `R`; the rim reads the angle to the eye instead, which is exactly 1 at the limb
 * under perspective. The prototype's light gradients are in screen space and its default light is
 * `[-0.45, -0.55, 0.7]` with y down; here y is up. No identifier here is a GLSL ES 3.00 reserved word
 * (`flat`, `smooth`, `sample`, `half`).
 */
const FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform float painted;
  uniform sampler2D patchMap;
  uniform vec4 patchBox;
  uniform float patchOn;
  uniform vec3 seaLit;
  uniform vec3 seaMid;
  uniform vec3 seaDeep;
  uniform vec3 seaDark;
  uniform vec3 groundTop;
  uniform vec3 groundBottom;
  uniform vec2 resolution;
  uniform vec3 cap;
  uniform float capOn;
  uniform vec3 rim;
  uniform vec3 lightDir;
  uniform float near;
  uniform float opacity;
  varying vec3 vLocal;
  varying vec3 vWorldNormal;
  varying vec3 vView;
  const float PI = 3.141592653589793;
  const float K = ${BAND_UNITS_PER_RADIAN.toFixed(6)};
  const vec3 NIGHT = vec3(3.0, 10.0, 40.0) / 255.0;
  // The prototype's ball gradient: its four stops at 0, 0.35, 0.72 and 1 of the radius.
  vec3 ball(float t) {
    t = clamp(t, 0.0, 1.0);
    if (t < 0.35) return mix(seaLit, seaMid, t / 0.35);
    if (t < 0.72) return mix(seaMid, seaDeep, (t - 0.35) / 0.37);
    return mix(seaDeep, seaDark, (t - 0.72) / 0.28);
  }
  void main() {
    float lon = atan(vLocal.x, vLocal.z);
    float lat = asin(clamp(vLocal.y, -1.0, 1.0));
    float bandY = ${(BAND_HEIGHT / 2).toFixed(1)} - K * log(tan(PI * 0.25 + lat * 0.5));
    float v = bandY / ${BAND_HEIGHT.toFixed(1)};
    vec2 uv = vec2(fract(lon / (2.0 * PI) + 0.5), clamp(v, 0.0, 1.0));
    vec3 n = normalize(vWorldNormal);
    vec3 nv = normalize(mat3(viewMatrix) * n);
    vec3 lv = normalize(mat3(viewMatrix) * normalize(lightDir));
    // The sea: the ball from orbit, the flat gradient down the screen on the ground.
    float ballAt = length(nv.xy - lv.xy * 0.34) / 1.5;
    float fromTop = clamp(1.0 - gl_FragCoord.y / max(resolution.y, 1.0), 0.0, 1.0);
    vec3 sea = mix(ball(ballAt), mix(groundTop, groundBottom, fromTop), near);
    // Row 0 of the painted band is its top (north), and a DataTexture's row 0 is at v = 0: no flip.
    vec4 land = texture2D(map, uv);
    // The ground patch over the whole-band texture: its window is patchBox (left, top, width, height in band units, the
    // left edge wrapping round the seam), met softly inside its edge. Row 0 of the patch is its top, as the band's.
    vec2 inPatch = vec2(mod(uv.x * ${BAND_WIDTH.toFixed(1)} - patchBox.x, ${BAND_WIDTH.toFixed(1)}), bandY - patchBox.y);
    float fromEdge = min(min(inPatch.x, patchBox.z - inPatch.x), min(inPatch.y, patchBox.w - inPatch.y));
    // Its lines are drawn for the ground's scale: from orbit they would be too fine and would shimmer, so the patch
    // comes in only as the camera nears the ground.
    float patchShown = patchOn * smoothstep(0.0, ${PATCH_SOFT_EDGE.toFixed(1)}, fromEdge) * smoothstep(${PATCH_FROM_NEAR.toFixed(1)}, 1.0, near);
    land = mix(land, texture2D(patchMap, clamp(inPatch / patchBox.zw, 0.0, 1.0)), patchShown) * painted;
    // Above the band's edges: no land, and the palette's cap where it has one, met softly.
    float outside = smoothstep(0.0, 0.02, max(-v, v - 1.0));
    land *= 1.0 - outside;
    vec3 colour = land.rgb + sea * (1.0 - land.a);
    colour = mix(colour, cap, outside * capOn);
    // The light, last, and gone on the ground: rim of air, the white highlight, the dark blue limb.
    float away = 1.0 - near;
    float limb = sqrt(max(1.0 - pow(max(dot(n, normalize(vView)), 0.0), 2.0), 0.0));
    colour = mix(colour, rim, 0.55 * clamp((limb - 0.86) / 0.14, 0.0, 1.0) * away);
    float back = max(0.0, -lv.z);
    float fromLight = length(nv.xy - lv.xy * (0.5 + 0.5 * back)) / 1.8;
    colour = mix(colour, vec3(1.0), 0.24 * (1.0 - clamp(fromLight / 0.36, 0.0, 1.0)) * away);
    float nightFrom = 0.52 - 0.14 * back;
    colour = mix(colour, NIGHT, (0.62 + 0.26 * back) * clamp((fromLight - nightFrom) / (1.0 - nightFrom), 0.0, 1.0) * away);
    gl_FragColor = vec4(colour, opacity);
  }
`;

/**
 * The halo is a square that always faces the camera, centred on the planet and sized by how large the
 * planet's disc looks (the radius of its silhouette, which perspective makes a little more than the
 * planet's own). `vQuad` is the place on the square in disc radii.
 */
const HALO_VERTEX = /* glsl */ `
  varying vec2 vQuad;
  void main() {
    vec4 centre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float radius = length(modelMatrix[0].xyz);
    float distanceToEye = length(centre.xyz);
    float disc = radius / sqrt(max(1.0 - radius * radius / (distanceToEye * distanceToEye), 0.01));
    vQuad = position.xy * ${HALO_RADIUS.toFixed(2)};
    centre.xy += position.xy * ${HALO_RADIUS.toFixed(2)} * disc;
    gl_Position = projectionMatrix * centre;
  }
`;

/**
 * The prototype's halo (`glow(cx, cy, R * 1.34, [[0.72, atmo 0.36], [1, atmo 0]])`): the atmosphere
 * colour at 0.36 from 0.72 of the way out to 1.34 R, to nothing at 1.34 R, so about 0.965 R to 1.34 R.
 * Only outside the disc (the ball is drawn over the rest of it), and gone on the ground.
 */
const HALO_FRAGMENT = /* glsl */ `
  uniform vec3 halo;
  uniform float near;
  uniform float opacity;
  varying vec2 vQuad;
  void main() {
    float r = length(vQuad);
    float reach = 1.0 - clamp((r - ${(HALO_RADIUS * 0.72).toFixed(4)}) / ${(HALO_RADIUS * 0.28).toFixed(4)}, 0.0, 1.0);
    float alpha = 0.36 * reach * smoothstep(0.995, 1.01, r) * (1.0 - near) * opacity;
    gl_FragColor = vec4(halo, alpha);
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

/** The three colours the planet's palette gives the globe, as the painter's caller knows them before a texture is ready. */
export interface GlobeColours {
  /** The sea before the texture is ready: the ball and the ground are all this colour. */
  readonly sea: string;
  /** The polar caps above the band's edges, for a texture that does not say. */
  readonly cap: string;
  /** The halo and the rim of air. */
  readonly air: string;
  /**
   * The palette's whole look (`worldLookOf(palette)`), to show the planet's real sea before its texture is
   * ready. Optional: a finished texture carries its own look, which wins, and without either the globe makes
   * do with the three colours above.
   */
  readonly look?: WorldLook;
}

/** The planet sphere and what the voyage changes on it as the camera moves. */
export interface Globe {
  /** The sphere. It has one child, the halo of air, which faces the camera and is shown and hidden with it. */
  readonly mesh: THREE.Mesh;
  /**
   * Wears a painted world (premultiplied RGBA, as `createWorldPainter` paints it: x is longitude, y is the band
   * row), or nothing while it is being painted: the sea colour shows until the texture is ready. The sea, caps,
   * halo and rim take the colours of the texture's `look` when it has one. Frees the texture it wore before.
   */
  setTexture(texture: WorldTexture | null): void;
  /**
   * Wears a painted patch (premultiplied RGBA, painted by `createWorldPainter` with a `patch`) over the window of the
   * band it covers, or nothing. Frees the patch it wore before. It is worn only over the texture: with none worn the
   * patch shows no land, so a caller sets the texture first.
   */
  setPatch(texture: WorldTexture | null, window: BandWindow | null): void;
  /** Sets the sea, cap and air colours of the planet being shown (and, optionally, its whole look). */
  setColours(colours: GlobeColours): void;
  /**
   * Where the light comes from (world direction toward the sun), how near the ground the camera is (0 in orbit, 1 on
   * the ground) and how visible the globe is (it grows out of the painted planet beneath it). The halo takes the
   * same opacity, and fades out as the ground comes near.
   */
  setLight(toSun: THREE.Vector3, near: number, opacity: number): void;
  /**
   * Tells the globe how big the screen is, in drawing-buffer pixels, which the flat sea of the ground is
   * laid over. The globe asks the renderer itself before each draw, so a caller need not call this; it is for a
   * draw that does not go through `onBeforeRender`.
   */
  setScreen(widthPx: number, heightPx: number): void;
  /** Frees the sphere, its halo, their materials and the texture it wears. */
  dispose(): void;
}

/** How finely the sphere is cut, round and from pole to pole. */
const SPHERE_WIDTH_SEGMENTS = 96;
const SPHERE_HEIGHT_SEGMENTS = 64;

/** A `#rrggbb` colour into a vector of its channels over 255: the palette's own numbers, with no colour management. */
function setChannels(target: THREE.Vector3, hex: string): void {
  target.set(
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  );
}

/**
 * Makes the planet sphere, hidden until the voyage shows it. It starts with the prototype's lush
 * palette's flat-sea first stop (`#1d7d97`) and `atmo` (`#83f2ea`), a pale cap, and the prototype's
 * default light direction `[-0.45, -0.55, 0.7]` with y up; `setColours` and `setLight` replace them.
 */
export function createGlobe(): Globe {
  const geometry = new THREE.SphereGeometry(1, SPHERE_WIDTH_SEGMENTS, SPHERE_HEIGHT_SEGMENTS);
  const near = { value: 0 };
  const opacity = { value: 1 };
  const halo = { value: new THREE.Vector3() };
  const uniforms = {
    map: { value: null as THREE.DataTexture | null },
    painted: { value: 0 },
    patchMap: { value: null as THREE.DataTexture | null },
    patchBox: { value: new THREE.Vector4(0, 0, 1, 1) },
    patchOn: { value: 0 },
    seaLit: { value: new THREE.Vector3() },
    seaMid: { value: new THREE.Vector3() },
    seaDeep: { value: new THREE.Vector3() },
    seaDark: { value: new THREE.Vector3() },
    groundTop: { value: new THREE.Vector3() },
    groundBottom: { value: new THREE.Vector3() },
    resolution: { value: new THREE.Vector2(1, 1) },
    cap: { value: new THREE.Vector3() },
    capOn: { value: 0 },
    rim: { value: new THREE.Vector3() },
    lightDir: { value: new THREE.Vector3(-0.45, 0.55, 0.7) },
    near,
    opacity,
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.visible = false;
  // The flat sea is laid over the screen, so the shader needs its size: ask the renderer as the globe is drawn.
  mesh.onBeforeRender = (renderer) => renderer.getDrawingBufferSize(uniforms.resolution.value);

  const haloGeometry = new THREE.PlaneGeometry(2, 2);
  const haloMaterial = new THREE.ShaderMaterial({
    uniforms: { halo, near, opacity },
    vertexShader: HALO_VERTEX,
    fragmentShader: HALO_FRAGMENT,
    transparent: true,
    depthWrite: false,
  });
  const haloMesh = new THREE.Mesh(haloGeometry, haloMaterial);
  // Its square is made in its vertex shader, so its own bounds mean nothing.
  haloMesh.frustumCulled = false;
  mesh.add(haloMesh);

  let texture: THREE.DataTexture | null = null;
  let patchTexture: THREE.DataTexture | null = null;
  let worn: WorldTexture | null = null;
  let colours: GlobeColours = { sea: '#1d7d97', cap: '#eef6f8', air: '#83f2ea' };

  /** Puts the colours in the shader: the look of the texture it wears, else the look it was given, else its three colours. */
  const colour = () => {
    const look = worn?.look ?? colours.look;
    if (look !== undefined) {
      setChannels(uniforms.seaLit.value, look.ball[0]);
      setChannels(uniforms.seaMid.value, look.ball[1]);
      setChannels(uniforms.seaDeep.value, look.ball[2]);
      setChannels(uniforms.seaDark.value, look.ball[3]);
      setChannels(uniforms.groundTop.value, look.flatSea[0]);
      setChannels(uniforms.groundBottom.value, look.flatSea[1]);
      setChannels(halo.value, look.atmosphere);
      setChannels(uniforms.rim.value, look.rim);
      setChannels(uniforms.cap.value, look.cap ?? colours.cap);
      uniforms.capOn.value = look.cap === null ? 0 : 1;
      return;
    }
    for (const stop of [uniforms.seaLit, uniforms.seaMid, uniforms.seaDeep, uniforms.seaDark])
      setChannels(stop.value, colours.sea);
    setChannels(uniforms.groundTop.value, colours.sea);
    setChannels(uniforms.groundBottom.value, colours.sea);
    setChannels(halo.value, colours.air);
    setChannels(uniforms.rim.value, colours.air);
    setChannels(uniforms.cap.value, colours.cap);
    // A texture that does not say keeps its caps, as before; with none worn there is no land to cap.
    uniforms.capOn.value = worn === null ? 0 : 1;
  };
  colour();

  return {
    mesh,
    setTexture(next) {
      texture?.dispose();
      texture = null;
      worn = null;
      uniforms.painted.value = 0;
      uniforms.map.value = null;
      if (next !== null) {
        // Repeat across, clamped up and down, linear, and no mipmaps (a `DataTexture` has none): the longitude
        // wraps inside the shader, and a mip chosen across the seam would draw a line.
        texture = pixelTexture(next);
        worn = next;
        uniforms.map.value = texture;
        uniforms.painted.value = 1;
      }
      colour();
    },
    setPatch(next, window) {
      patchTexture?.dispose();
      patchTexture = null;
      uniforms.patchMap.value = null;
      uniforms.patchOn.value = 0;
      if (next !== null && window !== null) {
        // Clamped both ways: the window is a rectangle, and the shader fades out before its edge.
        patchTexture = pixelTexture(next);
        patchTexture.wrapS = THREE.ClampToEdgeWrapping;
        patchTexture.wrapT = THREE.ClampToEdgeWrapping;
        uniforms.patchMap.value = patchTexture;
        // Left edge into 0..BAND_WIDTH: the shader's own column wraps the same way.
        uniforms.patchBox.value.set(
          ((window.x % BAND_WIDTH) + BAND_WIDTH) % BAND_WIDTH,
          window.y,
          window.width,
          window.height,
        );
        uniforms.patchOn.value = 1;
      }
    },
    setColours(next) {
      colours = next;
      colour();
    },
    setLight(toSun, nearGround, visible) {
      uniforms.lightDir.value.copy(toSun).normalize();
      near.value = nearGround;
      opacity.value = visible;
      haloMesh.visible = visible > 0.01 && nearGround < 0.999;
    },
    setScreen(widthPx, heightPx) {
      uniforms.resolution.value.set(widthPx, heightPx);
    },
    dispose() {
      texture?.dispose();
      patchTexture?.dispose();
      geometry.dispose();
      material.dispose();
      haloGeometry.dispose();
      haloMaterial.dispose();
    },
  };
}
