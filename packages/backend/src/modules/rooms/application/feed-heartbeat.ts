import type { ProductionReasoningHarness, WithProductionScope } from '../../../reasoning/public.js';
import type { FeedRoomRef } from './feed-ports.js';
import { makeFeedPass, type FeedPassPorts, type FindLook } from './feed-pass.js';
import { makeMemoryRefresh, type MemoryLook } from './memory-refresh.js';

/** The most rooms one heartbeat looks at. A dev world has a handful; this bounds a world that grows. */
const ROOMS_PER_HEARTBEAT = 200;

/** What a heartbeat did for one room: its memory first, then a find. */
export interface RoomLook {
  readonly room: string;
  readonly memory: MemoryLook;
  readonly find: FindLook;
}

export interface FeedHeartbeat {
  /** One look at one room, as the heartbeat makes it. An operator names the room. */
  lookAt(room: FeedRoomRef, signal: AbortSignal): Promise<RoomLook>;
  /**
   * The heartbeat (v3 R-8, D-248): every open room that has a resident and a member whose AI is not Off, one after another.
   * Throws after the loop when any room failed, so the job retries; everything a look stores is idempotent by (room, kind,
   * slot), so a retry only finishes what the first run could not and pays for nothing twice.
   */
  lookAtAll(input: {
    readonly signal: AbortSignal;
    /** Told which room failed and why, so the job's log names it; the other rooms are still looked at. */
    readonly onRoomFailed?: (slug: string, error: unknown) => void;
  }): Promise<readonly RoomLook[]>;
  roomBySlug(slug: string): Promise<FeedRoomRef | undefined>;
}

/**
 * Residents check in on a rhythm, not when someone pokes them (T3 "Heartbeat"): three times a day, a resident looks at each room
 * that has someone listening. A look first writes the room's memory again when it is due, then posts a find when the library has
 * something new for the room, a resident's rest is over and the caps allow it. A room nobody listens to, with nothing new and
 * nothing due, costs no call.
 */
export function makeFeedHeartbeat(
  p: FeedPassPorts,
  harness: ProductionReasoningHarness,
  withRoomScope: WithProductionScope,
): FeedHeartbeat {
  const lookForFind = makeFeedPass(p, harness, withRoomScope);
  const refreshMemory = makeMemoryRefresh(p, harness, withRoomScope);

  async function lookAt(room: FeedRoomRef, signal: AbortSignal): Promise<RoomLook> {
    const memory = await refreshMemory(room, signal);
    const find = await lookForFind(room, { kind: 'residents' }, signal);
    return { room: room.slug, memory, find };
  }

  return {
    lookAt,

    async lookAtAll({ signal, onRoomFailed }) {
      const looks: RoomLook[] = [];
      let failed = 0;
      for (const room of await p.store.roomsToLook(ROOMS_PER_HEARTBEAT)) {
        try {
          looks.push(await lookAt(room, signal));
        } catch (error) {
          failed += 1;
          onRoomFailed?.(room.slug, error);
        }
      }
      if (failed > 0) throw new Error(`ROOMS_FEED_ROOMS_FAILED: ${String(failed)}`);
      return looks;
    },

    roomBySlug: (slug) => p.store.roomBySlug(slug),
  };
}
