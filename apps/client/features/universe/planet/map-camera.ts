import type { Loop } from '@knowscroll/scene-core';
import type { UniverseFrame } from '../universe-camera';
import type { Size } from '../universe-layout';

/** The landed map is drawn in a 390 by 844 world and fitted to the screen. */
export const MAP_WIDTH = 390;
export const MAP_HEIGHT = 844;

/** Where the world sits on screen: `screen = world * scale + (x, y)`. */
export interface MapView {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export interface MapBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** How far the person may zoom the landed map, about its middle. */
export const PLANET_ZOOM = { min: 0.7, max: 3 } as const;

/** How far the camera drops over a chosen region: about twice as close, never closer than 2.1 times or farther than 1.6. */
const DROP_FROM = 1.6;
const DROP_TO = 2.1;
/** The part of the 844-unit screen the chosen region is centred in, above the card. */
const CARD_SAFE = { top: 112, bottom: 520 };

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** The box round a region's biggest loop, or `undefined` when it has none. */
export function boxOfLoops(loops: readonly Loop[]): MapBox | undefined {
  const biggest = loops.reduce<Loop | undefined>(
    (best, loop) => (best === undefined || loop.length > best.length ? loop : best),
    undefined,
  );
  if (!biggest || biggest.length < 2) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let at = 0; at < biggest.length; at += 2) {
    const x = biggest[at] ?? 0;
    const y = biggest[at + 1] ?? 0;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

/**
 * The camera of the landed map. The whole map is fitted to the screen and panned and zoomed by the
 * person's frame. With a region chosen the camera drops about twice as close over it and centres it
 * above the card. A pure function of its inputs, so the same screen always draws the same picture.
 */
export function mapView(size: Size, frame: UniverseFrame, chosen?: MapBox): MapView {
  const fit = Math.min(size.width / MAP_WIDTH, size.height / MAP_HEIGHT);
  if (!chosen) {
    const scale = fit * frame.scale;
    return {
      scale,
      x: size.width / 2 - (MAP_WIDTH / 2) * scale - frame.x,
      y: size.height / 2 - (MAP_HEIGHT / 2) * scale - frame.y,
    };
  }
  const drop = clamp(
    Math.min(300 / Math.max(1, chosen.x1 - chosen.x0), 330 / Math.max(1, chosen.y1 - chosen.y0)),
    DROP_FROM,
    DROP_TO,
  );
  const scale = fit * drop * frame.scale;
  const middleY = ((CARD_SAFE.top + CARD_SAFE.bottom) / 2 + 6) * (size.height / MAP_HEIGHT);
  return {
    scale,
    x: size.width / 2 - ((chosen.x0 + chosen.x1) / 2) * scale - frame.x,
    y: middleY - ((chosen.y0 + chosen.y1) / 2) * scale - frame.y,
  };
}

export const toScreen = (view: MapView, x: number, y: number): { readonly x: number; readonly y: number } => ({
  x: x * view.scale + view.x,
  y: y * view.scale + view.y,
});
