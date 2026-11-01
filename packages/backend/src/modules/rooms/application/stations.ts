import { ReadRoomStationsSchema, RoomStationsSchema } from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { placementsOf } from '../domain/stations.js';
import { skyOf } from '../domain/sky.js';
import { ok, refuse, roomEnvelope, type Result, type RoomPorts, type SkyFigures } from './ports.js';
import { roomSummary } from './view.js';

/**
 * The room stations of the caller's own map (U01, U02): the rooms of topics their Geography has
 * established, each placed beside that system or planet. It reads the caller's own map through
 * Geography's public port and the room rows without locking any room: a station is a doorway to the
 * preview, so it shows no member, count or activity. A member's or moderator's station also carries the room's sky
 * (stars lit, finished constellations, the name), which names no person (D-176). A person with no map has no stations, and no
 * placement is stored: it is read afresh from the map each time, so it never drifts from it.
 */
export function makeStationReads(p: RoomPorts) {
  return {
    async stations(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomStationsSchema>>> {
      const parsed = ReadRoomStationsSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const result = await p.withScope(authority, async (scope) => {
        if (scope.authority.actor.kind !== 'account') return refuse('unavailable');
        const gate = await p.fenceOwn(scope);
        if (gate.kind !== 'active') return refuse('unavailable');
        const map = await p.readGeography(scope);
        const placements = map.kind === 'read' ? placementsOf(map.input.objects) : [];
        const rows =
          placements.length === 0
            ? []
            : await p.rooms.forTopics(
                scope,
                gate.owner.accountId,
                placements.map((place) => place.topic),
              );
        // The sky is a member's to see: an outsider's or an invitee's station is drawn as it was, with no sky (D-174).
        const skies = await p.sky.figures(
          scope,
          rows.filter((row) => row.standing === 'member' || row.standing === 'moderator').map((row) => row.room.roomId),
        );
        // A Launch or a Reel watched together that is on shows on a member's station too, and on no one else's: a room's activity is
        // for those who joined it. The station says which of the two is on (D-268), never who or how many.
        const memberRooms = rows
          .filter((row) => row.standing === 'member' || row.standing === 'moderator')
          .map((row) => row.room.roomId);
        const now = p.now();
        const launching = await p.launches.liveRooms(scope, memberRooms, now);
        const watching = await p.watches.liveRooms(scope, memberRooms, now);
        const stations = rows.flatMap((row) => {
          const place = placements.find(
            (candidate) => candidate.topic.kind === row.room.topic.kind && candidate.topic.id === row.room.topic.id,
          );
          if (place === undefined) return [];
          return [
            {
              room: roomSummary(row.room),
              standing: row.standing,
              placement: {
                systemId: place.systemId,
                ...(place.planetId === undefined ? {} : { planetId: place.planetId }),
              },
              ...skyFor(skies.get(row.room.roomId)),
              ...liveFor(launching.has(row.room.roomId), watching.has(row.room.roomId)),
            },
          ];
        });
        return ok(
          RoomStationsSchema.parse({ ...roomEnvelope(scope), readId: parsed.data.readId, status: 'ready', stations }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },
  };
}

/** A room holds one thing on its stage at a time (D-257); if both ever showed, the Launch is the one with a clock running. */
const liveFor = (launching: boolean, watching: boolean) =>
  launching ? { live: 'launch' as const } : watching ? { live: 'reel' as const } : {};

const skyFor = (figures: SkyFigures | undefined) => (figures === undefined ? {} : { sky: skyOf(figures) });
