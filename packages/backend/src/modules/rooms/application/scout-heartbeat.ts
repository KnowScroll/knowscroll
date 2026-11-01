import type { ProductionReasoningHarness, WithProductionScope } from '../../../reasoning/public.js';
import { SCOUT_RULES } from '../domain/scout.js';
import type { ScoutRef } from './feed-ports.js';
import { makeFeedPass, type FeedPassPorts, type FindLook } from './feed-pass.js';

/** What the heartbeat did for one scout. It names the room and never the owner. */
export interface ScoutLook {
  readonly room: string;
  readonly find: FindLook;
}

export interface ScoutHeartbeat {
  /** One look for one scout, as the heartbeat makes it. An operator names the room and the owner. */
  lookAt(scout: ScoutRef, signal: AbortSignal): Promise<ScoutLook>;
  /**
   * The scouts' heartbeat (v3 R-9, D-259): every scout that may post, one after another, the one that posted longest ago first. Throws after
   * the loop when any look failed, so the job retries; a look is idempotent by (room, owner, slot), so a retry only finishes
   * what the first run could not and pays for nothing twice.
   */
  lookAtAll(input: {
    readonly signal: AbortSignal;
    /** Told which room failed and why, so the job's log names it; the other scouts are still looked at. */
    readonly onScoutFailed?: (slug: string, error: unknown) => void;
  }): Promise<readonly ScoutLook[]>;
  scoutIn(slug: string, ownerHandle: string): Promise<ScoutRef | undefined>;
}

/**
 * Scouts check in on the same rhythm as residents, three times a day, each looking for one find for its owner's chosen topics.
 * A scout that is paused, stopped, resting, whose owner left or paused recording, whose room nobody listens to, or for which the
 * library holds nothing new in its topics makes no call. It is the residents' pass (`makeFeedPass`) with another author.
 */
export function makeScoutHeartbeat(
  p: FeedPassPorts,
  harness: ProductionReasoningHarness,
  withRoomScope: WithProductionScope,
): ScoutHeartbeat {
  const lookForFind = makeFeedPass(p, harness, withRoomScope);

  async function lookAt(scout: ScoutRef, signal: AbortSignal): Promise<ScoutLook> {
    const find = await lookForFind(
      scout.room,
      { kind: 'scout', ownerAccountId: scout.ownerAccountId, interests: scout.interests },
      signal,
    );
    return { room: scout.room.slug, find };
  }

  return {
    lookAt,

    async lookAtAll({ signal, onScoutFailed }) {
      const looks: ScoutLook[] = [];
      let failed = 0;
      for (const scout of await p.store.scoutsToLook(SCOUT_RULES.scoutsPerHeartbeat)) {
        try {
          looks.push(await lookAt(scout, signal));
        } catch (error) {
          failed += 1;
          onScoutFailed?.(scout.room.slug, error);
        }
      }
      if (failed > 0) throw new Error(`ROOMS_SCOUTS_FAILED: ${String(failed)}`);
      return looks;
    },

    scoutIn: (slug, ownerHandle) => p.store.scoutIn(slug, ownerHandle),
  };
}
