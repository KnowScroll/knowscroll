import type { PictureOfKind, PictureState } from '@knowscroll/scroll-model';
import type { PictureBox, PictureScene } from '../scene';

/** Lays out a flow picture to fill the box. Not yet drawn: an empty scene. */
export function layoutFlow(picture: PictureOfKind<'flow'>, _state: PictureState, box: PictureBox): PictureScene {
  return { pictureId: picture.id, width: box.width, height: box.height, shapes: [] };
}
