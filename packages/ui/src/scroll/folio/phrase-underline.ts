import { COOL, WARM } from '../picture/palette';
import type { BeatLink } from './reading-model';

/**
 * The colour a linked phrase is underlined in: the colour its part is drawn in, else the page's link colour. Shared by
 * the native and web phrases (`linked-phrase.tsx`, `linked-phrase.web.tsx`), which draw the same underline differently.
 */
export function underlineOf(link: BeatLink, pageLink: string): string {
  if (link.tone === 'warm') return WARM;
  if (link.tone === 'cool') return COOL;
  return pageLink;
}
