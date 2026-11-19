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

/**
 * Lays a picture out for a box: its kind's layout fills the box, less a line at the foot for the caption when it has
 * one. Pure and deterministic, so the same picture, state and box always give the same scene, which is what lets a
 * glide find each shape in both scenes.
 */
export function layoutPicture(picture: Picture, state: PictureState, box: PictureBox): PictureScene {
  const size = labelSize(box.height, box.textScale) * 0.9;
  // Two lines, so a narrow plate (320 px) still shows the whole caption rather than cutting it.
  const caption = picture.caption === undefined ? [] : wrapText(picture.caption, box.width - 2 * MARGIN, size, 2);
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
