/**
 * Every word the outer stop says, in one place: the title, the line under it, what a button is called and what the
 * list is called. The line is the owner's leaning ("14 friends"); a different sentence changes here and nowhere else.
 */

/** The title drawn over the field. */
export const OUTER_TITLE = 'Beyond your universe';
/** The name under your own bubble. */
export const OWN_UNIVERSE_NAME = 'Your universe';

/** Where the read of the friends has got to, as the layer and the list tell it. */
export type OuterStatus = 'idle' | 'loading' | 'ready' | 'offline' | 'failed';

/** The line under the title. While the friends are still being read it never says a number (it would read as none). */
export function friendsLine(count: number, status: OuterStatus = 'ready'): string {
  if (status === 'loading') return 'Looking for your friends';
  if (status === 'offline') return 'You are offline';
  if (status === 'failed') return 'Couldn’t load your friends';
  if (count === 0) return 'No friends here yet';
  return count === 1 ? '1 friend' : `${count} friends`;
}

/** What a screen reader hears on a friend's universe, and what the film's destination is called. */
export const friendButtonName = (name: string): string => `${name}’s universe`;

/** The name drawn under a bubble, in its short form when the long one has no room. */
export const friendDrawnName = (name: string, short: boolean): string => (short ? name : friendButtonName(name));

/**
 * The chip that opens the plain list, and the list's title. The count is said only when the read is finished and has every
 * friend (`ready` and `complete`): a partial or failed read never claims "All friends (50)".
 */
export const allFriendsLabel = (count: number, status: OuterStatus = 'ready', complete = true): string =>
  status === 'ready' && complete ? `All friends (${count})` : 'All friends';

/** The first letter of a name, as the yellow disc shows it. */
export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first === undefined ? '?' : first.toLocaleUpperCase();
}
