import {
  AI_INHABITANT_BLURBS,
  AI_INHABITANT_LABELS,
  type RoomIdentity,
  type RoomInhabitant,
  type RoomLimits,
  type RoomSummary,
  type RoomYou,
} from '@knowscroll/contracts';
import { conceptLabel } from '../../content/public.js';
import type { CastMember } from '../domain/cast.js';
import { PERSON_ASKS_PER_HOUR, ROOM_ASKS_PER_DAY } from '../domain/contribution.js';
import { UNPROMPTED_CAPS } from '../domain/router.js';
import { kitToShow } from './kit.js';
import type { MemberRow, RoomRow } from './ports.js';

/**
 * The face a room shows (D-170): its approved kit if it still validates, else the default its ID gives it, and the
 * address of its approved backdrop when it has one. A stored value never reaches a client unchecked.
 */
export function identityOf(room: RoomRow): RoomIdentity {
  return {
    kit: kitToShow(room.face.kit, room.roomId),
    ...(room.face.backdropSha256 === null ? {} : { backdrop: { path: `/media/room/${room.face.backdropSha256}` } }),
  };
}

/** A room as lists and previews name it. No member, activity or online count. */
export function roomSummary(room: RoomRow): RoomSummary {
  return {
    roomId: room.roomId,
    name: room.name,
    description: room.description,
    topic: { kind: room.topic.kind, id: room.topic.id, label: conceptLabel(room.topic.id) },
    joinRule: room.joinRule,
    status: room.status,
    identity: identityOf(room),
  };
}

/** The labelled AI inhabitants a room has, with the names they go by. The label comes from the role, never from a message. */
export function inhabitantsOf(cast: readonly CastMember[]): RoomInhabitant[] {
  return cast.map(({ inhabitant, name }) => ({
    inhabitant,
    name,
    label: AI_INHABITANT_LABELS[inhabitant],
    blurb: AI_INHABITANT_BLURBS[inhabitant],
  }));
}

/** The caller's own settings in a room as the contract names them. */
export const youOf = (member: MemberRow): RoomYou => ({
  aiLevel: member.aiLevel,
  keepOut: member.keepOut,
  ...(member.noticeSeenAt === null ? {} : { noticeSeenAt: member.noticeSeenAt.toISOString() }),
});

/**
 * What the room's AI may do, from the same constants the bounds and the router use, so the room menu can never say
 * one thing while the rules do another (D-068, D-167).
 */
export function limitsOf(): RoomLimits {
  return {
    asked: { perPersonPerHour: PERSON_ASKS_PER_HOUR, perRoomPerDay: ROOM_ASKS_PER_DAY },
    unprompted: {
      humanMessagesPerTurn: UNPROMPTED_CAPS.humanMessagesPerTurn,
      perHour: UNPROMPTED_CAPS.roomPerHour,
      perDay: UNPROMPTED_CAPS.roomPerDay,
      explainerPerHour: UNPROMPTED_CAPS.residentPerHour.explainer,
      skepticPerHour: UNPROMPTED_CAPS.residentPerHour.skeptic,
    },
  };
}
