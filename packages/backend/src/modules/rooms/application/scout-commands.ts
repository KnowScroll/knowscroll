import {
  RoomScoutAcceptanceSchema,
  SetRoomScoutSchema,
  type RoomScout,
  type RoomScoutChoice,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { CatalogueSnapshot } from '../../content/public.js';
import type { PersonalAuthority } from '../../identity/public.js';
import { interestsProblem } from '../domain/scout.js';
import { receiptBase, runCommand } from './command.js';
import { ok, refuse, type Result, type RoomLock, type RoomPorts } from './ports.js';

/**
 * The topics of a room that a member may send a scout to look in (D-260): the planets of a system room, or the planet of a planet
 * room, each with its plain label. The catalogue is the only source; nothing about the member is read to fill it in.
 */
export function roomTopicChoices(
  catalogue: CatalogueSnapshot,
  topic: {
    readonly kind: 'system' | 'planet';
    readonly id: string;
  },
): RoomScoutChoice[] {
  const planet = catalogue.concept(topic.id);
  const planets =
    topic.kind === 'system'
      ? catalogue.children(topic.id)
      : planet?.kind === 'topic' && planet.servable
        ? [planet]
        : [];
  return planets.map((concept) => ({ id: concept.id, label: concept.label }));
}

/**
 * The reader's own scout in a room, as the sheet shows it: the topics to choose from and, when one was sent, its settings and
 * whether a moderator stopped it. Only its owner is told any of this.
 */
export async function scoutViewOf(
  p: RoomPorts,
  lock: RoomLock,
  accountId: string,
  topic: { readonly kind: 'system' | 'planet'; readonly id: string },
): Promise<RoomScout> {
  const choices = roomTopicChoices(await p.catalogue.current(), topic);
  const scout = await p.scouts.scoutOf(lock, accountId);
  if (scout === undefined) return { state: 'none', choices };
  const lastPost = await p.scouts.lastPostOf(lock, accountId);
  const recording = await p.scouts.recordingOn(lock, accountId);
  return {
    state: 'on',
    choices,
    interests: [...scout.interests],
    cadence: scout.cadence,
    paused: scout.paused,
    stopped: scout.stopped,
    ...(recording ? {} : { recordingPaused: true as const }),
    ...(lastPost === undefined ? {} : { lastPostedAt: lastPost.toISOString() }),
  };
}

/** A member's own scout in a room (v3 R-9, D-259 to D-261). */
export function makeScoutCommands(p: RoomPorts) {
  return {
    /**
     * Sends the caller's scout into the room, changes it, pauses it, or takes it back (`scout: null`). The topics are the
     * caller's own choice among the room's, checked here against the room's topics; nothing of the caller is read to fill them
     * in, and nothing here starts an encounter or records evidence. Needs a current member and scouts switched on in this
     * world. The same command again is accepted; a moderator's stop is kept through any change the owner makes.
     */
    setScout(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomScoutAcceptanceSchema>>> {
      const parsed = SetRoomScoutSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.scout-set',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: RoomScoutAcceptanceSchema,
        requires: 'member',
        mode: 'read',
        async decide({ scope, entered, now }) {
          if (!p.scoutsEnabled) return refuse('unavailable');
          const { lock, owner, standing } = entered;
          const { topic } = standing.room;
          const chosen = command.scout;
          const catalogue = await p.catalogue.current();
          if (
            chosen !== null &&
            interestsProblem(
              chosen.interests,
              roomTopicChoices(catalogue, topic).map((choice) => choice.id),
            ) !== undefined
          )
            return refuse('invalid_input');
          return ok(async () => {
            if (chosen === null) await p.scouts.takeBack(lock, owner.accountId, now);
            else
              await p.scouts.save(lock, {
                scoutId: p.newId(),
                accountId: owner.accountId,
                interests: chosen.interests,
                cadence: chosen.cadence,
                paused: chosen.paused,
                now,
              });
            return RoomScoutAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'room.scout-set',
              roomId: command.roomId,
              scout: await scoutViewOf(p, lock, owner.accountId, topic),
            });
          });
        },
      });
    },
  };
}
