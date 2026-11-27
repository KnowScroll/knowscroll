import type { VisitState } from '@knowscroll/client-core';
import type { CrossingWorld } from '../universe/crossing/crossing-director';
import { systemsInCommon } from './in-common';

/**
 * What the crossing film needs to know of a visit: whether the read has answered, the friend's name, and the names of
 * their systems that you have too (`systemsInCommon`, in their order). `ownLabels` is undefined while your own names are
 * not in hand, which gives no names in common rather than a guess. Pure; the names stay on this device.
 */
export function crossingWorldOf(
  state: VisitState | undefined,
  ownLabels: readonly string[] | undefined,
): CrossingWorld {
  if (state === undefined) return { status: 'waiting' };
  switch (state.status) {
    case 'ready':
      return {
        status: 'ready',
        name: state.owner.displayName,
        shared: ownLabels ? systemsInCommon(ownLabels, state.systems).map((system) => system.label) : undefined,
      };
    case 'unavailable':
    case 'offline':
      return { status: 'gone' };
    case 'loading':
    case 'ended':
      return { status: 'waiting' };
  }
}
