import { describe, expect, it } from 'vitest';
import type { PersonalRecordingPurpose } from '../../../reasoning/public.js';
import type { PersonalScopeTx, RecordingScopeTx } from '../../identity/public.js';
import { makeCheckScenariosRecordingRun } from './check-recording-run.js';
import type { DraftRow, NodeRow } from './ports.js';

const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const UNIVERSE = id(1);
const DRAFT = id(40);
const NODE = id(50);

/** A Scenarios proof, with fields overridden: some tests build pairs the type would not allow, to see them refused. */
const purpose = (over: Record<string, unknown> = {}): PersonalRecordingPurpose => ({
  version: 'personal-role-purpose.v1',
  accountId: id(2),
  universeId: UNIVERSE,
  privacyEpoch: 1,
  ownerModule: 'scenarios',
  purpose: 'suggest',
  businessRunId: DRAFT,
  recordingGeneration: 3,
  contextSha256: 'a'.repeat(64),
  modelContextSha256: 'a'.repeat(64),
  claimId: DRAFT,
  ...over,
});
const scopeAt = (generation: number, universeId = UNIVERSE, privacyEpoch = 1) =>
  ({
    generation,
    personal: { authority: { universeId, privacyEpoch, actor: { kind: 'system', purpose: 'scenarios.suggest' } } },
  }) as unknown as RecordingScopeTx;

const draft = (over: Partial<DraftRow> = {}): DraftRow =>
  ({ draftId: DRAFT, state: 'thinking', requesterUniverseId: UNIVERSE, ...over }) as unknown as DraftRow;
const node = (over: Partial<NodeRow> = {}): NodeRow =>
  ({ nodeId: NODE, kind: 'what_if', status: 'preparing', answer: { state: 'making' }, ...over }) as unknown as NodeRow;

function checkWith(draftRow: DraftRow | undefined, nodeRow: NodeRow | undefined) {
  return makeCheckScenariosRecordingRun({
    store: {
      readDraft: (_scope: PersonalScopeTx, key: string) => Promise.resolve(key === DRAFT ? draftRow : undefined),
      readNode: (_scope: PersonalScopeTx, key: string) => Promise.resolve(key === NODE ? nodeRow : undefined),
    },
  });
}

describe('the owner check of Scenarios’ recording runs (D-270)', () => {
  it('finds the planner’s run current while its draft is still being thought about', async () => {
    expect(await checkWith(draft(), undefined)(scopeAt(3), purpose())).toBe('current');
  });

  it('finds the planner’s run unavailable once the draft is answered, chosen, failed or gone, or is another’s', async () => {
    for (const state of ['ready', 'failed', 'chosen'] as const)
      expect(await checkWith(draft({ state }), undefined)(scopeAt(3), purpose())).toBe('unavailable');
    expect(await checkWith(undefined, undefined)(scopeAt(3), purpose())).toBe('unavailable');
    expect(await checkWith(draft({ requesterUniverseId: id(9) }), undefined)(scopeAt(3), purpose())).toBe(
      'unavailable',
    );
  });

  it('finds the writer’s run current while its what-if branch stands and the short answer is being written', async () => {
    const run = purpose({ purpose: 'answer', businessRunId: NODE, claimId: NODE });
    for (const status of ['preparing', 'ready', 'failed'] as const)
      expect(await checkWith(undefined, node({ status }))(scopeAt(3), run)).toBe('current');
  });

  it('finds the writer’s run unavailable once the answer is settled, the branch is removed, gone or not a what-if', async () => {
    const run = purpose({ purpose: 'answer', businessRunId: NODE, claimId: NODE });
    expect(
      await checkWith(undefined, node({ answer: { state: 'unavailable', settledAt: new Date() } }))(scopeAt(3), run),
    ).toBe('unavailable');
    expect(await checkWith(undefined, node({ answer: undefined }))(scopeAt(3), run)).toBe('unavailable');
    expect(await checkWith(undefined, node({ status: 'removed' }))(scopeAt(3), run)).toBe('unavailable');
    expect(await checkWith(undefined, node({ kind: 'perspective' }))(scopeAt(3), run)).toBe('unavailable');
    expect(await checkWith(undefined, undefined)(scopeAt(3), run)).toBe('unavailable');
  });

  it('keeps each step to its own record: a draft is not a branch and a branch is not a draft', async () => {
    const check = checkWith(draft(), node());
    expect(await check(scopeAt(3), purpose({ purpose: 'suggest', claimId: NODE }))).toBe('unavailable');
    expect(await check(scopeAt(3), purpose({ purpose: 'answer', claimId: DRAFT }))).toBe('unavailable');
  });

  it('finds a run unavailable for a step it does not list, another owner’s purpose, another universe, epoch or generation', async () => {
    const check = checkWith(draft(), node());
    expect(await check(scopeAt(3), purpose({ purpose: 'not-a-step' }))).toBe('unavailable');
    expect(await check(scopeAt(3), purpose({ ownerModule: 'supply', purpose: 'ask-scope' }))).toBe('unavailable');
    expect(await check(scopeAt(3, id(9)), purpose())).toBe('unavailable');
    expect(await check(scopeAt(3, UNIVERSE, 2), purpose())).toBe('unavailable');
    expect(await check(scopeAt(5), purpose())).toBe('unavailable');
    expect(await check(scopeAt(3), { ...purpose(), recordingGeneration: 4 })).toBe('unavailable');
    expect(await check(scopeAt(3), { ...purpose(), extra: true } as unknown as PersonalRecordingPurpose)).toBe(
      'unavailable',
    );
  });
});
