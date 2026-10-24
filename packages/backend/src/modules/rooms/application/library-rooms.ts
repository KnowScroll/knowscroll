import { CONCEPTS, conceptLabel } from '../../content/public.js';
import type { RoomSeed } from './seeds.js';

const GUIDELINES = 'Be kind, say what you are unsure about, and keep personal details out.';

/**
 * One room for each library system, and nothing else: no member, no message, no moderator. The
 * operator seeds this list (idempotently, by slug); people join it, and the operator names a
 * moderator for it. The AI inhabitants are part of the room's definition, labelled, and speak only
 * when a member asks, so a seeded room is an honestly empty room.
 */
export function libraryRoomSeeds(): readonly RoomSeed[] {
  return CONCEPTS.filter((concept) => concept.parent === null).map((system) => ({
    slug: system.id,
    name: `${conceptLabel(system.id)} room`,
    description: `${system.meaning} Bring questions, Reels and half-formed ideas.`,
    guidelines: GUIDELINES,
    topic: { kind: 'system', id: system.id },
    joinRule: 'open',
    inhabitants: ['explainer', 'skeptic'],
  }));
}
