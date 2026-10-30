import {
  AI_INHABITANT_BLURBS,
  AI_INHABITANT_LABELS,
  type RoomInhabitant,
  type RoomSummary,
  type RoomYou,
} from '@knowscroll/contracts';
import { conceptLabel } from '../../content/public.js';
import type { CastMember } from '../domain/cast.js';
import type { MemberRow, RoomRow } from './ports.js';

/** A room as lists and previews name it. No member, activity or online count. */
export function roomSummary(room: RoomRow): RoomSummary {
  return {
    roomId: room.roomId,
    name: room.name,
    description: room.description,
    topic: { kind: room.topic.kind, id: room.topic.id, label: conceptLabel(room.topic.id) },
    joinRule: room.joinRule,
    status: room.status,
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
