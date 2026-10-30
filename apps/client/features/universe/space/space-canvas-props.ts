import type { SpaceFailure, SpaceSurface } from './space-surface';

/** What every platform canvas host (`space-canvas.web.tsx`, `space-canvas.tsx`) takes. */
export interface SpaceCanvasProps {
  /** The canvas exists and has a size: three.js can draw into it. Called once per host. */
  readonly onSurface: (surface: SpaceSurface) => void;
  /** The layout size changed after the surface was made. */
  readonly onResize: (width: number, height: number) => void;
  /** The host cannot give a WebGL context, or lost it. */
  readonly onFailure: (reason: SpaceFailure) => void;
  /** The canvas leaves or enters the screen (web only; native screens are covered by route focus). */
  readonly onOnScreen: (onScreen: boolean) => void;
  /** Developer gallery only: keep the drawing readable for screenshots. */
  readonly preserveDrawingBuffer?: boolean;
}
