/**
 * What a platform canvas host hands the renderer once its canvas exists: the web has a DOM canvas,
 * native has an `expo-gl` context behind a canvas-shaped object. The renderer is the same on both.
 */
export interface SpaceSurface {
  /** The element three.js draws into: an `HTMLCanvasElement`, or a stand-in on native. */
  readonly canvas: unknown;
  /** The native GL context. The web leaves it out and three.js creates its own from the canvas. */
  readonly context?: WebGL2RenderingContext;
  /** Layout size in CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** Drawing-buffer pixels per layout pixel, already capped at 1.5. */
  readonly pixelRatio: number;
  /** Native: flushes the frame to the screen (`gl.endFrameEXP()`). */
  readonly present?: () => void;
  /** Developer gallery only: keeps the drawing readable for screenshots. */
  readonly preserveDrawingBuffer?: boolean;
}

/** Why the 3D drawing is not available; every reason ends in the Simple lists. */
export type SpaceFailure = 'webgl-unavailable' | 'context-creation-failed' | 'context-lost' | 'render-failed';

/** A coarse reading of what the last frame drew, for the developer gallery and the gate tests. */
export interface SpaceProbe {
  /** Sampled pixels that are lit (stars, glow, bodies) rather than empty sky. */
  readonly litPixels: number;
  readonly sampledPixels: number;
  /** A hash of the sampled bytes: it changes when the picture moves. */
  readonly signature: number;
}

/** A named point of the scene in layout pixels, for the labels and tap targets drawn over it. */
export interface SpaceAnchor {
  readonly id: string;
  readonly kind: 'system' | 'planet';
  readonly name: string;
  readonly x: number;
  readonly y: number;
  /** False when the point is behind the camera. */
  readonly visible: boolean;
}

/** A place chosen from the drawing or from the lists. */
export type SpaceChoice = Pick<SpaceAnchor, 'id' | 'kind' | 'name'>;
