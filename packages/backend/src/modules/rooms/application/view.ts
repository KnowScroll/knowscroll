import {
  AI_INHABITANT_BLURBS,
  AI_INHABITANT_LABELS,
  type RoomInhabitant,
  type RoomSummary,
} from '@knowscroll/contracts';
import { conceptLabel } from '../../content/public.js';
import type { InhabitantId } from '../domain/contribution.js';
import type { RoomRow } from './ports.js';

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

/** The labelled AI inhabitants a room has. The label comes from the role, never from a message. */
export function inhabitantsOf(inhabitants: readonly InhabitantId[]): RoomInhabitant[] {
  return inhabitants.map((inhabitant) => ({
    inhabitant,
    label: AI_INHABITANT_LABELS[inhabitant],
    blurb: AI_INHABITANT_BLURBS[inhabitant],
  }));
}
