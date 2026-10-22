/** Authored source fixtures only: no real Geography formation or client shown assertion. */
import { describe, it, expect, vi } from 'vitest';
import { formationOfCommitted, makeRecordFormation } from './formation-presentation.js';
import { RecoverFormationJobSchema, ProjectSceneJobSchema } from '../events.js';
import type { GeographyApplied } from '../../geography/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const input: Parameters<GeographyApplied>[1] = {
  transitionId: id(1),
  geography: { revision: 1, structureRevision: 1, activityRevision: 0 },
  personalRevision: 1,
  committedCreations: {
    recordedAt: '2026-10-22T00:00:00.000Z',
    targets: [
      {
        operation: 'create_system',
        objectId: id(2),
        parentId: id(9),
        kind: 'system',
        objectRevision: 1,
        label: 'Earth',
        truthStatus: 'factual',
      },
      {
        operation: 'establish_star',
        objectId: id(3),
        parentId: id(2),
        kind: 'star',
        objectRevision: 1,
        label: 'Earth star',
        truthStatus: 'factual',
      },
      {
        operation: 'form_planet',
        objectId: id(4),
        parentId: id(2),
        kind: 'planet',
        objectRevision: 1,
        label: 'Seasons',
        truthStatus: 'factual',
      },
    ],
  },
};
describe('actual creation delivery policy', () => {
  it('enables full planet/new-system only with exact same-commit system and star', () => {
    expect(formationOfCommitted(input)?.fact?.sequence).toEqual({
      kind: 'planet',
      planetId: id(4),
      durationMs: 2400,
      newSystem: { systemId: id(2), starId: id(3) },
    });
    const targets = input.committedCreations!.targets.filter((t) => t.kind !== 'star');
    expect(
      formationOfCommitted({ ...input, committedCreations: { ...input.committedCreations!, targets } })?.fact?.sequence,
    ).toEqual({ kind: 'planet', planetId: id(4), durationMs: 2400 });
    const oldParent = targets.map((t) => (t.kind === 'planet' ? { ...t, parentId: id(8) } : t));
    expect(
      formationOfCommitted({ ...input, committedCreations: { ...input.committedCreations!, targets: oldParent } })?.fact
        ?.sequence,
    ).not.toHaveProperty('newSystem');
  });
  it('records no activity/label/route/historical callback as creation; never truncates ninth target', async () => {
    const record = vi.fn();
    const callback = makeRecordFormation({ record });
    await callback({} as PersonalScopeTx, { transitionId: id(1), geography: input.geography, personalRevision: 1 });
    expect(record).not.toHaveBeenCalled();
    const targets = Array.from({ length: 9 }, (_, i) => ({
      ...input.committedCreations!.targets[0]!,
      objectId: id(20 + i),
    }));
    const value = formationOfCommitted({ ...input, committedCreations: { ...input.committedCreations!, targets } });
    expect(value).toMatchObject({ limit: true, targetCount: 9 });
    expect(value).not.toHaveProperty('fact');
  });
  it('rejects contradictory identity and keeps original strict projection queue closed', () => {
    expect(() =>
      formationOfCommitted({
        ...input,
        committedCreations: {
          ...input.committedCreations!,
          targets: [input.committedCreations!.targets[0]!, input.committedCreations!.targets[0]!],
        },
      }),
    ).toThrow('FORMATION_COMMITTED_IDENTITY');
    expect(ProjectSceneJobSchema.safeParse({ v: 1, universeId: id(9), privacyEpoch: 1, ...input }).success).toBe(false);
  });
  it('admits only finite strictly advancing bigint ordinal cursors, with no personal payload', () => {
    expect(RecoverFormationJobSchema.parse({ v: 1 })).toEqual({ v: 1 });
    expect(RecoverFormationJobSchema.parse({ v: 1, afterKey: '1', throughKey: '9223372036854775807' })).toBeDefined();
    for (const q of [
      { v: 1, afterKey: '2', throughKey: '2' },
      { v: 1, afterKey: '01', throughKey: '2' },
      { v: 1, afterKey: '1', throughKey: '9223372036854775808' },
      { v: 1, universeId: id(9) },
    ])
      expect(RecoverFormationJobSchema.safeParse(q).success).toBe(false);
  });
});
