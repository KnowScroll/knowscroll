/**
 * The GLSL of the space views, from the v2.1 "Space views" design (`new-universe.html`) minus the
 * dashed route line the design has dropped. three.js adds the version line, the precision
 * statements and the built-in uniforms (`modelMatrix`, `viewMatrix`, `cameraPosition`, ...).
 */

/** Haze: far things melt into the sky colour, and a quiet ("calm") system goes grey. */
const HAZE = /* glsl */ `uniform vec3 fogCol; uniform vec2 fogR; uniform float calm;
vec3 haze(vec3 col, vec3 w){ float g = dot(col, vec3(.3,.59,.11)); col = mix(col, vec3(g) * .7, calm * .85); float f = smoothstep(fogR.x, fogR.y, length(cameraPosition - w)); return mix(col, fogCol, f * .6); }`;

export const WORLD_VERTEX = /* glsl */ `varying vec2 vUv; varying vec3 vN; varying vec3 vW;
void main(){ vUv = uv; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;

/** Soft day side, coloured night side, warm twilight band, broad atmosphere rim. */
export const PLANET_FRAGMENT = /* glsl */ `uniform sampler2D map; uniform vec3 sun; uniform vec3 atmo; uniform float cloudLayer;
varying vec2 vUv; varying vec3 vN; varying vec3 vW; ${HAZE}
void main(){
  vec3 N = normalize(vN), L = normalize(sun - vW), V = normalize(cameraPosition - vW);
  vec4 tx = texture2D(map, vUv); vec3 base = cloudLayer > .5 ? vec3(1.0) : tx.rgb;
  float nd = dot(N, L), lit = smoothstep(-.14, .06, nd) * .58 + smoothstep(.34, .5, nd) * .42;
  vec3 col = mix(base * vec3(.2, .18, .42), base * vec3(1.06, 1.0, .94), lit);
  col += vec3(1.0, .45, .28) * exp(-pow((nd - .02) / .17, 2.0)) * .26;
  float fr = pow(1.0 - max(dot(N, V), 0.0), 2.0);
  col = mix(col, atmo, fr * smoothstep(-.35, .45, nd) * .8);
  col += atmo * fr * fr * .3 * (1.0 - lit);
  col += vec3(1.0) * smoothstep(.962, .975, dot(N, normalize(L + V))) * (cloudLayer > .5 ? 0.0 : .32);
  gl_FragColor = vec4(haze(col, vW), cloudLayer > .5 ? tx.a * (.3 + .7 * lit) : 1.0);
}`;

export const ATMOSPHERE_FRAGMENT = /* glsl */ `uniform vec3 color; uniform vec3 sun; uniform float strength; uniform float calm; uniform vec3 fogCol; uniform vec2 fogR; varying vec3 vN; varying vec3 vW;
void main(){ vec3 N = normalize(vN), V = normalize(cameraPosition - vW); float x = 1.0 - max(dot(N, V), 0.0);
  float g = smoothstep(.02, .32, x) * (1.0 - smoothstep(.32, 1.0, x)); float s = .3 + .7 * smoothstep(-.5, .6, dot(N, normalize(sun - vW)));
  float f = 1.0 - smoothstep(fogR.x, fogR.y, length(cameraPosition - vW)) * .6;
  gl_FragColor = vec4(color * g * s * strength * (1.0 - calm * .9) * f, 1.0); }`;

/** The sun is always orange; the haze family colours only the halo around it. */
export const SUN_FRAGMENT = /* glsl */ `varying vec2 vUv; varying vec3 vN; varying vec3 vW; ${HAZE}
void main(){ vec3 N = normalize(vN), V = normalize(cameraPosition - vW); float nv = max(dot(N, V), 0.0);
  vec3 col = mix(vec3(1.0, .42, .08), vec3(1.0, .7, .3), smoothstep(0.0, .5, nv)); col = mix(col, vec3(1.0, .93, .78), smoothstep(.55, .95, nv));
  gl_FragColor = vec4(haze(col * 1.08, vW), 1.0); }`;

/** The coloured haze around a sun, with two slow spiral arms. */
export const HALO_FRAGMENT = /* glsl */ `uniform vec3 c1; uniform vec3 c2; uniform float strength; uniform float calm; uniform float time; varying vec2 vUv;
void main(){ vec2 p = vUv * 2.0 - 1.0; float r = length(p); if (r > 1.0) discard; float a = atan(p.y, p.x);
  float arms = .5 + .5 * cos(2.0 * (a + log(r + .05) * 2.2) - time * .15);
  float i = pow(1.0 - r, 2.2) * (.55 + .45 * arms * smoothstep(.1, .6, r));
  vec3 col = mix(c1, c2, smoothstep(.1, .9, r)); float g = dot(col, vec3(.3,.59,.11)); col = mix(col, vec3(g) * .5, calm);
  gl_FragColor = vec4(col * i * strength * (1.0 - calm * .7), 1.0); }`;

export const RING_VERTEX = /* glsl */ `varying vec3 vW; varying vec2 vL; void main(){ vL = position.xy; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;

export const RING_FRAGMENT = /* glsl */ `uniform sampler2D map; uniform vec3 sun; uniform vec3 pc; uniform float pr; uniform float rIn; uniform float rOut; uniform float opacity; varying vec3 vW; varying vec2 vL; ${HAZE}
void main(){ float u = (length(vL) - rIn) / (rOut - rIn); if (u < 0.0 || u > 1.0) discard; vec4 t = texture2D(map, vec2(u, .5));
  vec3 L = normalize(sun - vW), oc = vW - pc; float b = dot(oc, L), c = dot(oc, oc) - pr * pr; float sh = (b * b - c > 0.0 && b < 0.0) ? 1.0 : 0.0;
  gl_FragColor = vec4(haze(t.rgb * mix(vec3(1.05, 1.0, .95), vec3(.2, .18, .42), sh * .85), vW), t.a * opacity); }`;

/** Background stars: three shells that drift against each other, plus a few near motes. */
export const STAR_VERTEX = /* glsl */ `attribute float aSize; attribute vec3 aCol; attribute float aPh; uniform float time; uniform float pr; uniform float atten; uniform float wob;
varying vec3 vC; varying float vA;
void main(){ vec3 p = position + wob * vec3(sin(time * .13 + aPh * 9.0), cos(time * .11 + aPh * 7.0) * .6, sin(time * .09 + aPh * 5.0) * .4);
  vec4 mv = modelViewMatrix * vec4(p, 1.0); vC = aCol; vA = .72 + .28 * sin(time * (.4 + aPh * 1.4) + aPh * 6.2831);
  float s = aSize * pr; if (atten > 0.0) s *= atten / -mv.z; gl_PointSize = s; gl_Position = projectionMatrix * mv; }`;

export const STAR_FRAGMENT = /* glsl */ `uniform float opacity; varying vec3 vC; varying float vA; void main(){ float d = length(gl_PointCoord - .5); float a = pow(smoothstep(.5, 0.0, d), 1.6); gl_FragColor = vec4(vC * a * vA * opacity * 1.35, 1.0); }`;

/** Cartoon nebula: crisp candy dots with a shine, spiralling inward along arms. */
export const NEBULA_VERTEX = /* glsl */ `attribute float aRho; attribute float aArm; attribute float aJit; attribute float aSize; attribute float aH; attribute vec3 aCol;
uniform float time; uniform float R; uniform float pr; uniform float arms; varying vec3 vC; varying float vA;
void main(){ float rho = .05 + .95 * fract(aRho - time * .016); float a = aArm * 6.28318 / arms + log(rho / .05) * 1.25 + time * .2 + aJit;
  vec3 p = vec3(cos(a) * rho * R, aH * R * (.2 + rho * .6), sin(a) * rho * R); vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vC = mix(vec3(1.0, .96, .86), aCol, smoothstep(.04, .32, rho)); vA = smoothstep(1.0, .86, rho) * smoothstep(.05, .1, rho);
  gl_PointSize = aSize * pr * (24.0 / -mv.z) * (.85 + .15 * sin(time * 3.0 + aJit * 30.0)); gl_Position = projectionMatrix * mv; }`;

export const NEBULA_FRAGMENT = /* glsl */ `varying vec3 vC; varying float vA;
void main(){ float d = length(gl_PointCoord - .5); if (d > .5) discard; float a = smoothstep(.5, .36, d);
  vec3 c = mix(vC, vec3(1.0), smoothstep(.2, 0.0, length(gl_PointCoord - vec2(.38, .36))) * .55); gl_FragColor = vec4(c, a * vA); }`;
