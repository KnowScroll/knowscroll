import { CONCEPTS, conceptLabel } from '../../content/public.js';
import { DEFAULT_CAST } from '../domain/cast.js';
import type { RoomSeed } from './seeds.js';

const GUIDELINES = 'Be kind, say what you are unsure about, and keep personal details out.';

/**
 * One room for each library system, and nothing else: no member, no message, no moderator. The
 * operator seeds this list (idempotently, by slug); people join it, and the operator names a
 * moderator for it. The AI residents are part of the room's definition and always labelled; they speak
 * when a member asks and, under the room's caps, on their own once people are talking, so a seeded room is
 * an honestly empty room.
 */
export function libraryRoomSeeds(): readonly RoomSeed[] {
  return CONCEPTS.filter((concept) => concept.parent === null).map((system) => ({
    slug: system.id,
    name: `${conceptLabel(system.id)} room`,
    description: `${system.meaning} Bring questions, Reels and half-formed ideas.`,
    guidelines: GUIDELINES,
    topic: { kind: 'system', id: system.id },
    joinRule: 'open',
    cast: DEFAULT_CAST,
  }));
}
