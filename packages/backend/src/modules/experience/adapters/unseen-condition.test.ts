import { describe, expect, it } from 'vitest';
import type { PersonalScopeTx } from '../../identity/public.js';
import { unseenUnitCondition } from './unseen-condition.js';

const scope = {
  authority: {
    universeId: '6f9a0b1c-0000-4000-8000-000000000001',
    privacyEpoch: 2,
    actor: { kind: 'system', purpose: 'ci' },
  },
} as unknown as PersonalScopeTx;

describe('the condition that holds for an explanation the person has not met', () => {
  const condition = unseenUnitCondition(scope);

  it('is bound to this person’s own scope and nobody else’s', () => {
    expect(condition.values).toEqual(['6f9a0b1c-0000-4000-8000-000000000001', 2]);
  });

  it('probes both places a met explanation is recorded, by the person’s own indexes, in either format', () => {
    expect(condition.text).toContain('experience.encounter_lineage');
    expect(condition.text).toContain('experience.recording_segments');
    // The unit, never an asset: a Reel and its Scroll twin are one explanation.
    expect(condition.text).toContain('explanation_unit_id = {unit}');
    expect(condition.text).not.toContain('asset_id');
    expect(condition.text).toContain('first_eligible_activation_at is not null');
  });

  it('uses only the slots and characters the Content renderer accepts', () => {
    expect(condition.text).toMatch(/^[A-Za-z0-9_.(),:<>=\s{}]+$/);
    expect(
      [...condition.text.matchAll(/\{(\d|unit)\}/g)].every(([, slot]) => slot === 'unit' || Number(slot) < 2),
    ).toBe(true);
  });
});
