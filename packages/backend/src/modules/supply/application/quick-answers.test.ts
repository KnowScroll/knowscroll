import { describe, expect, it, vi } from 'vitest';
import type { AskQuickAnswer } from '@knowscroll/contracts';
import type { ReasoningHarness } from '../../../reasoning/public.js';
import type { PersonalAuthority, PersonalScopeTx, WithPersonalScope } from '../../identity/public.js';
import { makeAnswerQuickAnswer } from './answer-quick-answer.js';
import type {
  NewQuickAnswer,
  QuickAnswerPorts,
  QuickAnswerRow,
  QuickAnswerSettlement,
  QuickAnswerSupportCheck,
} from './quick-answer-ports.js';
import {
  QUICK_ANSWER_WAIT_LIMIT_MS,
  makeAskQuickAnswer,
  makeDismissQuickAnswer,
  makeReadQuickAnswer,
  makeReadQuickAnswerForReport,
} from './quick-answers.js';

const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const authority: PersonalAuthority = {
  universeId: id(1),
  privacyEpoch: 1,
  actor: { kind: 'account', accountId: id(2) },
};
const scope = { authority } as unknown as PersonalScopeTx;
const start = new Date('2026-11-01T10:00:00.000Z');

const STOPS = [
  { stopId: 'one', text: 'Earth’s axis leans 23.4 degrees.' },
  { stopId: 'two', text: 'It keeps pointing the same way all year.' },
];
const command: AskQuickAnswer = {
  version: 'quick-answer-ask.v1',
  commandId: id(10),
  source: { assetId: id(20), assetRevision: 3 },
  stopId: 'two',
  passage: 'keeps pointing the same way',
  recordingGeneration: 1,
};

interface Options {
  readonly gate?: 'recording' | 'paused' | 'stale' | 'other';
  readonly exposure?: boolean;
  readonly facts?: boolean;
  readonly perDay?: number;
  readonly perPerson?: number;
  readonly ledger?: number;
  readonly person?: number;
  readonly waiting?: number;
  readonly supportCheck?: QuickAnswerSupportCheck;
}

/** Ports over memory: every write is logged and the clock is the test's. */
function fixture(options: Options = {}) {
  const rows = new Map<string, QuickAnswerRow>();
  const log = {
    ledger: [] as string[],
    jobs: [] as string[],
    notified: [] as string[],
    receipts: new Map<string, unknown>(),
  };
  let clock = start;
  const withScope: WithPersonalScope = (_authority, work) => work(scope).then((value) => ({ kind: 'entered', value }));
  const ports: QuickAnswerPorts = {
    withScope,
    ownerActive: () => Promise.resolve(true),
    hasActivatedExposure: () => Promise.resolve(options.exposure ?? true),
    readFacts: () =>
      Promise.resolve(
        options.facts === false ? undefined : { title: 'Seasons', passages: STOPS, anchorSimple: 'The plainer words.' },
      ),
    fenceRecording: () =>
      Promise.resolve(
        (options.gate ?? 'recording') === 'recording'
          ? ({ kind: 'recording', scope: { generation: 1 } } as never)
          : ({ kind: options.gate } as never),
      ),
    store: {
      lockCaps: () => Promise.resolve(),
      insert: (_scope, row: NewQuickAnswer) => {
        rows.set(row.id, {
          id: row.id,
          privacyEpoch: 1,
          assetId: row.assetId,
          assetRevision: row.assetRevision,
          stopId: row.stopId,
          state: 'waiting',
          passage: row.passage,
          question: row.question,
          shownQuestion: undefined,
          answer: undefined,
          covered: undefined,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
        });
        return Promise.resolve();
      },
      read: (_scope, rowId) => Promise.resolve(rows.get(rowId)),
      settle: (_scope, rowId, settlement: QuickAnswerSettlement) => {
        const row = rows.get(rowId);
        if (row?.state !== 'waiting') return Promise.resolve(false);
        rows.set(rowId, {
          ...row,
          state: settlement.kind === 'answered' ? 'answered' : 'unavailable',
          passage: undefined,
          question: undefined,
          shownQuestion: settlement.kind === 'answered' ? settlement.question : undefined,
          answer: settlement.kind === 'answered' ? settlement.answer : undefined,
          covered: settlement.kind === 'answered' ? settlement.covered : undefined,
        });
        return Promise.resolve(true);
      },
      dismiss: (_scope, rowId) => {
        const row = rows.get(rowId);
        if (row !== undefined)
          rows.set(rowId, {
            ...row,
            state: 'dismissed',
            passage: undefined,
            question: undefined,
            shownQuestion: undefined,
            answer: undefined,
            covered: undefined,
          });
        return Promise.resolve();
      },
      countSince: () => Promise.resolve(options.person ?? rows.size),
      countWaiting: () => Promise.resolve(options.waiting ?? 0),
    },
    ledger: {
      countSince: () => Promise.resolve(options.ledger ?? 0),
      insert: (_scope, ledgerId) => {
        log.ledger.push(ledgerId);
        return Promise.resolve();
      },
    },
    caps: { perDay: options.perDay ?? 5, perPersonPerDay: options.perPerson ?? 3 },
    receipts: {
      find: (_scope, commandId) =>
        Promise.resolve(
          log.receipts.has(commandId) ? { kind: 'replay', outcome: log.receipts.get(commandId) } : { kind: 'new' },
        ),
      insert: (_scope, commandId) => {
        log.receipts.set(commandId, undefined);
        return Promise.resolve();
      },
      complete: (_scope, commandId, receipt) => {
        log.receipts.set(commandId, receipt);
        return Promise.resolve();
      },
    },
    enqueue: (_scope, quickAnswerId) => {
      log.jobs.push(quickAnswerId);
      return Promise.resolve();
    },
    advance: () => Promise.resolve(7),
    notify: (_scope, _revision, eventId) => {
      log.notified.push(eventId);
      return Promise.resolve();
    },
    supportCheck: options.supportCheck ?? (() => Promise.resolve('supported')),
    newId: () => id(50),
    now: () => clock,
  };
  return {
    ports,
    rows,
    log,
    tick: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

describe('asking for a Quick answer', () => {
  it('stores the words, writes one ledger row and sends one job, and calls no model', async () => {
    const { ports, rows, log } = fixture();
    const result = await makeAskQuickAnswer(ports)(authority, command);
    expect(result).toMatchObject({
      kind: 'ok',
      value: { outcome: 'accepted', quickAnswerId: id(50), commandId: id(10), replayed: false },
    });
    expect(rows.get(id(50))).toMatchObject({ state: 'waiting', passage: 'keeps pointing the same way', stopId: 'two' });
    expect(log).toMatchObject({ ledger: [id(50)], jobs: [id(50)], notified: [id(50)] });
  });

  it('answers an identical retry with the first receipt and sends nothing again', async () => {
    const { ports, log } = fixture();
    const ask = makeAskQuickAnswer(ports);
    await ask(authority, command);
    const again = await ask(authority, command);
    expect(again).toMatchObject({ kind: 'ok', value: { outcome: 'accepted', quickAnswerId: id(50), replayed: true } });
    expect(log.jobs).toHaveLength(1);
    expect(log.ledger).toHaveLength(1);
  });

  it('is refused while recording is paused or its generation is stale, and stores nothing (D-254)', async () => {
    for (const [gate, reason] of [
      ['paused', 'recording_paused'],
      ['stale', 'recording_stale'],
      ['other', 'scope_refused'],
    ] as const) {
      const { ports, rows, log } = fixture({ gate });
      expect(await makeAskQuickAnswer(ports)(authority, command)).toEqual({ kind: 'refused', reason });
      expect(rows.size).toBe(0);
      expect(log.jobs).toEqual([]);
      expect(log.receipts.size).toBe(0);
    }
  });

  it('refuses a Scroll the person never opened, a stop that is not a read stop of it, and words from somewhere else', async () => {
    for (const options of [{ exposure: false }, { facts: false }] as const) {
      const { ports, rows } = fixture(options);
      expect(await makeAskQuickAnswer(ports)(authority, command)).toEqual({
        kind: 'refused',
        reason: 'source_unavailable',
      });
      expect(rows.size).toBe(0);
    }
    const { ports, rows } = fixture();
    const foreign = await makeAskQuickAnswer(ports)(authority, { ...command, passage: 'the Moon pulls the tides' });
    expect(foreign).toEqual({ kind: 'refused', reason: 'source_unavailable' });
    expect(rows.size).toBe(0);
  });

  it('takes words selected in the plainer version of the stop', async () => {
    const { ports } = fixture();
    const result = await makeAskQuickAnswer(ports)(authority, { ...command, passage: 'The plainer words' });
    expect(result).toMatchObject({ kind: 'ok', value: { outcome: 'accepted' } });
  });

  it('says honestly it is not available, with no row and no receipt, when the day, the person or the queue is full', async () => {
    for (const [options, reason] of [
      [{ perDay: 0 }, 'not_available'],
      [{ ledger: 5 }, 'not_available'],
      [{ person: 3 }, 'person_limit'],
      [{ waiting: 3 }, 'too_many_open'],
    ] as const) {
      const { ports, rows, log } = fixture(options);
      expect(await makeAskQuickAnswer(ports)(authority, command)).toEqual({
        kind: 'ok',
        value: { version: 'quick-answer-receipt.v1', outcome: 'unavailable', reason },
      });
      expect(rows.size).toBe(0);
      expect(log.jobs).toEqual([]);
      expect(log.ledger).toEqual([]);
      expect(log.receipts.size).toBe(0);
    }
  });

  it('keeps the person’s words only a day', async () => {
    const { ports, rows } = fixture();
    await makeAskQuickAnswer(ports)(authority, command);
    expect(rows.get(id(50))!.expiresAt.toISOString()).toBe('2026-11-02T10:00:00.000Z');
  });
});

describe('reading and dismissing a Quick answer', () => {
  it('reads waiting, then gives up honestly after the wait limit even if no worker ever closed it', async () => {
    const { ports, tick } = fixture();
    await makeAskQuickAnswer(ports)(authority, command);
    const read = makeReadQuickAnswer(ports);
    expect(await read(authority, { quickAnswerId: id(50) })).toMatchObject({
      kind: 'ok',
      value: { status: 'waiting' },
    });
    tick(QUICK_ANSWER_WAIT_LIMIT_MS + 1000);
    expect(await read(authority, { quickAnswerId: id(50) })).toMatchObject({
      kind: 'ok',
      value: { status: 'unavailable', reason: 'could_not_answer' },
    });
  });

  it('reads nothing once dismissed or past its day, and dismissing is quiet about what exists', async () => {
    const { ports, rows, tick } = fixture();
    await makeAskQuickAnswer(ports)(authority, command);
    const read = makeReadQuickAnswer(ports);
    const dismiss = makeDismissQuickAnswer(ports);
    const quiet = await dismiss(authority, { quickAnswerId: id(99) });
    expect(quiet).toMatchObject({ kind: 'ok' });
    await dismiss(authority, { quickAnswerId: id(50) });
    expect(rows.get(id(50))).toMatchObject({ state: 'dismissed', passage: undefined, answer: undefined });
    expect(await read(authority, { quickAnswerId: id(50) })).toEqual({ kind: 'refused', reason: 'not_found' });
    expect(await read(authority, { quickAnswerId: id(99) })).toEqual({ kind: 'refused', reason: 'not_found' });
    const second = fixture();
    await makeAskQuickAnswer(second.ports)(authority, command);
    second.tick(25 * 3_600_000);
    expect(await makeReadQuickAnswer(second.ports)(authority, { quickAnswerId: id(50) })).toEqual({
      kind: 'refused',
      reason: 'not_found',
    });
    tick(0);
  });
});

/** A harness that answers with what the test says and records what it was asked. */
function harness(outcome: unknown) {
  const propose = vi.fn(() => Promise.resolve(outcome));
  const closeRun = vi.fn(() => Promise.resolve('closed'));
  return { propose, closeRun, value: { propose, closeRun } as unknown as ReasoningHarness };
}
const proposed = (output: unknown) => ({
  kind: 'proposed',
  output,
  attemptId: 'ci',
  usage: {},
  repaired: false,
  reconciled: false,
});
const job = { universeId: id(1), privacyEpoch: 1, quickAnswerId: id(50) };
const signal = new AbortController().signal;
const good = {
  question: 'Why does it keep pointing?',
  answer: 'Nothing turns the axis during a year.',
  covered: true,
  cites: ['e2'],
};

describe('answering a Quick answer in the worker', () => {
  it('asks the model once with only the stops up to the reader’s, then stores the answer, clears the words and sends a hint', async () => {
    const { ports, rows, log } = fixture();
    await makeAskQuickAnswer(ports)(authority, command);
    log.notified.length = 0;
    const model = harness(proposed(good));
    await makeAnswerQuickAnswer(ports, model.value)(job, signal);
    expect(model.propose).toHaveBeenCalledTimes(1);
    const input = (
      model.propose.mock.calls[0] as unknown as [
        { run: { id: string; purpose: string }; context: { items: { kind: string; text: string }[] } },
      ]
    )[0];
    expect(input.run).toMatchObject({ id: id(50), purpose: 'quick-answer' });
    expect(input.context.items.find((item) => item.kind === 'scroll_passages')?.text).toBe(
      `[e1] ${STOPS[0]!.text}\n[e2] ${STOPS[1]!.text}`,
    );
    expect(rows.get(id(50))).toMatchObject({
      state: 'answered',
      shownQuestion: good.question,
      answer: good.answer,
      covered: true,
      passage: undefined,
      question: undefined,
    });
    expect(model.closeRun).toHaveBeenCalledWith(scope, { runId: id(50), state: 'completed' });
    expect(log.notified).toEqual([id(50)]);
  });

  it('shows nothing and says it could not answer when the model fails, and never fakes an answer', async () => {
    for (const outcome of [
      { kind: 'failed', code: 'server_error' },
      { kind: 'unknown' },
      { kind: 'budget_exhausted' },
    ]) {
      const { ports, rows } = fixture();
      await makeAskQuickAnswer(ports)(authority, command);
      await makeAnswerQuickAnswer(ports, harness(outcome).value)(job, signal);
      expect(rows.get(id(50))).toMatchObject({ state: 'unavailable', answer: undefined, passage: undefined });
    }
  });

  it('never closes the run of an attempt whose outcome is unknown, so it is left for an operator', async () => {
    const { ports } = fixture();
    await makeAskQuickAnswer(ports)(authority, command);
    const model = harness({ kind: 'unknown' });
    await makeAnswerQuickAnswer(ports, model.value)(job, signal);
    expect(model.closeRun).not.toHaveBeenCalled();
  });

  it('drops a late answer: dismissed meanwhile, or past the wait limit', async () => {
    const dismissed = fixture();
    await makeAskQuickAnswer(dismissed.ports)(authority, command);
    const slow = harness(proposed(good));
    slow.propose.mockImplementationOnce(async () => {
      await makeDismissQuickAnswer(dismissed.ports)(authority, { quickAnswerId: id(50) });
      return proposed(good);
    });
    await makeAnswerQuickAnswer(dismissed.ports, slow.value)(job, signal);
    expect(dismissed.rows.get(id(50))).toMatchObject({ state: 'dismissed', answer: undefined });
    expect(dismissed.log.notified).toEqual([id(50)]);

    const late = fixture();
    await makeAskQuickAnswer(late.ports)(authority, command);
    const waiting = harness(proposed(good));
    waiting.propose.mockImplementationOnce(() => {
      late.tick(QUICK_ANSWER_WAIT_LIMIT_MS + 1);
      return Promise.resolve(proposed(good));
    });
    await makeAnswerQuickAnswer(late.ports, waiting.value)(job, signal);
    expect(late.rows.get(id(50))).toMatchObject({ state: 'unavailable', answer: undefined });
  });

  it('asks no model for an answer that is dismissed, settled, past its wait or whose Scroll is gone', async () => {
    const gone = fixture({ facts: false });
    await gone.ports.store.insert(scope, {
      id: id(50),
      assetId: id(20),
      assetRevision: 3,
      stopId: 'two',
      passage: 'keeps pointing',
      question: undefined,
      createdAt: start,
      expiresAt: new Date(start.getTime() + 86_400_000),
    });
    const model = harness(proposed(good));
    await makeAnswerQuickAnswer(gone.ports, model.value)(job, signal);
    expect(model.propose).not.toHaveBeenCalled();
    expect(gone.rows.get(id(50))).toMatchObject({ state: 'unavailable' });

    const done = fixture();
    await makeAskQuickAnswer(done.ports)(authority, command);
    await makeDismissQuickAnswer(done.ports)(authority, { quickAnswerId: id(50) });
    await makeAnswerQuickAnswer(done.ports, model.value)(job, signal);
    expect(model.propose).not.toHaveBeenCalled();
  });

  it('shows a draft the support seam does not support to nobody (the seam S-7b’s checker plugs into)', async () => {
    const supportCheck = vi.fn<QuickAnswerSupportCheck>(() => Promise.resolve('unsupported'));
    const { ports, rows } = fixture({ supportCheck });
    await makeAskQuickAnswer(ports)(authority, command);
    await makeAnswerQuickAnswer(ports, harness(proposed(good)).value)(job, signal);
    expect(supportCheck).toHaveBeenCalledTimes(1);
    expect(supportCheck.mock.calls[0]![0].passages.map((passage) => passage.handle)).toEqual(['e1', 'e2']);
    expect(rows.get(id(50))).toMatchObject({ state: 'unavailable', answer: undefined });
  });
});

describe('what a report keeps of a Quick answer', () => {
  it('is the question and answer of the person’s own kept answer for exactly this revision, and nothing else', async () => {
    const { ports } = fixture();
    await makeAskQuickAnswer(ports)(authority, command);
    await makeAnswerQuickAnswer(ports, harness(proposed(good)).value)(job, signal);
    const forReport = makeReadQuickAnswerForReport(ports);
    const input = { quickAnswerId: id(50), assetId: id(20), assetRevision: 3 };
    expect(await forReport(scope, input)).toBe(`Q: ${good.question}\nA: ${good.answer}`);
    expect(await forReport(scope, { ...input, assetRevision: 4 })).toBeUndefined();
    expect(await forReport(scope, { ...input, assetId: id(21) })).toBeUndefined();
    expect(await forReport(scope, { ...input, quickAnswerId: id(99) })).toBeUndefined();
    await makeDismissQuickAnswer(ports)(authority, { quickAnswerId: id(50) });
    expect(await forReport(scope, input)).toBeUndefined();
  });
});
