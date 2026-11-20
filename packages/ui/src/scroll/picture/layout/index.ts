import type { Picture, PictureState } from '@knowscroll/scroll-model';
import type { PictureBox, PictureScene } from '../scene';
import { labelSize, wrapText } from '../text';
import { MARGIN } from './common';
import { layoutChart } from './chart';
import { layoutCycle } from './cycle';
import { layoutFlow } from './flow';
import { layoutGrid } from './grid';
import { layoutPlan } from './plan';
import { layoutStatement } from './statement';

/** The smallest a caption is set; below this it would stop being readable. */
const SMALLEST_CAPTION = 9;
/** The lines a caption takes at a comfortable size, and the most it takes at the smallest: a narrow plate (320 px) still shows the whole caption rather than cutting it. */
const CAPTION_LINES = 2;
const CAPTION_LINES_AT_SMALLEST = 3;

/**
 * The caption wrapped to the box in its mono face, and the size it is set at: the label size, stepped down (to 9 px)
 * until the whole caption fits in two lines; at 9 px it may take a third. Only a caption longer than that ends with an
 * ellipsis (the longest the model allows, 120 characters, fits at 320 px).
 */
function captionLines(caption: string | undefined, box: PictureBox): { lines: string[]; size: number } {
  const start = labelSize(box.height, box.textScale) * 0.9;
  if (caption === undefined) return { lines: [], size: start };
  const width = box.width - 2 * MARGIN;
  for (let size = start; size > SMALLEST_CAPTION; size -= 0.5) {
    const lines = wrapText(caption, width, size, CAPTION_LINES + 1, 'mono');
    if (lines.length <= CAPTION_LINES) return { lines, size };
  }
  const size = Math.min(start, SMALLEST_CAPTION);
  return { lines: wrapText(caption, width, size, CAPTION_LINES_AT_SMALLEST, 'mono'), size };
}

/**
 * Lays a picture out for a box: its kind's layout fills the box, less a line at the foot for the caption when it has
 * one. Pure and deterministic, so the same picture, state and box always give the same scene, which is what lets a
 * glide find each shape in both scenes.
 */
export function layoutPicture(picture: Picture, state: PictureState, box: PictureBox): PictureScene {
  const { lines: caption, size } = captionLines(picture.caption, box);
  const captionRoom = caption.length === 0 ? 0 : size * (0.8 + caption.length);
  const body: PictureBox = { ...box, height: Math.max(0, box.height - captionRoom) };
  const scene = layoutKind(picture, state, body);
  if (caption.length === 0) return scene;
  return {
    ...scene,
    height: box.height,
    shapes: [
      ...scene.shapes,
      {
        type: 'text',
        key: 'caption',
        x: MARGIN,
        y: box.height - size * (caption.length - 0.3),
        lines: caption,
        size,
        lineHeight: size * 1.1,
        weight: 'regular',
        anchor: 'start',
        fill: 'ink2',
        family: 'mono',
        opacity: 1,
      },
    ],
  };
}

function layoutKind(picture: Picture, state: PictureState, box: PictureBox): PictureScene {
  switch (picture.kind) {
    case 'statement':
      return layoutStatement(picture, state, box);
    case 'flow':
      return layoutFlow(picture, state, box);
    case 'cycle':
      return layoutCycle(picture, state, box);
    case 'grid':
      return layoutGrid(picture, state, box);
    case 'chart':
      return layoutChart(picture, state, box);
    case 'plan':
      return layoutPlan(picture, state, box);
  }
}
