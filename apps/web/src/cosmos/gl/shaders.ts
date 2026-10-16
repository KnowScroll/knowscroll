/**
 * GLSL shared by the origin opening and the live Universe sky. The star shader is deliberately the
 * same program in both places, so the star the opening ends on and the stars the reader taps are
 * one visual object (ADR-0049 §5, continuity between cinematic and live objects).
 *
 * Noise: 2D simplex noise after Ian McEwan / Ashima Arts (MIT), and a cellular (Worley) noise for
 * stellar granulation.
 */

const NOISE = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    sum += amp * snoise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    amp *= 0.5;
  }
  return sum;
}
float fbm3(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 3; i++) {
    sum += amp * snoise(p);
    p = p * 2.07 + vec2(5.3, 1.7);
    amp *= 0.5;
  }
  return sum;
}
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
float cells(vec2 p, float time) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d = 1.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = hash2(i + g);
      o = 0.5 + 0.5 * sin(time + 6.2831 * o);
      vec2 r = g + o - f;
      d = min(d, dot(r, r));
    }
  }
  return sqrt(d);
}
`;

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_corner;
out vec2 v_uv;
void main() {
  v_uv = a_corner * 0.5 + 0.5;
  gl_Position = vec4(a_corner, 0.0, 1.0);
}
`;

/** Matter: the cosmic web, the star's envelope and the material it releases, all in one buffer. */
export const PARTICLE_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec4 a_seed;
layout(location = 2) in vec2 a_kind;
uniform mat4 u_viewProj;
uniform float u_proj11;
uniform float u_viewportH;
uniform float u_px;
uniform float u_time;
uniform float u_scale;
uniform float u_heat;
uniform float u_web;
uniform float u_gather;
uniform float u_compress;
uniform float u_consume;
uniform vec3 u_cores[5];
uniform vec3 u_star;
uniform float u_envR;
uniform float u_eject;
uniform float u_matFade;
uniform float u_stream;
uniform vec3 u_disk;
uniform float u_diskForm;
uniform float u_diskSpin;
uniform float u_diskFade;
uniform float u_fragments;
out vec3 v_color;
out float v_alpha;
out float v_glyph;

const vec3 COBALT = vec3(0.17, 0.27, 0.91);
const vec3 TEAL = vec3(0.08, 0.78, 0.61);
const vec3 CREAM = vec3(1.0, 0.98, 0.94);
const vec3 HOT = vec3(1.0, 0.86, 0.62);
const vec3 OIII = vec3(0.24, 0.86, 0.80);
const vec3 HALPHA = vec3(0.93, 0.42, 0.58);
const vec3 GOLD = vec3(1.0, 0.80, 0.36);

vec3 rotY(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }
vec3 rotX(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z); }

void main() {
  vec3 p;
  vec3 color;
  float alpha;
  float size;
  v_glyph = 0.0;
  if (a_kind.x < 0.5) {
    // The cosmic web: expands with the scale factor, then some of it falls into five cores.
    p = a_pos * u_scale;
    float turb = (1.0 - u_scale) * 0.9 + 0.06;
    p += turb * u_scale * 0.35 * vec3(sin(a_seed.x * 6.283 + u_time * 0.31), cos(a_seed.y * 6.283 + u_time * 0.27), sin(a_seed.z * 6.283 + u_time * 0.23));
    float g = 0.0;
    if (a_kind.y >= 0.0) {
      int ci = int(a_kind.y + 0.5);
      vec3 core = u_cores[ci];
      g = smoothstep(a_seed.w * 0.55, a_seed.w * 0.55 + 0.45, u_gather);
      vec3 off = p - core;
      off = rotY(off, g * (2.5 + a_seed.x * 3.5));
      float shrink = mix(1.0, mix(0.32, 0.06, u_compress) * (0.35 + a_seed.z), g);
      p = core + off * shrink;
    }
    vec3 cool = mix(COBALT, TEAL, a_seed.y);
    cool = mix(cool, CREAM, step(0.92, a_seed.z) * 0.6);
    color = mix(cool, HOT, u_heat);
    color = mix(color, mix(GOLD, CREAM, a_seed.x), g * u_compress * 0.8);
    float coolBoost = mix(2.4, 1.0, u_heat);
    alpha = u_web * coolBoost * (0.35 + 0.65 * a_seed.z) * (0.55 + g * 0.9) * (1.0 - g * u_consume * 0.995);
    size = mix(0.02, 0.036, a_seed.z) * (1.0 + u_heat * 1.6) * (1.0 + g * 0.5);
  } else {
    // Released material. Phase A: the star's envelope. Phase B: ejected as a bipolar shell and a
    // slower equatorial ring. Phase C: part of it streams to a new cloud. Phase D: a rotating disk.
    vec3 dir = normalize(a_pos);
    float ring = step(0.84, a_seed.w);
    if (ring > 0.5) dir = normalize(vec3(dir.x, dir.y * 0.12, dir.z));
    float lobe = 0.55 + 0.9 * pow(abs(dir.y), 1.6);
    float speedN = a_seed.y;
    float speed = (0.72 + 0.55 * speedN) * mix(lobe, 0.6, ring);
    vec3 shell = u_star + dir * (u_envR * (0.9 + 0.12 * a_seed.x) + u_eject * speed * 0.78);
    shell += 0.035 * u_eject * vec3(sin(a_seed.x * 40.0 + u_time * 0.5), cos(a_seed.z * 37.0 + u_time * 0.4), sin(a_seed.y * 31.0));
    float streamer = step(a_seed.z, 0.5);
    float s = smoothstep(a_seed.x * 0.45, a_seed.x * 0.45 + 0.55, u_stream) * streamer;
    vec3 mid = mix(u_star, u_disk, 0.5) + vec3(0.0, 0.55, 0.25);
    vec3 cloud = u_disk + normalize(a_pos + vec3(0.0001)) * (0.35 + 0.95 * pow(a_seed.w, 0.6)) * vec3(1.0, 0.62, 1.0);
    vec3 a = mix(shell, mid, s);
    vec3 b = mix(mid, cloud, s);
    vec3 streamPos = mix(a, b, s);
    float r = 0.14 + 0.9 * pow(a_seed.y, 0.75);
    float gapA = smoothstep(0.03, 0.0, abs(r - 0.38));
    float gapB = smoothstep(0.035, 0.0, abs(r - 0.62));
    float gapC = smoothstep(0.04, 0.0, abs(r - 0.86));
    r += (gapA + gapB + gapC) * 0.05 * (a_seed.w - 0.5) * 2.0;
    float ang = a_seed.x * 6.2831 + u_diskSpin * 0.32 * pow(max(r, 0.12), -1.5);
    vec3 local = vec3(cos(ang) * r, (a_seed.w - 0.5) * 0.025 * r, sin(ang) * r);
    vec3 diskPos = u_disk + rotX(local, 0.42);
    p = mix(streamPos, diskPos, u_diskForm * streamer);
    vec3 enriched = mix(OIII, HALPHA, smoothstep(0.25, 0.85, speedN));
    enriched = mix(enriched, GOLD, step(0.93, a_seed.x) * 0.8);
    vec3 dust = mix(GOLD, CREAM, a_seed.x * 0.6);
    color = mix(enriched, mix(dust, TEAL, step(0.82, a_seed.y) * 0.7), u_diskForm * streamer);
    float stayFade = mix(1.0 - smoothstep(0.55, 1.0, u_stream), 1.0, streamer);
    alpha = u_matFade * stayFade * mix(1.0, 0.55, ring) * mix(1.0, u_diskFade, streamer) * (0.4 + 0.6 * a_seed.z);
    size = mix(0.012, 0.022, a_seed.x) * (1.0 + (1.0 - u_diskForm) * 0.4);
    // A few disk motes carry KnowScroll's own marks: a Reel frame, a Scroll sheet, a question.
    float glyph = step(0.9955, fract(a_seed.y * 97.13 + a_seed.w * 31.7)) * streamer * u_fragments;
    if (glyph > 0.0) {
      v_glyph = 1.0 + floor(fract(a_seed.w * 13.7) * 3.0);
      size = 0.085;
      color = CREAM;
      alpha = u_fragments * u_diskFade * 0.95;
    }
  }
  vec4 clip = u_viewProj * vec4(p, 1.0);
  gl_Position = clip;
  float px = size * u_proj11 / max(clip.w, 0.02) * u_viewportH * 0.5;
  gl_PointSize = clamp(px * u_px, 1.0, 64.0);
  float tiny = smoothstep(0.0, 1.5, px * u_px);
  v_alpha = alpha * tiny * smoothstep(0.02, 0.4, clip.w);
  v_color = color;
}
`;

export const PARTICLE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_color;
in float v_alpha;
in float v_glyph;
uniform float u_gain;
out vec4 outColor;
float box(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float a;
  if (v_glyph > 0.5) {
    float d;
    if (v_glyph < 1.5) d = abs(box(q, vec2(0.36, 0.62), 0.16)) - 0.07;       // a Reel frame
    else if (v_glyph < 2.5) {                                              // a Scroll sheet
      d = box(q, vec2(0.46, 0.6), 0.08);
      float lines = abs(fract((q.y + 0.6) * 3.2) - 0.5) - 0.18;
      d = max(d, -max(lines, abs(q.x) - 0.3));
    } else {                                                               // a question
      float arc = abs(length(q - vec2(0.0, 0.18)) - 0.32) - 0.08;
      arc = max(arc, -(q.y - 0.12 + q.x * 0.6));
      float dot_ = length(q - vec2(0.0, -0.55)) - 0.1;
      d = min(arc, dot_);
    }
    a = smoothstep(0.08, -0.04, d) + exp(-dot(q, q) * 3.0) * 0.25;
  } else {
    a = exp(-dot(q, q) * 4.0);
  }
  outColor = vec4(v_color * a * v_alpha * u_gain, a * v_alpha);
}
`;

/**
 * Billboards for stars and planets. Instance data: position (vec3), radius (world units), colour
 * (vec3), and four style values:
 *   x: intensity, y: granulation (surface structure), z: tension (asymmetric corona),
 *   w: mode (0 star, 1 planet lit from the light uniform, 2 star with a released shell).
 */
export const BILLBOARD_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 i_posR;
layout(location = 2) in vec3 i_color;
layout(location = 3) in vec4 i_style;
layout(location = 4) in float i_seed;
uniform mat4 u_viewProj;
uniform float u_proj11;
uniform float u_aspect;
uniform float u_viewportH;
uniform float u_spread;
out vec2 v_q;
out vec3 v_color;
out vec4 v_style;
out float v_rpx;
out float v_seed;
out float v_spread;
void main() {
  vec4 c = u_viewProj * vec4(i_posR.xyz, 1.0);
  float w = max(c.w, 0.02);
  float r = i_posR.w * u_proj11 / w;
  float spread = i_style.w > 1.5 ? u_spread * 1.9 : (i_style.w > 0.5 ? 1.25 : u_spread);
  vec2 offs = a_corner * r * spread;
  offs.x /= u_aspect;
  gl_Position = vec4(c.xy / w + offs, c.z / w, 1.0);
  v_q = a_corner * spread;
  v_color = i_color;
  v_style = i_style;
  v_rpx = r * u_viewportH * 0.5;
  v_seed = i_seed;
  v_spread = spread;
}
`;

export const BILLBOARD_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_q;
in vec3 v_color;
in vec4 v_style;
in float v_rpx;
in float v_seed;
in float v_spread;
uniform float u_time;
uniform vec2 u_light;
uniform float u_gain;
out vec4 outColor;
${NOISE}
void main() {
  float d = length(v_q);
  float intensity = v_style.x;
  float gran = v_style.y;
  float tension = v_style.z;
  float mode = v_style.w;
  vec3 col = vec3(0.0);
  float alpha = 0.0;
  if (mode > 0.5 && mode < 1.5) {
    // A world: a small lit sphere with banded surface and a thin atmosphere rim.
    float disc = smoothstep(1.0, 0.96, d);
    vec3 n = vec3(v_q, sqrt(max(0.0, 1.0 - d * d)));
    vec3 l = normalize(vec3(u_light, 0.55));
    float lit = clamp(dot(n, l), 0.0, 1.0);
    float bands = fbm3(vec2(v_q.x * 1.6 + v_seed * 9.0 + u_time * 0.02, v_q.y * 5.0 + v_seed * 3.0));
    vec3 surface = v_color * (0.75 + 0.35 * bands);
    col = surface * (0.08 + 1.05 * lit) * disc;
    float rim = smoothstep(0.82, 1.0, d) * smoothstep(1.12, 1.0, d);
    col += v_color * rim * 0.7 * (0.3 + lit);
    alpha = max(disc, rim * 0.6);
    outColor = vec4(col * intensity * u_gain, alpha);
    return;
  }
  // A star: a bright core falling to a warmer limb, a living surface whose structure shows only
  // when the star is large on screen, a warm corona, optional tension and a released shell.
  float disc = smoothstep(1.0, 0.985 - min(0.02, 1.5 / max(v_rpx, 1.0)), d);
  float mu = sqrt(max(0.0, 1.0 - d * d));
  float limb = 0.5 + 0.5 * pow(mu, 0.6);
  vec2 sp = v_q / max(0.25, 1.0 + mu * 0.6);
  float cellScale = mix(3.0, 7.5, clamp(gran, 0.0, 1.0));
  float c1 = cells(sp * cellScale + v_seed * 13.0, u_time * 0.35 + v_seed);
  float c2 = cells(sp * cellScale * 2.3 + 7.0, u_time * 0.5);
  float large = smoothstep(18.0, 70.0, v_rpx);
  float structure = gran * smoothstep(4.0, 16.0, v_rpx);
  float lanes = structure * (mix(0.14, 0.38, large) * smoothstep(0.08, 0.5, c1) + mix(0.05, 0.16, large) * c2);
  float whiteness = smoothstep(0.35, 0.8, v_color.b);
  vec3 limbColor = v_color * vec3(1.0, 0.74, 0.5);
  vec3 coreColor = mix(v_color, vec3(1.0, 0.98, 0.93), mix(0.25, 0.65, whiteness));
  vec3 hot = mix(limbColor, coreColor, pow(mu, 0.8));
  vec3 laneColor = hot * vec3(0.96, 0.6, 0.32);
  col = mix(hot, laneColor, clamp(lanes * 1.9, 0.0, 1.0)) * limb * disc * 1.45 * (1.0 - lanes * 0.3);
  float ang = atan(v_q.y, v_q.x);
  float flare = 1.0 + tension * (1.6 * max(0.0, sin(ang * 1.0 + u_time * 0.6 + v_seed * 6.0)) + 0.6 * fbm3(vec2(ang * 2.0, u_time * 0.4 + v_seed)));
  float corona = exp(-max(d - 1.0, 0.0) * mix(2.4, 1.6, tension) / flare) * smoothstep(0.9, 1.0, d);
  float halo = exp(-d * d * 0.55) * 0.42 + exp(-d * 1.1) * 0.12;
  vec3 glow = mix(v_color, vec3(1.0, 0.86, 0.6), 0.35);
  col += glow * (corona * 0.95 + halo) * (1.0 - disc * 0.55);
  alpha = max(disc, corona * 0.8);
  if (mode > 1.5) {
    // A released shell of enriched material, the drawing of a luminous star (ADR-0049 §2).
    float rr = d / 1.9;
    float shellN = fbm(v_q * 1.3 + v_seed * 5.0 + u_time * 0.03);
    float ringD = abs(rr - (1.25 + 0.1 * shellN)) ;
    float shellA = exp(-ringD * ringD * 60.0) * (0.55 + 0.45 * shellN);
    vec3 shellCol = mix(vec3(0.24, 0.86, 0.80), vec3(0.93, 0.42, 0.58), smoothstep(1.0, 1.5, rr + shellN * 0.2));
    col += shellCol * shellA * 0.8;
    alpha = max(alpha, shellA * 0.7);
  }
  float edge = smoothstep(v_spread, v_spread * 0.62, d);
  outColor = vec4(col * intensity * u_gain * edge, alpha * edge);
}
`;

/**
 * Gas: screen-space volumes driven by up to eight blobs computed on the CPU from world positions.
 * Blob: centre (px), radius (px), kind, density; colour; extra (ring radius / disk tilt).
 * kind 0 cloud, 1 bang glow, 2 released shell (planetary nebula), 3 disk, 4 seed cloud.
 */
export const GAS_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec2 u_res;
uniform float u_time;
uniform int u_count;
uniform vec4 u_blob[8];
uniform vec3 u_blobColor[8];
uniform vec4 u_blobExtra[8];
uniform float u_ambient;
uniform vec3 u_ambientColor;
uniform vec2 u_ambientCenter;
out vec4 outColor;
${NOISE}
void main() {
  vec2 px = v_uv * u_res;
  vec3 acc = vec3(0.0);
  float minRes = min(u_res.x, u_res.y);
  vec2 ap = (px - u_ambientCenter) / minRes;
  acc += u_ambientColor * u_ambient * exp(-dot(ap, ap) * 2.2) * (0.75 + 0.25 * fbm3(ap * 2.0 + u_time * 0.01));
  for (int i = 0; i < 8; i++) {
    if (i >= u_count) break;
    vec4 b = u_blob[i];
    vec3 color = u_blobColor[i];
    vec4 extra = u_blobExtra[i];
    vec2 q = (px - b.xy) / max(b.z, 1.0);
    float kind = extra.w;
    float density = 0.0;
    if (kind < 0.5 || kind > 3.5) {
      float n = fbm(q * 1.4 + vec2(u_time * 0.015, -u_time * 0.01) + float(i) * 3.7);
      float body = exp(-dot(q, q) * (kind > 3.5 ? 2.4 : 1.6));
      density = body * smoothstep(-0.35, 0.65, n + extra.x) ;
      if (kind > 3.5) {
        acc += vec3(1.0, 0.86, 0.6) * (exp(-dot(q, q) * 30.0) * 0.9 + exp(-dot(q, q) * 7.0) * 0.25) * b.w;
      }
    } else if (kind < 1.5) {
      float r = length(q);
      float rays = 0.65 + 0.35 * fbm3(vec2(atan(q.y, q.x) * 3.0, r * 2.0 - u_time * 0.5));
      density = exp(-r * r * 3.0) * rays + exp(-r * 9.0) * 1.2;
    } else if (kind < 2.5) {
      vec2 qq = vec2(q.x, q.y * mix(1.0, 0.72, extra.y));
      float r = length(qq);
      float n = fbm(qq * 2.2 + float(i) * 2.0 + u_time * 0.02);
      float ring = exp(-pow((r - extra.x - 0.08 * n) / 0.14, 2.0));
      float lobes = exp(-pow((length(vec2(q.x * 1.6, abs(q.y) - extra.x * 0.9)) - extra.x * 0.55) / 0.22, 2.0)) * 0.55;
      density = (ring + lobes) * (0.6 + 0.4 * n);
      vec3 inner = vec3(0.24, 0.86, 0.80);
      vec3 outer = vec3(0.93, 0.42, 0.58);
      color = mix(inner, outer, smoothstep(extra.x * 0.7, extra.x * 1.25, r)) * 0.8 + color * 0.2;
    } else {
      float tilt = max(0.18, extra.y);
      vec2 dq = vec2(q.x, q.y / tilt);
      float r = length(dq);
      float n = fbm(vec2(atan(dq.y, dq.x) * 2.0 + u_time * 0.12 / max(r, 0.2), r * 6.0));
      float gaps = (1.0 - 0.75 * exp(-pow((r - 0.38) / 0.025, 2.0))) * (1.0 - 0.7 * exp(-pow((r - 0.62) / 0.03, 2.0))) * (1.0 - 0.6 * exp(-pow((r - 0.86) / 0.035, 2.0)));
      density = smoothstep(1.05, 0.2, r) * smoothstep(0.04, 0.16, r) * gaps * (0.65 + 0.35 * n) * extra.x;
      density += exp(-r * r * 40.0) * 0.4;
    }
    acc += color * density * b.w;
  }
  outColor = vec4(acc, 1.0);
}
`;

/** Tone-maps the HDR scene and the gas into the final frame with a little grain against banding. */
export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_scene;
uniform sampler2D u_gas;
uniform vec3 u_ground;
uniform float u_exposure;
uniform float u_vignette;
uniform float u_time;
uniform float u_black;
out vec4 outColor;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  vec3 scene = texture(u_scene, v_uv).rgb + texture(u_gas, v_uv).rgb;
  vec3 col = aces(scene * u_exposure);
  vec2 c = v_uv - 0.5;
  float vig = 1.0 - u_vignette * dot(c, c) * 1.6;
  col = u_ground + col * vig;
  float grain = fract(sin(dot(v_uv * 1000.0 + u_time, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  col += grain * 0.012;
  col = mix(col, vec3(0.0), u_black);
  outColor = vec4(col, 1.0);
}
`;

/** Point stars of the far sky (background), in CSS pixels, drawn after the scene. */
export const POINTS_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_px;
layout(location = 1) in vec4 a_style;
uniform vec2 u_res;
uniform float u_dpr;
uniform float u_alpha;
uniform vec2 u_offset;
out vec3 v_color;
out float v_alpha;
void main() {
  vec2 p = a_px + u_offset;
  gl_Position = vec4(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0, 0.0, 1.0);
  gl_PointSize = max(1.0, a_style.x * 2.0 * u_dpr + 1.0);
  v_color = a_style.yzw;
  v_alpha = u_alpha;
}
`;

export const POINTS_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_color;
in float v_alpha;
out vec4 outColor;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float a = smoothstep(1.0, 0.3, length(q)) * v_alpha;
  outColor = vec4(v_color * a, a);
}
`;
