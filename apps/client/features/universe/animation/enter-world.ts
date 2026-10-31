import { clamp01, easeOut, lerp, logLerp, progress, smootherstep, smoothstep } from './easing';

/**
 * Entering a world (design "Enter a world", 30 Oct): the round globe flattens into the map you can
 * walk around, landing on the map at planet level with nothing highlighted. 3.2 s, a pure function of
 * `t`. The globe leans in, the flat map fades up inside its circle, and the circle opens out until it
 * fills the screen. While it moves the map is one picture of the same drawing; the live map takes
 * over once landed and underneath they are identical.
 */
export const ENTER_WORLD = {
  seconds: 3.2,
  tapSeconds: 0.6,
  leanIn: [0.15, 1.1],
  openOut: [1.0, 2.45],
  /** The globe grows to this much at the end of the lean. */
  leanScale: 1.32,
  /** The map starts at this share of its landed size, inside the globe. */
  mapStart: 0.45,
} as const;

export interface WorldScene {
  /** The canvas size in layout pixels. */
  readonly screen: { readonly width: number; readonly height: number };
  /** Where the globe sits: centre and radius in layout pixels. */
  readonly globe: { readonly x: number; readonly y: number; readonly radius: number };
}

export interface EnterWorldFrame {
  /** The globe's scale (1 to 1.32) and opacity. */
  readonly globeScale: number;
  readonly globeOpacity: number;
  /** The circle the picture is clipped to: centre and radius. */
  readonly circle: { readonly x: number; readonly y: number; readonly radius: number };
  /** The flat map inside the circle: opacity, scale about the screen's middle and the shift of that middle. */
  readonly map: { readonly opacity: number; readonly scale: number; readonly shiftX: number; readonly shiftY: number };
  /** The globe's shading, rim and stars fade as the circle opens. */
  readonly shading: number;
  /** The live map fades in on top of the moving picture. */
  readonly liveMap: number;
  /** Names and the planet pill come in (2.45 to 2.9 s), then the clouds drift in round the edges (2.55 to 3.05 s). */
  readonly names: number;
  readonly clouds: number;
  /** Back pill, name and hint fade away at the start; the chips stay. */
  readonly leaving: number;
  readonly tapRing: { opacity: number; scale: number };
}

/** The circle that fills the screen from the middle. */
export const fullScreenRadius = (screen: WorldScene['screen']): number => 0.6 * Math.hypot(screen.width, screen.height);

export function enterWorldFrame(rawT: number, scene: WorldScene): EnterWorldFrame {
  const t = Math.min(Math.max(rawT, 0), ENTER_WORLD.seconds);
  const { screen, globe } = scene;
  const lean = smootherstep(progress(t, ENTER_WORLD.leanIn[0], ENTER_WORLD.leanIn[1]));
  const open = smootherstep(progress(t, ENTER_WORLD.openOut[0], ENTER_WORLD.openOut[1]));
  const leaning = (amount: number) => 1 + (ENTER_WORLD.leanScale - 1) * amount;
  const startOfOpening = globe.radius * leaning(smootherstep(progress(ENTER_WORLD.openOut[0], 0.15, 1.1)));
  const radius =
    t < ENTER_WORLD.openOut[0] ? globe.radius * leaning(lean) : logLerp(startOfOpening, fullScreenRadius(screen), open);
  const ring = clamp01(t / ENTER_WORLD.tapSeconds);
  const settled = 1 - open;
  return {
    globeScale: leaning(lean),
    globeOpacity: 1 - smoothstep(0.55, 1.2, t),
    circle: { x: lerp(globe.x, screen.width / 2, open), y: lerp(globe.y, screen.height / 2, open), radius },
    map: {
      opacity: smoothstep(0.45, 1.1, t),
      scale: lerp(ENTER_WORLD.mapStart * ENTER_WORLD.leanScale, 1, open),
      shiftX: (globe.x - screen.width / 2) * settled + 0,
      shiftY: (globe.y - screen.height / 2) * settled + 0,
    },
    shading: 1 - smoothstep(1.0, 2.0, t),
    liveMap: smoothstep(2.45, 2.7, t),
    names: smoothstep(2.45, 2.9, t),
    clouds: smoothstep(2.55, 3.05, t),
    leaving: smoothstep(0.04, 0.35, t),
    tapRing: { opacity: t < ENTER_WORLD.tapSeconds ? 0.9 * (1 - ring) : 0, scale: 1 + 2.2 * easeOut(ring) },
  };
}
