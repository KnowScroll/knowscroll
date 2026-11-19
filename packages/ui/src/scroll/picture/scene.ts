/**
 * A picture laid out for one box: plain shapes in the box's own pixels, each with a stable key and a colour role. The
 * kinds' layouts (`layout-*.ts`) make one from a picture's data and state; `PictureSvg` draws it; `blendPictureScenes`
 * glides between two of the same picture. A scene names roles, never colours, so one scene draws in Light and Dark.
 */

/** Colours by job. Page roles follow the page's appearance; meaning roles keep one value in both (D-424). */
export type PictureRole =
  // The page's own roles (`usePagePalette`).
  | 'ink'
  | 'ink2'
  | 'rule'
  | 'ground'
  | 'raised'
  // Meanings, fixed hex that reads on both page grounds (a tone of the picture's data).
  | 'warm'
  | 'cool'
  | 'mark'
  | 'none';

interface ShapeBase {
  /** Stable across states of one picture, so a glide can match the shape in both scenes. */
  readonly key: string;
  /** The picture part it draws, so a linked phrase can pulse it. */
  readonly part?: string | undefined;
  /** 0 to 1: a receded item is drawn faint, an item not yet reached is 0. */
  readonly opacity: number;
}

export interface RectShape extends ShapeBase {
  readonly type: 'rect';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly cornerRadius: number;
  readonly fill: PictureRole;
  readonly stroke: PictureRole;
  readonly strokeWidth: number;
}

export interface CircleShape extends ShapeBase {
  readonly type: 'circle';
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly fill: PictureRole;
  readonly stroke: PictureRole;
  readonly strokeWidth: number;
}

export interface LineShape extends ShapeBase {
  readonly type: 'line';
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly stroke: PictureRole;
  readonly strokeWidth: number;
  readonly dashed: boolean;
  /** An arrowhead at the (x2, y2) end. */
  readonly arrow: boolean;
}

/** An arc of a circle from one angle to another (radians, clockwise from the right), for rings. */
export interface ArcShape extends ShapeBase {
  readonly type: 'arc';
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly from: number;
  readonly to: number;
  readonly stroke: PictureRole;
  readonly strokeWidth: number;
  readonly arrow: boolean;
}

export interface TextShape extends ShapeBase {
  readonly type: 'text';
  readonly x: number;
  /** The baseline of the first line. */
  readonly y: number;
  /** Already wrapped by the layout: one entry per line. */
  readonly lines: readonly string[];
  readonly size: number;
  readonly lineHeight: number;
  readonly weight: 'regular' | 'bold';
  readonly anchor: 'start' | 'middle' | 'end';
  readonly fill: PictureRole;
  readonly family: 'sans' | 'mono' | 'serif';
}

export type PictureShape = RectShape | CircleShape | LineShape | ArcShape | TextShape;

export interface PictureScene {
  /** The picture's id and the box: two scenes glide only when both match. */
  readonly pictureId: string;
  readonly width: number;
  readonly height: number;
  /** In painting order. */
  readonly shapes: readonly PictureShape[];
}

/** The box a layout fills, and how big the text may be. */
export interface PictureBox {
  readonly width: number;
  readonly height: number;
  /** The reader's text scale (1 = 100 %); labels grow with it, within the box. */
  readonly textScale: number;
}
