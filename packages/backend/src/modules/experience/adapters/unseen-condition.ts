import type { ReadUnseenCondition } from '../../composer/public.js';

/**
 * The condition that holds for an explanation unit the person has NOT met, as Content's retrieval applies it (policy v2, D-408).
 * Met is the notion `readRoutingHistory` reports as `encountered`: an activated exposure of the unit in either format, in the
 * person's own lineage or in a recording segment with a first eligible activation, at or before now. Each probe is a
 * person-scoped index lookup (`lineage_unit_idx`, `recording_routing_unit`), so retrieval can ask it of every row it reads.
 * Content only renders this text over its own unit column: it reads no personal table.
 */
export const unseenUnitCondition: ReadUnseenCondition = (scope) => ({
  text:
    'not exists (select 1 from experience.encounter_lineage l where l.universe_id = {0}::uuid and l.privacy_epoch = {1} ' +
    'and l.explanation_unit_id = {unit} and l.activated_at <= now()) ' +
    'and not exists (select 1 from experience.recording_segments s where s.universe_id = {0}::uuid and s.privacy_epoch = {1} ' +
    'and s.explanation_unit_id = {unit} and s.first_eligible_activation_at is not null and s.first_eligible_activation_at <= now())',
  values: [scope.authority.universeId, scope.authority.privacyEpoch],
});
