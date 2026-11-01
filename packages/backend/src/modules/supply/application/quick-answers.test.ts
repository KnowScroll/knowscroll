import { describe, expect, it, vi } from 'vitest';
import type { AskQuickAnswer } from '@knowscroll/contracts';
import type { PersonalRecordingPurpose } from '../../../reasoning/public.js';
import type { PersonalAuthority, PersonalScopeTx, WithPersonalScope } from '../../identity/public.js';
import { makeAnswerQuickAnswer } from './answer-quick-answer.js';
import { NOT_COVERED_ANSWER } from '../domain/quick-answer.js';
import type { NewQuickAnswer, QuickAnswerPorts, QuickAnswerRow, QuickAnswerSettlement } from './quick-answer-ports.js';
import type { QuickAnswerSupportCheck, SupportFinding } from './quick-answer-support.js';
import { purposeOf, type RecordingRuns } from './recording-runs.js';
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
  let issued = 0;
  const named = new Map<string, string>();
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
          recordingGeneration: row.recordingGeneration,
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
      countWaiting: (_scope, youngerThan) =>
        Promise.resolve(
          options.waiting ??
            [...rows.values()].filter((row) => row.state === 'waiting' && row.createdAt > youngerThan).length,
        ),
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
    newId: () => id(50 + issued++),
    idFor: (name) => {
      if (!named.has(name)) named.set(name, id(600 + named.size));
      return named.get(name)!;
    },
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

/** The recording proof of a run the fixture checker made: only its shape matters to the step that closes it. */
const stubPurpose = (runId: string, generation = 1): PersonalRecordingPurpose =>
  purposeOf(
    { accountId: id(2), universeId: id(1), privacyEpoch: 1, recordId: id(50), recordingGeneration: generation },
    'quick-answer-support',
    runId,
    'b'.repeat(64),
  );

/**
 * A recording-aware harness that answers what the test says, and records every request. `answer` is one outcome for every
 * request, or a function of the request and its number (the writer's first request is number 1, its rewrite after a failed check
 * number 2). `propose` is its model call and `closeRun` its close of a run; `fence` makes the transaction under the recording
 * fence refuse, as it does when the person's generation or the card has moved on.
 */
function harness(answer: unknown, fence: { holds: boolean } = { holds: true }) {
  let calls = 0;
  const propose = vi.fn((input: unknown) =>
    Promise.resolve(
      typeof answer === 'function' ? (answer as (input: unknown, call: number) => unknown)(input, ++calls) : answer,
    ),
  );
  const closeRun = vi.fn((_cap: unknown, _run: unknown) => Promise.resolve('closed'));
  const withPersonalApply = vi.fn(
    async (_authority: unknown, purpose: PersonalRecordingPurpose, work: (cap: unknown) => Promise<unknown>) =>
      fence.holds
        ? { kind: 'entered', value: await work({ personal: scope, generation: purpose.recordingGeneration }) }
        : { kind: 'refused', refusal: { kind: 'scope_refused' } },
  );
  const recording = {
    harness: {
      proposePersonal: propose,
      closePersonalRun: closeRun,
      withPersonalApply,
      contextDigest: () => 'b'.repeat(64),
    },
    fenceOwn: () =>
      Promise.resolve({ kind: 'active', owner: { accountId: id(2), universeId: id(1), privacyEpoch: 1 } }),
  } as unknown as RecordingRuns;
  return { propose, closeRun, withPersonalApply, value: recording };
}
const proposed = (output: unknown) => ({
  kind: 'proposed',
  output,
  attemptId: 'ci',
  usage: {},
  repaired: false,
  reconciled: false,
});
/**
 * A labelled fixture support check: it answers each check with the next finding (the last one again after that), and records
 * every request. It judges nothing: it is what the worker does with a finding that is proved here.
 */
function checker(...findings: SupportFinding[]) {
  let calls = 0;
  return vi.fn<QuickAnswerSupportCheck>((input) =>
    Promise.resolve({
      finding: findings[Math.min(calls++, findings.length - 1)] ?? { kind: 'supported' },
      run: { runId: input.runId, purpose: stubPurpose(input.runId), end: 'completed' },
    }),
  );
}
const unsupportedSentence: SupportFinding = {
  kind: 'unsupported',
  unsupported: [{ number: 1, verdict: 'unsupported', kind: 'not_stated', problem: 'No cited passage says this.' }],
};
const job = { universeId: id(1), privacyEpoch: 1, quickAnswerId: id(50) };
const signal = new AbortController().signal;
const good = {
  question: 'Why does the axis keep pointing the same way all year?',
  answer: 'Nothing turns the axis during a year.',
  covered: true,
  cites: ['e2'],
};

describe('answering a Quick answer in the worker', () => {
  it('asks the writer with only the stops up to the reader’s, checks the answer, then stores it, clears the words and sends a hint', async () => {
    const { ports, rows, log } = fixture();
    await makeAskQuickAnswer(ports)(authority, command);
    log.notified.length = 0;
    const model = harness(proposed(good));
    const check = checker({ kind: 'supported' });
    await makeAnswerQuickAnswer(ports, model.value, check)(job, signal);
    expect(model.propose).toHaveBeenCalledTimes(1);
    const input = (
      model.propose.mock.calls[0] as unknown as [
        { run: { id: string; purpose: string }; context: { items: { kind: string; text: string }[] } },
      ]
    )[0];
    expect(input.run).toMatchObject({ id: id(50), purpose: 'quick-answer' });
    // The two stops up to the reader's, then the plainer words of the reader's own stop; nothing after.
    expect(input.context.items.find((item) => item.kind === 'scroll_passages')?.text).toBe(
      `[e1] ${STOPS[0]!.text}\n[e2] ${STOPS[1]!.text}\n[e3] The plainer words.`,
    );
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]![0]).toMatchObject({
      draft: 1,
      allowRepair: true,
      sentences: [{ number: 1, text: good.answer, cites: ['e2'] }],
    });
    expect(rows.get(id(50))).toMatchObject({
      state: 'answered',
      shownQuestion: good.question,
      answer: good.answer,
      covered: true,
      passage: undefined,
      question: undefined,
    });
    expect(model.closeRun).toHaveBeenCalledWith(
      expect.objectContaining({ personal: scope }),
      expect.objectContaining({ runId: id(50), state: 'completed' }),
    );
    expect(log.notified).toEqual([id(50)]);
  });

  it('is built only with a support check, and stores nothing when the check throws: no checker, no card', async () => {
    const { ports, rows } = fixture();
    expect(() =>
      makeAnswerQuickAnswer(ports, harness(proposed(good)).value, undefined as unknown as QuickAnswerSupportCheck),
    ).toThrow('QUICK_ANSWER_SUPPORT_CHECK_REQUIRED');
    await makeAskQuickAnswer(ports)(authority, command);
    const broken = vi.fn<QuickAnswerSupportCheck>(() => Promise.reject(new Error('the database is down')));
    await expect(makeAnswerQuickAnswer(ports, harness(proposed(good)).value, broken)(job, signal)).rejects.toThrow();
    expect(rows.get(id(50))).toMatchObject({ state: 'waiting' });
  });

  it('shows nothing when the check gave no usable answer, whatever the writer wrote', async () => {
    const { ports, rows } = fixture();
    await makeAskQuickAnswer(ports)(authority, command);
    await makeAnswerQuickAnswer(ports, harness(proposed(good)).value, checker({ kind: 'unchecked' }))(job, signal);
    expect(rows.get(id(50))).toMatchObject({ state: 'unavailable', answer: undefined, shownQuestion: undefined });
  });

  it('rewrites once an answer with an unsupported sentence, with fixed hints and no checker words, and shows the rewrite only if its check clears it', async () => {
    const rewrite = { ...good, answer: 'The axis keeps pointing the same way all year.' };
    const written = harness((_input: unknown, call: number) => proposed(call === 1 ? good : rewrite));
    const ledger = fixture();
    await makeAskQuickAnswer(ledger.ports)(authority, command);
    const check = checker(unsupportedSentence, { kind: 'supported' });
    await makeAnswerQuickAnswer(ledger.ports, written.value, check)(job, signal);
    expect(written.propose).toHaveBeenCalledTimes(2);
    const second = (
      written.propose.mock.calls[1] as unknown as [
        {
          run: { id: string };
          limits: { allowRepair: boolean };
          context: { items: { kind: string; text: string }[] };
        },
      ]
    )[0];
    expect(second.run.id).not.toBe(id(50));
    // The rewrite has no repair of its own, and its second check has none either: six paid attempts in all, never more.
    expect(second.limits).toEqual({ allowRepair: false });
    expect(check.mock.calls.map((call) => [call[0].draft, call[0].allowRepair])).toEqual([
      [1, true],
      [2, false],
    ]);
    const problems = second.context.items.find((item) => item.kind === 'check_problems')!.text;
    expect(problems).toContain(`Sentence "${good.answer}"`);
    expect(problems).toContain('No passage you cite states this');
    expect(problems).not.toContain('No cited passage says this');
    expect(ledger.rows.get(id(50))).toMatchObject({ state: 'answered', answer: rewrite.answer });
  });

  it('shows nothing when the rewrite is not cleared either, or cannot be written', async () => {
    for (const failing of [
      { writer: harness(proposed(good)), check: checker(unsupportedSentence, unsupportedSentence) },
      { writer: harness(proposed(good)), check: checker(unsupportedSentence, { kind: 'unchecked' }) },
      {
        writer: harness((_input: unknown, call: number) =>
          call === 1 ? proposed(good) : { kind: 'failed', code: 'server_error' },
        ),
        check: checker(unsupportedSentence),
      },
    ]) {
      const { ports, rows } = fixture();
      await makeAskQuickAnswer(ports)(authority, command);
      await makeAnswerQuickAnswer(ports, failing.writer.value, failing.check)(job, signal);
      expect(rows.get(id(50))).toMatchObject({ state: 'unavailable', answer: undefined, passage: undefined });
    }
  });

  it('shows a sentence code owns, never the model’s words, for a question the passages do not cover, and checks nothing', async () => {
    const outside = {
      question: 'Who first measured the tilt of the Earth?',
      answer: 'Greek astronomers measured it long before telescopes.',
      covered: false,
      cites: [],
    };
    const { ports, rows } = fixture();
    await makeAskQuickAnswer(ports)(authority, { ...command, question: 'Who measured the tilt?', commandId: id(11) });
    const check = checker({ kind: 'supported' });
    await makeAnswerQuickAnswer(ports, harness(proposed(outside)).value, check)(job, signal);
    expect(check).not.toHaveBeenCalled();
    expect(rows.get(id(50))).toMatchObject({
      state: 'answered',
      covered: false,
      shownQuestion: 'Who measured the tilt?',
      answer: NOT_COVERED_ANSWER,
    });
    const row = rows.get(id(50))!;
    expect(JSON.stringify(row)).not.toContain('Greek');
    // With no typed question the line is the person's own selected words, not a model's question.
    const plain = fixture();
    await makeAskQuickAnswer(plain.ports)(authority, command);
    await makeAnswerQuickAnswer(plain.ports, harness(proposed(outside)).value, check)(job, signal);
    expect(plain.rows.get(id(50))).toMatchObject({
      shownQuestion: 'About “keeps pointing the same way”',
      answer: NOT_COVERED_ANSWER,
    });
  });

  it('shows nothing and says it could not answer when the writer fails, and never fakes an answer', async () => {
    for (const outcome of [
      { kind: 'failed', code: 'server_error' },
      { kind: 'unknown' },
      { kind: 'budget_exhausted' },
    ]) {
      const { ports, rows } = fixture();
      await makeAskQuickAnswer(ports)(authority, command);
      const check = checker({ kind: 'supported' });
      await makeAnswerQuickAnswer(ports, harness(outcome).value, check)(job, signal);
      expect(check).not.toHaveBeenCalled();
      expect(rows.get(id(50))).toMatchObject({ state: 'unavailable', answer: undefined, passage: undefined });
    }
  });

  it('never closes the run of an attempt whose outcome is unknown, so it is left for an operator', async () => {
    const { ports } = fixture();
    await makeAskQuickAnswer(ports)(authority, command);
    const model = harness({ kind: 'unknown' });
    await makeAnswerQuickAnswer(ports, model.value, checker())(job, signal);
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
    await makeAnswerQuickAnswer(dismissed.ports, slow.value, checker())(job, signal);
    expect(dismissed.rows.get(id(50))).toMatchObject({ state: 'dismissed', answer: undefined });
    expect(dismissed.log.notified).toEqual([id(50)]);

    const late = fixture();
    await makeAskQuickAnswer(late.ports)(authority, command);
    const waiting = harness(proposed(good));
    waiting.propose.mockImplementationOnce(() => {
      late.tick(QUICK_ANSWER_WAIT_LIMIT_MS + 1);
      return Promise.resolve(proposed(good));
    });
    await makeAnswerQuickAnswer(late.ports, waiting.value, checker())(job, signal);
    expect(late.rows.get(id(50))).toMatchObject({ state: 'unavailable', answer: undefined });
  });

  it('settles a job that arrives late as unavailable and clears the words, asking no model: a stopped worker never leaves them waiting', async () => {
    for (const lateBy of [QUICK_ANSWER_WAIT_LIMIT_MS + 1, 25 * 3_600_000]) {
      const { ports, rows, tick, log } = fixture();
      await makeAskQuickAnswer(ports)(authority, command);
      log.notified.length = 0;
      tick(lateBy);
      const model = harness(proposed(good));
      await makeAnswerQuickAnswer(ports, model.value, checker())(job, signal);
      expect(model.propose).not.toHaveBeenCalled();
      expect(rows.get(id(50))).toMatchObject({ state: 'unavailable', passage: undefined, question: undefined });
      expect(log.notified).toEqual([id(50)]);
    }
  });

  it('does not let answers nobody waits for any more hold the person’s places', async () => {
    const { ports, rows, tick } = fixture({ perPerson: 10, perDay: 10 });
    const ask = makeAskQuickAnswer(ports);
    for (let asked = 0; asked < 3; asked += 1) await ask(authority, { ...command, commandId: id(80 + asked) });
    expect([...rows.values()].filter((row) => row.state === 'waiting')).toHaveLength(3);
    // Three are waiting: a fourth is refused.
    expect(await ask(authority, { ...command, commandId: id(90) })).toMatchObject({
      value: { outcome: 'unavailable', reason: 'too_many_open' },
    });
    // Nobody waits for them after the wait limit, whether or not a job ever settled them: the places are free again.
    tick(QUICK_ANSWER_WAIT_LIMIT_MS + 1);
    expect(await ask(authority, { ...command, commandId: id(90) })).toMatchObject({
      value: { outcome: 'accepted' },
    });
  });

  it('asks no model for an answer that is dismissed, settled or whose Scroll is gone', async () => {
    const gone = fixture({ facts: false });
    await gone.ports.store.insert(scope, {
      id: id(50),
      assetId: id(20),
      assetRevision: 3,
      stopId: 'two',
      recordingGeneration: 1,
      passage: 'keeps pointing',
      question: undefined,
      createdAt: start,
      expiresAt: new Date(start.getTime() + 86_400_000),
    });
    const model = harness(proposed(good));
    await makeAnswerQuickAnswer(gone.ports, model.value, checker())(job, signal);
    expect(model.propose).not.toHaveBeenCalled();
    expect(gone.rows.get(id(50))).toMatchObject({ state: 'unavailable' });

    const done = fixture();
    await makeAskQuickAnswer(done.ports)(authority, command);
    await makeDismissQuickAnswer(done.ports)(authority, { quickAnswerId: id(50) });
    await makeAnswerQuickAnswer(done.ports, model.value, checker())(job, signal);
    expect(model.propose).not.toHaveBeenCalled();
  });
});

describe('what a report keeps of a Quick answer', () => {
  it('is the question and answer of the person’s own kept answer for exactly this revision, and nothing else', async () => {
    const { ports } = fixture();
    await makeAskQuickAnswer(ports)(authority, command);
    await makeAnswerQuickAnswer(ports, harness(proposed(good)).value, checker())(job, signal);
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
