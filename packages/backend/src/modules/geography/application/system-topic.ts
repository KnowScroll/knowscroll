import { z } from 'zod';
import { semanticKey } from '../domain/policy.js';
import type { ReadOwnSystemTopic, RegionConstraintPorts } from './ports.js';

const Place = z.object({
  id: z.uuid(),
  key: z.string().min(1).max(240),
  kind: z.enum(['system', 'star', 'planet', 'region']),
  conceptId: z.string().min(1).max(160),
  parentKey: z.string().min(1).max(240),
  truthStatus: z.enum(['factual', 'hypothetical']),
  objectRevision: z.number().int().min(1).max(2147483647),
});

/**
 * The catalogue topic of one of the caller's own established factual systems (#697), so its Reels and Scrolls can be
 * listed before it has a planet. The existing personal root is the fence; it reads one object by id and writes nothing.
 * A foreign, unknown, hypothetical or non-system id answers `not_on_map` alike, and a stored row that no longer matches
 * the catalogue answers `temporarily_unavailable`, never a guessed topic.
 */
export function makeReadOwnSystemTopic(p: RegionConstraintPorts): ReadOwnSystemTopic {
  return async (scope, systemId) => {
    if (!z.uuid().safeParse(systemId).success) return { kind: 'unavailable', reason: 'not_on_map' };
    if (!(await p.ownerActive(scope))) return { kind: 'refused' };
    const state = await p.state(scope);
    const raw = await p.object(scope, { id: systemId });
    if (raw === undefined) return { kind: 'unavailable', reason: 'not_on_map' };
    const parsed = Place.safeParse(raw);
    if (!parsed.success) return { kind: 'unavailable', reason: 'temporarily_unavailable' };
    const system = parsed.data;
    if (system.id !== systemId || system.kind !== 'system' || system.truthStatus !== 'factual')
      return { kind: 'unavailable', reason: 'not_on_map' };
    if (
      system.parentKey !== 'universe' ||
      system.key !== semanticKey(system.kind, system.conceptId, system.truthStatus) ||
      system.objectRevision > state.revision ||
      (await p.catalogue.current()).concept(system.conceptId)?.parent !== null
    )
      return { kind: 'unavailable', reason: 'temporarily_unavailable' };
    return { kind: 'read', systemId: system.id, topicId: system.conceptId };
  };
}
