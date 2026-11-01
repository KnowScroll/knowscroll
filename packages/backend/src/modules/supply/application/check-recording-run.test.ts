import { describe, expect, it } from 'vitest';
import type { PersonalRecordingPurpose } from '../../../reasoning/public.js';
import type { PersonalScopeTx, RecordingScopeTx } from '../../identity/public.js';
import { makeCheckSupplyRecordingRun } from './check-recording-run.js';
import type { QuickAnswerRow } from './quick-answer-ports.js';
import type { Demand } from './ports.js';

const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const UNIVERSE = id(1);
const REQUEST = id(40);
const ANSWER = id(50);

/** A Supply proof, with fields overridden: some tests build pairs the type would not allow, to see them refused. */
const purpose = (over: Record<string, unknown> = {}): PersonalRecordingPurpose => ({
  version: 'personal-role-purpose.v1',
  accountId: id(2),
  universeId: UNIVERSE,
  privacyEpoch: 1,
  ownerModule: 'supply',
  purpose: 'ask-scope',
  businessRunId: REQUEST,
  recordingGeneration: 3,
  contextSha256: 'a'.repeat(64),
  modelContextSha256: 'a'.repeat(64),
  claimId: REQUEST,
  ...over,
});
const scopeAt = (generation: number, universeId = UNIVERSE, privacyEpoch = 1) =>
  ({
    generation,
    personal: { authority: { universeId, privacyEpoch, actor: { kind: 'system', purpose: 'supply.match' } } },
  }) as unknown as RecordingScopeTx;

const askDemand = (over: Partial<Demand> = {}, generation = 3): Demand =>
  ({
    id: REQUEST,
    status: 'matching',
    command: { intent: { kind: 'ask', recordingGeneration: generation } },
    ...over,
  }) as unknown as Demand;
const answerRow = (over: Partial<QuickAnswerRow> = {}): QuickAnswerRow =>
  ({ id: ANSWER, state: 'waiting', recordingGeneration: 3, ...over }) as unknown as QuickAnswerRow;

function checkWith(request: Demand | undefined, quickAnswer: QuickAnswerRow | undefined) {
  const read = (key: string) => (key === REQUEST ? request : key === ANSWER ? quickAnswer : undefined);
  return makeCheckSupplyRecordingRun({
    requests: { read: (_scope: PersonalScopeTx, key: string) => Promise.resolve(read(key) as Demand | undefined) },
    quickAnswers: {
      read: (_scope: PersonalScopeTx, key: string) => Promise.resolve(read(key) as QuickAnswerRow | undefined),
    },
  });
}

describe('the owner check of Supply’s recording runs (D-264)', () => {
  it('finds a question’s runs current while the request waits, at the generation it was asked at', async () => {
    const check = checkWith(askDemand(), undefined);
    for (const step of ['ask-scope', 'ask-library'])
      expect(await check(scopeAt(3), purpose({ purpose: step }))).toBe('current');
  });

  it('finds a question’s runs unavailable once the request is not waiting, was asked at another generation or does not exist', async () => {
    for (const status of ['requested', 'ready', 'unavailable', 'cancelled', 'deferred'] as const)
      expect(await checkWith(askDemand({ status }), undefined)(scopeAt(3), purpose())).toBe('unavailable');
    expect(await checkWith(askDemand({}, 1), undefined)(scopeAt(3), purpose())).toBe('unavailable');
    expect(await checkWith(undefined, undefined)(scopeAt(3), purpose())).toBe('unavailable');
    const notAnAsk = { ...askDemand(), command: { intent: { kind: 'topic' } } } as unknown as Demand;
    expect(await checkWith(notAnAsk, undefined)(scopeAt(3), purpose())).toBe('unavailable');
  });

  it('finds a Quick answer’s runs current while its card exists, settled or not, at the generation it was asked at', async () => {
    for (const state of ['waiting', 'answered', 'unavailable'] as const)
      for (const step of ['quick-answer', 'quick-answer-support'])
        expect(
          await checkWith(undefined, answerRow({ state }))(
            scopeAt(3),
            purpose({ purpose: step, businessRunId: id(51), claimId: ANSWER }),
          ),
        ).toBe('current');
  });

  it('finds a Quick answer’s runs unavailable once the card is dismissed, erased or was asked at another generation', async () => {
    const run = purpose({ purpose: 'quick-answer', businessRunId: id(51), claimId: ANSWER });
    expect(await checkWith(undefined, answerRow({ state: 'dismissed' }))(scopeAt(3), run)).toBe('unavailable');
    expect(await checkWith(undefined, undefined)(scopeAt(3), run)).toBe('unavailable');
    expect(await checkWith(undefined, answerRow({ recordingGeneration: 1 }))(scopeAt(3), run)).toBe('unavailable');
  });

  it('finds a run unavailable for a purpose that is not Supply’s, another universe, epoch or generation, or a proof that does not parse', async () => {
    const check = checkWith(askDemand(), answerRow());
    expect(await check(scopeAt(3), purpose({ ownerModule: 'planner', purpose: 'personal-planner' }))).toBe(
      'unavailable',
    );
    expect(await check(scopeAt(3), purpose({ purpose: 'match-request' }))).toBe('unavailable');
    expect(await check(scopeAt(3, id(9)), purpose())).toBe('unavailable');
    expect(await check(scopeAt(3, UNIVERSE, 2), purpose())).toBe('unavailable');
    expect(await check(scopeAt(5), purpose())).toBe('unavailable');
    expect(await check(scopeAt(3), { ...purpose(), recordingGeneration: 4 })).toBe('unavailable');
    expect(await check(scopeAt(3), { ...purpose(), extra: true } as unknown as PersonalRecordingPurpose)).toBe(
      'unavailable',
    );
  });
});
