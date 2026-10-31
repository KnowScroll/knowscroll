import { rasterEmblem } from '../../../rooms/identity/emblem-raster';
import type { StationEmblem } from '../space-definition';
import type { PixelImage } from '../texture-data';

/**
 * A room's emblem as a texture image for its station (D-170): the same drawing the room's band shows, in pixels. A
 * texture's first row is its bottom, so the rows are turned over for the emblem to stand upright.
 */
export function emblemImage(emblem: StationEmblem): PixelImage {
  const { data, width, height } = rasterEmblem(emblem, 64);
  const upright = new Uint8Array(data.length);
  const stride = width * 4;
  for (let row = 0; row < height; row += 1)
    upright.set(data.subarray(row * stride, (row + 1) * stride), (height - 1 - row) * stride);
  return { data: upright, width, height };
}
