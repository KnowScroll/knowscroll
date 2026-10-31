import type { Orbit, ReadOrbitRequest } from '@knowscroll/contracts';
import type { PersonalAuthority } from '../../identity/public.js';
import { orbitOf } from '../domain/orbit.js';
import type { PlayPorts } from './ports.js';

export type ReadOrbitResult =
  | { readonly kind: 'orbit'; readonly orbit: Orbit }
  | { readonly kind: 'refused'; readonly reason: 'epoch_changed' | 'universe_unavailable' };

/**
 * `POST /v1/play/orbit/read`: this week's Orbit, the days of the week on which the caller locked a
 * call, out of three (D-087, D-215). Their own calls only, at their current epoch, with the week and
 * its days named in the zone the device sent. A read: it answers while recording is paused (a day
 * played while paused was never stored, so it is not counted, D-083) and writes nothing. It is text
 * for the Universe; nothing reads it back into ranking, planning or places.
 */
export function makeReadOrbit(ports: Pick<PlayPorts, 'withPersonalScope' | 'fenceOwn' | 'store'>) {
  return async (authority: PersonalAuthority, request: ReadOrbitRequest): Promise<ReadOrbitResult> => {
    const entered = await ports.withPersonalScope(authority, async (scope) => {
      if ((await ports.fenceOwn(scope)).kind !== 'active') return undefined;
      return ports.store.readPlayDays(scope, request.timeZone);
    });
    if (entered.kind === 'refused')
      return {
        kind: 'refused',
        reason: entered.refusal.kind === 'epoch_changed' ? 'epoch_changed' : 'universe_unavailable',
      };
    if (entered.value === undefined) return { kind: 'refused', reason: 'universe_unavailable' };
    return { kind: 'orbit', orbit: orbitOf(entered.value.playedDays, entered.value.today) };
  };
}

export type ReadOrbit = ReturnType<typeof makeReadOrbit>;
