/**
 * What the trial's stage and the camera driver say to each other. The stage's controller owns a {@link VoyageControl}
 * and changes it as the person moves; the driver (`voyage-driver.ts`) reads it on every frame and reports back after
 * each one (`afterFrame`). Types only, so both sides may import it without three.js reaching the main bundle.
 */
import type { Chart, GlobeWorld } from '@knowscroll/scene-core';
import type { PlanetPalette } from '../planet/planet-palette';
import type { RigFocus } from '../space/camera-rig';
import type { VoyageTarget } from './ladder';
import type { DrawnShip } from './ship-motion';
import type { LabelPoint } from './world-texture';

/** The planet the camera is at or going to, ready to be drawn as one world. */
export interface VoyagePlanet {
  /** Changes when the world or what is charted on it changes: the texture is painted again. */
  readonly key: string;
  readonly planetId: string;
  readonly world: GlobeWorld;
  readonly chart: Chart;
  readonly palette: PlanetPalette;
  /** Each formed region's name point, and its name. */
  readonly labels: readonly LabelPoint[];
  readonly names: ReadonlyMap<string, string>;
}

/**
 * What the screen tells the driver, by reference: it is read on every frame, so the screen changes it without
 * rebuilding the renderer.
 */
export interface VoyageControl {
  target: VoyageTarget;
  /** How far the person has dragged what is in front of them, in layout points. */
  turn: { readonly x: number; readonly y: number };
  /** The planet to draw as one world when the camera is at it, once its world and chart are ready. */
  planet: VoyagePlanet | null;
  /** The planets of the star the camera is at: near a planet, the others step aside so its world fills the view. */
  siblings: readonly string[];
  /** Cut to each stop instead of flying, paint a world's texture in one frame, and do not spin the globe. */
  reducedMotion: boolean;
  /** What the whole-universe stop looks at, as the map's rig takes it. */
  universeFocus: Extract<RigFocus, { kind: 'universe' }>;
  /** What a star's stop looks at, as the map's rig takes it; undefined for a star the map does not hold. */
  systemFocus: (systemId: string) => Extract<RigFocus, { kind: 'system' }> | undefined;
  /** How far the view leans with the ship, in layout points (0, 0 when it does not). */
  lean: { readonly x: number; readonly y: number };
  /**
   * A pinch's zoom: at rest the camera stands at its stop's distance times `scale`, following the fingers (more than 1
   * is farther), and going in it turns toward `toward`, the place under the fingers that a pinch in would go to. It is
   * kept after the fingers lift until the flight they asked for starts, so that flight leaves from where the camera
   * is; null when no pinch holds the camera, and the camera eases back to its stop.
   */
  zoom: { readonly scale: number; readonly toward: string | null } | null;
  /** Called after each frame drawn: the screen moves the ship with the frame and says where to draw it, if anywhere. */
  afterFrame?: (frame: VoyageFrame) => DrawnShip | null;
}

/** Where a planet's globe was drawn on screen, in layout points. */
export interface GlobeOnScreen {
  readonly x: number;
  readonly y: number;
  readonly radiusPx: number;
}

/** What the screen learns after each frame. */
export interface VoyageFrame {
  /** Seconds since the last frame, at most 0.1. */
  readonly dt: number;
  /** A flight is under way: the ship is not drawn. */
  readonly flying: boolean;
  /** Where the planet's globe is on screen, when it is drawn. */
  readonly globe: GlobeOnScreen | null;
  /** The size of the view, in layout points. */
  readonly size: { readonly width: number; readonly height: number };
  /** How many shader programs three.js holds now, for the frame-rate readout: a rise during a flight is a link. */
  readonly programs: number;
}
