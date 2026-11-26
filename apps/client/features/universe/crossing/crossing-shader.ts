import { cappedPixelRatio } from '../space/frame-clock';

/**
 * The crossing's one fragment shader, ported from the Round 7.3 prototype (`Universe.dc.html`, `FX`). It draws the whole
 * screen opaque: before the way opens, a ball of the other universe's sky with the stars behind it bent round it; then
 * a throat of lit gas streaming toward you, with the other universe's sky at the far end. Plain strings, so the module
 * is cheap to import; three.js is only in `crossing-renderer.ts`.
 */

/** The film is drawn at most this many device pixels per layout pixel: soft light and gas do not need more. */
const PIXEL_RATIO_CAP = 1.25;

/** The pixel ratio the film's drawing buffer uses on a display of `devicePixelRatio` (inside the space views' own cap). */
export function crossingPixelRatio(devicePixelRatio: number): number {
  return Math.min(cappedPixelRatio(devicePixelRatio), PIXEL_RATIO_CAP);
}

export const CROSSING_VERTEX = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const CROSSING_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec2 uRes, uC;
uniform float uT, uR, uOpen, uK, uTwist, uSpeed, uFar, uDark, uGlow, uSeed;
uniform vec3 uA, uM, uB;
float h31(vec3 p){ p = fract(p * vec3(.1031, .1030, .0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
float vn(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z); }
float fbm(vec3 p){ float a = .5, s = 0.; for (int i = 0; i < 4; i++) { s += a * vn(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= .5; } return s; }
float stars(vec2 p, float dens){ vec2 g = floor(p * dens), f = fract(p * dens) - .5; float h = h31(vec3(g, 1.7)); vec2 o = vec2(h31(vec3(g, 2.3)), h31(vec3(g, 3.1))) - .5; float d = length(f - o * .6); return step(.8, h) * smoothstep(.11, .0, d) * (.35 + .65 * h31(vec3(g, 4.9))); }
/* another universe, seen from outside: a web of light, dust in its colour, and stars */
vec3 sky(vec2 d, vec3 tint, float seed){ float n = fbm(vec3(d * 1.8 + seed, seed * .7)); float web = 1. - abs(2. * fbm(vec3(d * 3.2 - seed, 1.3 + seed)) - 1.); web = smoothstep(.72, .98, web);
  vec3 c = tint * (.05 + .45 * n * n) + mix(tint, vec3(1.), .55) * web * .7; c += vec3(1., .96, .88) * stars(d + seed, 22.) * 1.2; return c; }
/* the throat: banks and veins of lit gas on its wall, streaming toward you, twisting more the deeper they are */
vec3 throat(vec2 q){ float r = length(q) + 1e-4, a = atan(q.y, q.x), z = .32 / (r + .035), tw = a + uTwist * z * .3 + uT * .05; vec2 nc = vec2(cos(tw), sin(tw)); float u = z + uT * uSpeed;
  float cl = fbm(vec3(nc * 1.3, u * 1.0)), fil = fbm(vec3(nc * 3.4, u * 2.2 + 7.)), st = fbm(vec3(nc * 8., u * .3 + 3.));
  float body = smoothstep(.36, .78, cl), veins = pow(smoothstep(.42, .9, fil), 2.), streak = pow(st, 5.) * 2.6;
  float k = clamp(uK + z * .05 - .12, 0., 1.); vec3 col = k < .5 ? mix(uA, uM, k * 2.) : mix(uM, uB, k * 2. - 1.);
  vec3 c = col * (body * .5 + veins * .95) + mix(col, vec3(1.), .6) * streak;
  return c * smoothstep(.0, .2, r) * (.3 + .7 * smoothstep(1.35, .2, r)); }
void main(){ vec2 p = (gl_FragCoord.xy - .5 * uRes) / min(uRes.x, uRes.y), q = p - uC; float r = length(q) + 1e-4; vec2 dir = q / r; vec3 c = vec3(0.);
  if (uOpen < 1.) { vec2 sp = q - dir * uR * uR / r * .85; vec3 bg = vec3(1., .97, .9) * stars(sp + uSeed, 34.) + uA * .03 * fbm(vec3(sp * 1.5, 2.));
    float rr = clamp(r / max(uR, 1e-3), 0., 1.), th = asin(rr); vec3 ball = sky(dir * th * .9 + vec2(uT * .015, 0.), uB, 5.) * 1.15; ball += sky(-dir * (1.5708 - th) * 1.6 + vec2(0., uT * .02), uB, 9.) * smoothstep(.72, 1., rr) * .7; ball *= 1. - .55 * smoothstep(.55, .98, rr);
    vec3 o = mix(bg, ball, smoothstep(uR, uR - .006 - uR * .02, r)); float on = step(.002, uR);
    o += vec3(1., .97, .92) * exp(-pow((r - uR) / (.006 + uR * .035), 2.)) * on * 1.1 + uB * .25 * exp(-pow(max(r - uR, 0.) / (uR * .9 + .02), 2.)) * on; c = o * (1. - uOpen); }
  if (uOpen > 0.) { vec3 t = throat(q); float m = smoothstep(uFar + .006 + uFar * .03, uFar, r), rr = clamp(r / max(uFar, 1e-3), 0., 1.), on = step(.002, uFar);
    vec3 far = uDark > .5 ? vec3(0.) : sky(dir * asin(rr) * .9 + vec2(uT * .015, 0.), uB, 5.) * 1.2 * (1. - .5 * smoothstep(.6, 1., rr));
    t = mix(t, far, m * on); t += mix(vec3(1., .97, .92), uA, uDark * .35) * exp(-pow((r - uFar) / (.006 + uFar * .04), 2.)) * on * (1. + uDark);
    t += mix(vec3(1.), uB, .3) * uGlow * exp(-r * r / (.02 + uGlow * uGlow * .5)); c += t * uOpen; }
  gl_FragColor = vec4(c, 1.); }
`;
