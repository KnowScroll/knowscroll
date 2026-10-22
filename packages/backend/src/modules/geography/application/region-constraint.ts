import { z } from 'zod';
import { RegionEncounterTargetSchema } from '@knowscroll/contracts';
import { CONCEPTS, CONCEPT_CATALOGUE_VERSION } from '../../content/public.js';
import { semanticKey } from '../domain/policy.js';
import type { ReadOwnRegionConstraint, RegionConstraintPorts, GeographyRegionConstraint } from './ports.js';

/** Persisted authority snapshot syntax; validation never grants current Geography authority. */
export const GeographyRegionConstraintSchema: z.ZodType<GeographyRegionConstraint> = z.strictObject({
  version: z.literal('geography-region-constraint.v1'),
  target: RegionEncounterTargetSchema,
  planetId: z.uuid(),
  planetObjectRevision: z.number().int().min(1).max(2147483647),
  systemId: z.uuid(),
  topicId: z.string().min(1).max(160),
  facetId: z.string().min(1).max(160),
  truthStatus: z.literal('factual'),
  catalogueVersion: z.literal('content-concepts.v1'),
});

const Label = z.string().min(1).max(160);
const Place = z.object({
  id: z.uuid(),
  key: z.string().min(1).max(240),
  kind: z.enum(['system', 'star', 'planet', 'region']),
  conceptId: z.string().min(1).max(160),
  parentKey: z.string().min(1).max(240),
  truthStatus: z.enum(['factual', 'hypothetical']),
  label: Label,
  labels: z.array(Label).max(32),
  objectRevision: z.number().int().min(1).max(2147483647),
});

/** Existing personal root is the fence. Reads exactly region -> planet -> system, no writes.
 * Aliases/hypothetical meaning cannot silently redirect into the current factual policy. */
export function makeReadOwnRegionConstraint(p: RegionConstraintPorts): ReadOwnRegionConstraint {
  return async (scope, input) => {
    const target = RegionEncounterTargetSchema.parse(input);
    if (!(await p.ownerActive(scope))) return { kind: 'refused' };
    const state = await p.state(scope);
    const unavailable = (reason: 'stale_target' | 'unsupported_region' | 'temporarily_unavailable') =>
      ({ kind: 'unavailable', reason, geographyRevision: state.revision }) as const;
    if (state.revision !== target.expectedGeographyRevision) return unavailable('stale_target');
    const raw = await p.object(scope, { id: target.regionId });
    if (raw === undefined) return unavailable('stale_target');
    const parsed = Place.safeParse(raw);
    if (!parsed.success) return unavailable('temporarily_unavailable');
    const region = parsed.data;
    if (region.id !== target.regionId || region.objectRevision !== target.expectedObjectRevision)
      return unavailable('stale_target');
    if (region.kind !== 'region' || region.truthStatus !== 'factual') return unavailable('unsupported_region');
    const planetRead = Place.safeParse(await p.object(scope, { key: region.parentKey }));
    if (!planetRead.success) return unavailable('temporarily_unavailable');
    const planet = planetRead.data;
    const topic = CONCEPTS.find((t) => t.id === planet.conceptId);
    if (
      planet.kind !== 'planet' ||
      planet.truthStatus !== 'factual' ||
      planet.key !== region.parentKey ||
      !topic?.parent ||
      !topic.facets.some((f) => f.id === region.conceptId)
    )
      return unavailable('unsupported_region');
    const systemRead = Place.safeParse(await p.object(scope, { key: planet.parentKey }));
    if (!systemRead.success) return unavailable('temporarily_unavailable');
    const system = systemRead.data;
    if (
      system.kind !== 'system' ||
      system.truthStatus !== 'factual' ||
      system.key !== planet.parentKey ||
      system.conceptId !== topic.parent ||
      system.parentKey !== 'universe' ||
      !CONCEPTS.some((t) => t.id === system.conceptId && t.parent === null)
    )
      return unavailable('unsupported_region');
    const places = [region, planet, system];
    if (
      new Set(places.map((o) => o.id)).size !== 3 ||
      places.some(
        (o) =>
          o.key !== semanticKey(o.kind, o.conceptId, o.truthStatus) ||
          o.objectRevision > state.revision ||
          !o.labels.includes(o.label),
      )
    )
      return unavailable('temporarily_unavailable');
    return {
      kind: 'read',
      constraint: {
        version: 'geography-region-constraint.v1',
        target: { ...target },
        planetId: planet.id,
        planetObjectRevision: planet.objectRevision,
        systemId: system.id,
        topicId: topic.id,
        facetId: region.conceptId,
        truthStatus: 'factual',
        catalogueVersion: CONCEPT_CATALOGUE_VERSION,
      },
    };
  };
}
