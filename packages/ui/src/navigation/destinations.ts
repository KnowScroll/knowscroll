import type { IconName } from '../icons/icon-paths';

/**
 * The four top-level destinations (D-006 c). Route names follow the blueprint; the labels follow
 * the v2.1 export: Explore · Universe · Talk · Keep.
 */
export type Destination = 'explore' | 'universe' | 'conversations' | 'saved';

export const destinations: readonly { readonly id: Destination; readonly label: string; readonly icon: IconName }[] = [
  { id: 'explore', label: 'Explore', icon: 'explore' },
  { id: 'universe', label: 'Universe', icon: 'universe' },
  { id: 'conversations', label: 'Talk', icon: 'talk' },
  { id: 'saved', label: 'Keep', icon: 'keep' },
];

/** The description Talk carries while something is unread (never a count, never in its name). */
export const unreadDescription = 'Unread messages';
