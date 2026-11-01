import type { CheckPersonalOwnerActive, PersonalAuthority } from '../../identity/public.js';
import type { LaunchSettleJob } from '../events.js';
import { settleLaunches } from './launch.js';
import type { RoomPorts } from './ports.js';

/** The worker's consumer of `rooms.launch-settle`. */
export type LaunchSettle = (job: LaunchSettleJob) => Promise<void>;

export interface LaunchSettlePorts extends RoomPorts {
  readonly ownerActive: CheckPersonalOwnerActive;
}

/**
 * Settles a Launch when its play time has ended, with no device asking (D-178, D-298): it is marked finished once, the room earns
 * its star when two people answered, and the room hears of it so a podium on screen can say so.
 *
 * Authority: the worker acts as a system actor for the universe and epoch of the member who started the Launch, only to take the
 * room lock in the blueprint's order and to stop when that person is gone (a deleted account or a privacy reset ends the job). A
 * Launch it leaves is settled by the room's next member command, counted from its end exactly as this would have.
 *
 * Failure/retry: a Launch that is not the room's latest one, is already finished or is not over yet is left alone, so a
 * redelivery or an early run changes nothing. No model is called and no network is waited on.
 */
export function makeLaunchSettle(p: LaunchSettlePorts): LaunchSettle {
  return async (job) => {
    const authority: PersonalAuthority = {
      universeId: job.universeId,
      privacyEpoch: job.privacyEpoch,
      actor: { kind: 'system', purpose: 'rooms.launch-settle' },
    };
    await p.withScope(authority, async (scope) => {
      if (!(await p.ownerActive(scope))) return;
      const lock = await p.rooms.lock(scope, job.roomId, 'write');
      if (!lock) return;
      const latest = await p.launches.latest(lock);
      if (latest?.launchId !== job.launchId) return;
      await settleLaunches(p, lock, (await p.rooms.roomRow(lock)).topic.id, p.now());
    });
  };
}
