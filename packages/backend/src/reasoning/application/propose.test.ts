import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NO_USAGE } from '../domain/budgets.js';
import { makeScopedReasoningHarness, type ProposeInput, type ReasoningRole } from './propose.js';
import {
  ModelOutcomeUnknownError,
  ModelRejectedError,
  type AttemptLedger,
  type AttemptRow,
  type ExecutionPorts,
  type GuardedModelPort,
  type ModelReply,
  type ModelRequest,
  type Reservation,
} from './ports.js';

// Hand-built engine fixtures: a fake model, ledger and clock. No database or provider. The paths here
// end before any attempt is reserved, so they pin admission, the opportunistic purge and the size
// refusal; the attempt, repair and settlement paths are covered by the integration tests.
const runId = '0199f0a0-0000-7000-8000-000000000003';
const input = (overrides: Partial<ProposeInput<unknown, null>> = {}): ProposeInput<unknown, null> => ({
  run: { id: runId, authority: null, ownerModule: 'fixture', purpose: 'fixture-purpose', policyVersion: 'fixture.v1' },
  role: {
    id: 'fixture.echo',
    version: 'v1',
    instructions: 'Return the object.',
    outputSchema: z.strictObject({ ok: z.literal(true) }),
    maxOutputTokens: 16,
  },
  context: { bundleRef: 'fixture.bundle:1', items: [{ ref: 'fixture:item', kind: 'evidence', text: 'fixture' }] },
  ...overrides,
});

function engine(options: { model?: boolean; maxRequestBytes?: number; purge?: () => Promise<number> } = {}) {
  const clock = { now: 10_000 };
  const logEvent = vi.fn();
  const purgeExpiredRequests = vi.fn(options.purge ?? (() => Promise.resolve(2)));
  const model = {
    provider: 'fixture',
    model: 'fixture-model',
    encode: () => new Uint8Array(64),
    observeQuota: vi.fn(),
    send: vi.fn(),
  } as unknown as GuardedModelPort;
  const ports = {
    model: options.model === false ? undefined : model,
    ledger: { purgeExpiredRequests },
    hashBytes: () => 'b'.repeat(64),
    redactRecorded: (value: Readonly<Record<string, unknown>>) => value,
    newId: () => runId,
    now: () => clock.now,
    logEvent,
    settings: {
      caps: { global: {}, scope: {}, roleDefault: {} },
      maxRequestBytes: options.maxRequestBytes ?? 1,
      requestRetentionSeconds: 60,
      purgeIntervalMs: 1_000,
      dispatchedBy: 'ci-fixture',
    },
    scopeId: () => 'scope',
    generation: () => 1,
    withScope: vi.fn(),
    authorityHolds: vi.fn(),
  } as unknown as ExecutionPorts<null, never>;
  return { harness: makeScopedReasoningHarness(ports), clock, logEvent, purgeExpiredRequests };
}

const signal = new AbortController().signal;

describe('admission', () => {
  it.each([
    ['no provider is configured', { model: false }, input(), 'provider_unavailable'],
    ['the role is invalid', {}, input({ role: { ...input().role, id: 'NotARole' } }), 'role_invalid'],
    ['the run is invalid', {}, input({ run: { ...input().run, id: 'not-a-uuid' } }), 'run_invalid'],
    [
      'the context is invalid',
      {},
      input({ context: { bundleRef: 'bad ref', items: input().context.items } }),
      'context_invalid',
    ],
    [
      'the role needs more context',
      {},
      input({ role: { ...input().role, minContextItems: 2 } }),
      'context_insufficient',
    ],
  ] as const)('refuses before anything else when %s', async (_name, options, proposal, reason) => {
    const { harness, logEvent, purgeExpiredRequests } = engine(options);
    await expect(harness.propose(proposal, signal)).resolves.toEqual({ kind: 'refused', reason });
    expect(logEvent).toHaveBeenCalledWith(
      'reasoning.admission_refused',
      expect.objectContaining({ reasonCode: reason }),
    );
    expect(purgeExpiredRequests).not.toHaveBeenCalled();
  });

  it('names the run in the log only when its ID is well formed', async () => {
    const { harness, logEvent } = engine();
    await harness.propose(input({ run: { ...input().run, id: 'not-a-uuid' } }), signal);
    expect(logEvent).toHaveBeenCalledWith('reasoning.admission_refused', { reasonCode: 'run_invalid' });
    await harness.propose(input({ role: { ...input().role, id: 'NotARole' } }), signal);
    expect(logEvent).toHaveBeenCalledWith('reasoning.admission_refused', { runId, reasonCode: 'role_invalid' });
  });

  it('refuses a request too large for the protected store, after admission and the purge', async () => {
    const { harness, logEvent, purgeExpiredRequests } = engine({ maxRequestBytes: 8 });
    await expect(harness.propose(input(), signal)).resolves.toEqual({ kind: 'refused', reason: 'request_too_large' });
    expect(purgeExpiredRequests).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith('reasoning.admission_refused', { runId, reasonCode: 'request_too_large' });
  });
});

describe('the opportunistic purge', () => {
  it('purges expired requests at most once per interval, however many proposals run', async () => {
    const { harness, clock, purgeExpiredRequests, logEvent } = engine();
    await harness.propose(input(), signal);
    await harness.propose(input(), signal);
    clock.now += 999;
    await harness.propose(input(), signal);
    expect(purgeExpiredRequests).toHaveBeenCalledTimes(1);
    expect(purgeExpiredRequests).toHaveBeenCalledWith(500);
    expect(logEvent).toHaveBeenCalledWith('reasoning.requests_purged', { count: 2 });
    clock.now += 1;
    await harness.propose(input(), signal);
    expect(purgeExpiredRequests).toHaveBeenCalledTimes(2);
  });

  it('logs nothing about a purge that deleted nothing', async () => {
    const { harness, logEvent } = engine({ purge: () => Promise.resolve(0) });
    await harness.propose(input(), signal);
    expect(logEvent).not.toHaveBeenCalledWith('reasoning.requests_purged', expect.anything());
  });

  it('logs a failed purge, never fails the proposal, and waits for the next interval to try again', async () => {
    const failure = new Error('database unavailable');
    const { harness, clock, logEvent, purgeExpiredRequests } = engine({ purge: () => Promise.reject(failure) });
    await expect(harness.propose(input(), signal)).resolves.toEqual({ kind: 'refused', reason: 'request_too_large' });
    expect(logEvent).toHaveBeenCalledWith('reasoning.purge_failed', { error: failure });
    await harness.propose(input(), signal);
    expect(purgeExpiredRequests).toHaveBeenCalledTimes(1);
    clock.now += 1_000;
    await harness.propose(input(), signal);
    expect(purgeExpiredRequests).toHaveBeenCalledTimes(2);
  });
});

/**
 * An in-memory attempt ledger: just enough state for a proposal's attempts. `keptAnswer` is the refused answer every attempt has
 * kept; `keptByStep` gives each step its own, as the production ledger keeps one for each refused attempt. Every reservation is
 * recorded in `reserved`, and it is charged to the spend the next reservation is checked against, as the real ledger charges it.
 */
function memoryLedger(options: { keptAnswer?: string; keptByStep?: Readonly<Record<string, string>> } = {}) {
  const rows = new Map<string, { -readonly [K in keyof AttemptRow]: AttemptRow[K] }>();
  const reserved: Reservation[] = [];
  const spend = { requests: 0, tokens: 0 };
  const ledger = {
    find: (_scopeId: string, _runId: string, step: string) => Promise.resolve(rows.get(step)),
    findLocked: (_scope: null, _runId: string, step: string) => Promise.resolve(rows.get(step)),
    admitRun: () => Promise.resolve({ kind: 'admitted' as const, fence: 1 }),
    budgetUsage: () =>
      Promise.resolve({
        global: spend,
        role: spend,
        scope: spend,
        background: { global: spend, scope: spend },
        ambient: { global: spend },
      }),
    canStartRun: () => Promise.resolve(true),
    reserve: (_scope: null, reservation: Reservation) => {
      reserved.push(reservation);
      spend.requests += 1;
      spend.tokens += reservation.reservedTokens;
      rows.set(reservation.step, {
        runGeneration: 1,
        runState: 'admitted',
        id: reservation.id,
        step: reservation.step,
        state: 'reserved',
        requestHash: reservation.requestHash,
        outcomeCode: null,
        output: null,
        issues: null,
        usage: NO_USAGE,
      });
      return Promise.resolve();
    },
    commitDispatch: (_scope: null, attemptId: string) => {
      const row = [...rows.values()].find((candidate) => candidate.id === attemptId);
      if (row?.state !== 'reserved') return Promise.resolve(false);
      row.state = 'dispatched';
      return Promise.resolve(true);
    },
    settle: (
      attempt: { attemptId: string },
      from: string,
      to: string,
      details?: { outcomeCode?: string; output?: AttemptRow['output']; issues?: AttemptRow['issues'] },
    ) => {
      const row = [...rows.values()].find((candidate) => candidate.id === attempt.attemptId);
      if (row?.state !== from) return Promise.resolve(false);
      Object.assign(row, {
        state: to,
        outcomeCode: details?.outcomeCode ?? null,
        output: details?.output ?? null,
        issues: details?.issues ?? null,
      });
      return Promise.resolve(true);
    },
    readRejectedAnswerText: (attempt: { attemptId: string }) => {
      const step = [...rows.values()].find((candidate) => candidate.id === attempt.attemptId)?.step;
      return Promise.resolve(
        options.keptByStep === undefined || step === undefined ? options.keptAnswer : options.keptByStep[step],
      );
    },
    purgeExpiredRequests: () => Promise.resolve(0),
  };
  return { ledger: ledger as unknown as AttemptLedger<null>, reserved };
}

/** The whole engine over the in-memory ledger and a scripted model: no database, no provider. */
function scriptedEngine(options: {
  /** What the model answers, one for each request: an answer's text, or the error the transport raises. */
  replies: readonly (string | Error)[];
  maxRequestBytes?: number;
  keptAnswer?: string;
  keptByStep?: Readonly<Record<string, string>>;
  /** The role's daily cap of requests; none by default. */
  roleRequestsPerDay?: number;
}) {
  /** The requests that were actually sent, in order. */
  const sent: ModelRequest[] = [];
  const answers = [...options.replies];
  let nextId = 0;
  const model = {
    provider: 'fixture',
    model: 'fixture-model',
    encode: (request: ModelRequest) => new TextEncoder().encode(JSON.stringify(request)),
    observeQuota: () =>
      Promise.resolve({ verdict: 'not_applicable', intervalRemainingPercent: null, weeklyRemainingPercent: null }),
    send: (body: Uint8Array): Promise<ModelReply> => {
      sent.push(JSON.parse(new TextDecoder().decode(body)) as ModelRequest);
      const next = answers.shift() ?? '{}';
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve({
        usage: NO_USAGE,
        answer: { kind: 'text', text: next, stop: 'end' },
      });
    },
  } as unknown as GuardedModelPort;
  const memory = memoryLedger({
    ...(options.keptAnswer === undefined ? {} : { keptAnswer: options.keptAnswer }),
    ...(options.keptByStep === undefined ? {} : { keptByStep: options.keptByStep }),
  });
  const ports = {
    model,
    ledger: memory.ledger,
    hashBytes: (bytes: Uint8Array) => `hash-${bytes.length}`,
    redactRecorded: (value: Readonly<Record<string, unknown>>) => value,
    newId: () => `0199f0a0-0000-7000-8000-${String(++nextId).padStart(12, '0')}`,
    now: () => 1_000,
    logEvent: vi.fn(),
    settings: {
      caps: {
        global: { requestsPerDay: 1_000, tokensPerDay: 1e9 },
        scope: { requestsPerDay: 1_000, tokensPerDay: 1e9 },
        roleDefault: { requestsPerDay: options.roleRequestsPerDay ?? 1_000, tokensPerDay: 1e9 },
      },
      backgroundSharePercent: 100,
      ambientSharePercent: 100,
      maxRequestBytes: options.maxRequestBytes ?? 1_000_000,
      requestRetentionSeconds: 60,
      purgeIntervalMs: 1_000,
      dispatchedBy: 'ci-fixture',
    },
    scopeId: () => 'scope',
    generation: () => 1,
    withScope: async (_authority: null, work: (scope: null) => Promise<unknown>) => ({
      kind: 'entered' as const,
      value: await work(null),
    }),
    authorityHolds: () => Promise.resolve(true),
  } as unknown as ExecutionPorts<null, null>;
  return { harness: makeScopedReasoningHarness(ports), sent, reserved: memory.reserved };
}

/**
 * What the harness sent for a role without `secondRepairOnlyFor` before D-445, in the scripted run of the test that uses them: the
 * SHA-256 of the two requests and the step and request hash (the scripted model's hash is the byte length) of each reservation.
 */
const PRE_D445_REQUESTS_SHA256 = 'af916ebb34809dcafe4a1a1d87909796bc9f9faafd81699dde5edfff0d92cedf';
const PRE_D445_RESERVATIONS: readonly (readonly [string, string])[] = [
  ['primary', 'hash-756'],
  ['repair', 'hash-1307'],
];

const valid = '{"ok":true}';
const invalid = '{"ok":false}';

describe('a proposal over the scripted model', () => {
  it('returns a valid first answer as proposed, not repaired', async () => {
    const { harness, sent } = scriptedEngine({ replies: [valid] });
    await expect(harness.propose(input(), signal)).resolves.toMatchObject({
      kind: 'proposed',
      output: { ok: true },
      repaired: false,
    });
    expect(sent).toHaveLength(1);
  });

  it('repairs an invalid first answer once, sending the validator’s findings', async () => {
    const { harness, sent } = scriptedEngine({ replies: [invalid, valid] });
    await expect(harness.propose(input(), signal)).resolves.toMatchObject({
      kind: 'proposed',
      output: { ok: true },
      repaired: true,
    });
    expect(sent).toHaveLength(2);
    expect(sent[0]?.system).not.toContain('Validation:');
    expect(sent[1]?.system).toContain('Validation: your previous answer');
    expect(sent[1]?.system).toContain('ok: invalid_value (allowed: true)');
  });

  it('gives up after one repair', async () => {
    const { harness, sent } = scriptedEngine({ replies: [invalid, invalid, valid] });
    await expect(harness.propose(input(), signal)).resolves.toMatchObject({ kind: 'invalid_output' });
    expect(sent).toHaveLength(2);
  });

  it('does not repair when the caller forbids it', async () => {
    const { harness, sent } = scriptedEngine({ replies: [invalid, valid] });
    await expect(harness.propose(input({ limits: { allowRepair: false } }), signal)).resolves.toMatchObject({
      kind: 'invalid_output',
      reason: 'OUTPUT_SCHEMA_MISMATCH',
    });
    expect(sent).toHaveLength(1);
  });

  describe('a repair narrowed to the refusals of one kind', () => {
    // `{"ok":false}` is refused with the role's own code; `{"ok":"no"}` with the schema's type finding.
    const narrow: ReasoningRole<unknown> = {
      ...input().role,
      outputSchema: z.object({ ok: z.boolean() }).superRefine((value, context) => {
        if (!value.ok) context.addIssue({ code: 'custom', path: [], message: 'x', params: { safeCode: 'only_this' } });
      }),
      safeCustomIssues: { only_this: 'Fixed hint for the one kind.' },
    };
    const narrowed = (codes: readonly string[]) => input({ role: narrow, limits: { repairOnlyFor: codes } });

    it('repairs a refusal whose every finding is of that kind', async () => {
      const { harness, sent } = scriptedEngine({ replies: [invalid, valid] });
      await expect(harness.propose(narrowed(['only_this']), signal)).resolves.toMatchObject({
        kind: 'proposed',
        repaired: true,
      });
      expect(sent).toHaveLength(2);
      expect(sent[1]?.system).toContain('Fixed hint for the one kind.');
    });

    it('leaves a refusal of another kind as it is, with no second request', async () => {
      const { harness, sent } = scriptedEngine({ replies: ['{"ok":"no"}', valid] });
      await expect(harness.propose(narrowed(['only_this']), signal)).resolves.toMatchObject({ kind: 'invalid_output' });
      expect(sent).toHaveLength(1);
    });

    it('repairs nothing when the list is empty, and never when the caller forbids repair', async () => {
      for (const limits of [{ repairOnlyFor: [] }, { allowRepair: false, repairOnlyFor: ['only_this'] }]) {
        const { harness, sent } = scriptedEngine({ replies: [invalid, valid] });
        await expect(harness.propose(input({ role: narrow, limits }), signal)).resolves.toMatchObject({
          kind: 'invalid_output',
        });
        expect(sent).toHaveLength(1);
      }
    });

    it('still gives up after the one repair', async () => {
      const { harness, sent } = scriptedEngine({ replies: [invalid, invalid, valid] });
      await expect(harness.propose(narrowed(['only_this']), signal)).resolves.toMatchObject({ kind: 'invalid_output' });
      expect(sent).toHaveLength(2);
    });
  });

  describe('a second repair, for a role that opts into it (D-445)', () => {
    // `{"ok":false}` is refused with the role's own code `copied`; `{"ok":"no"}` with the schema's type finding, another code.
    const copying: ReasoningRole<unknown> = {
      ...input().role,
      outputSchema: z.object({ ok: z.boolean() }).superRefine((value, context) => {
        if (!value.ok) context.addIssue({ code: 'custom', path: [], message: 'x', params: { safeCode: 'copied' } });
      }),
      safeCustomIssues: { copied: 'Fixed hint for copies.' },
      repairWithPreviousAnswer: true,
      repairNotes: (previousAnswer) => `NOTES-OF[${previousAnswer}]`,
      secondRepairOnlyFor: ['copied'],
    };
    const withoutField: ReasoningRole<unknown> = (({ secondRepairOnlyFor: _unused, ...rest }) => rest)(copying);
    const kept = { primary: 'ANSWER-OF-PRIMARY', repair: 'ANSWER-OF-FIRST-REPAIR' } as const;
    const mixed = '{"ok":"no"}';

    it('runs exactly one more repair when the first repair’s findings are all of its codes, a new attempt caused by the first repair', async () => {
      const { harness, sent, reserved } = scriptedEngine({ replies: [invalid, invalid, valid], keptByStep: kept });
      const outcome = await harness.propose(input({ role: copying }), signal);
      expect(outcome).toMatchObject({ kind: 'proposed', output: { ok: true }, repaired: true });
      expect(outcome).toMatchObject({ attemptId: reserved[2]?.id });
      expect(sent).toHaveLength(3);
      // Its own reservation, each a new attempt of its own step, caused by the attempt it repairs.
      expect(reserved.map((reservation) => reservation.step)).toEqual(['primary', 'repair', 'repair2']);
      expect(new Set(reserved.map((reservation) => reservation.id)).size).toBe(3);
      expect(reserved.map((reservation) => reservation.causationAttemptId)).toEqual([
        undefined,
        reserved[0]?.id,
        reserved[1]?.id,
      ]);
      for (const reservation of reserved) expect(reservation.reservedTokens).toBeGreaterThan(0);
      expect(sent[2]?.system).toContain('Validation: your previous answer');
      expect(sent[2]?.system).toContain('Fixed hint for copies.');
    });

    it('sends the first repair’s answer and the notes built from it, not the first write’s', async () => {
      const { harness, sent } = scriptedEngine({ replies: [invalid, invalid, valid], keptByStep: kept });
      await harness.propose(input({ role: copying }), signal);
      expect(sent[1]?.user).toContain('ANSWER-OF-PRIMARY');
      expect(sent[1]?.user).toContain('NOTES-OF[ANSWER-OF-PRIMARY]');
      expect(sent[2]?.user).toContain('ANSWER-OF-FIRST-REPAIR');
      expect(sent[2]?.user).toContain('NOTES-OF[ANSWER-OF-FIRST-REPAIR]');
      expect(sent[2]?.user).not.toContain('ANSWER-OF-PRIMARY');
    });

    it('never sends a third repair: a proposal is three attempts at most', async () => {
      const { harness, sent, reserved } = scriptedEngine({
        replies: [invalid, invalid, invalid, valid],
        keptByStep: kept,
      });
      const outcome = await harness.propose(input({ role: copying }), signal);
      expect(outcome).toMatchObject({ kind: 'invalid_output', reason: 'OUTPUT_SCHEMA_MISMATCH' });
      // The answer it ends on is the last one it was given: the second repair's.
      expect(outcome).toMatchObject({ attemptId: reserved[2]?.id });
      expect(sent).toHaveLength(3);
      expect(reserved).toHaveLength(3);
    });

    it('sends none after a first repair refused for anything else, or for a mix of kinds', async () => {
      const { harness, sent, reserved } = scriptedEngine({ replies: [invalid, mixed, valid], keptByStep: kept });
      const outcome = await harness.propose(input({ role: copying }), signal);
      expect(outcome).toMatchObject({ kind: 'invalid_output', attemptId: reserved[1]?.id });
      expect(sent).toHaveLength(2);
      expect(reserved.map((reservation) => reservation.step)).toEqual(['primary', 'repair']);
    });

    it('sends none after a first repair whose outcome is unknown or failed', async () => {
      const unknown = scriptedEngine({
        replies: [invalid, new ModelOutcomeUnknownError('TIMEOUT'), valid],
        keptByStep: kept,
      });
      await expect(unknown.harness.propose(input({ role: copying }), signal)).resolves.toMatchObject({
        kind: 'unknown',
      });
      expect(unknown.sent).toHaveLength(2);
      const failed = scriptedEngine({
        replies: [invalid, new ModelRejectedError('HTTP_500'), valid],
        keptByStep: kept,
      });
      await expect(failed.harness.propose(input({ role: copying }), signal)).resolves.toMatchObject({
        kind: 'failed',
        code: 'HTTP_500',
      });
      expect(failed.sent).toHaveLength(2);
    });

    it('sends no repair at all when the caller forbids it, and narrows only the first repair with repairOnlyFor', async () => {
      const forbidden = scriptedEngine({ replies: [invalid, invalid, valid], keptByStep: kept });
      await expect(
        forbidden.harness.propose(input({ role: copying, limits: { allowRepair: false } }), signal),
      ).resolves.toMatchObject({ kind: 'invalid_output' });
      expect(forbidden.sent).toHaveLength(1);
      const narrowed = scriptedEngine({ replies: [invalid, invalid, valid], keptByStep: kept });
      await expect(
        narrowed.harness.propose(input({ role: copying, limits: { repairOnlyFor: ['another_code'] } }), signal),
      ).resolves.toMatchObject({ kind: 'invalid_output' });
      expect(narrowed.sent).toHaveLength(1);
      // The first repair is allowed for the role's code; the second is then the role's own decision.
      const allowed = scriptedEngine({ replies: [invalid, invalid, valid], keptByStep: kept });
      await expect(
        allowed.harness.propose(input({ role: copying, limits: { repairOnlyFor: ['copied'] } }), signal),
      ).resolves.toMatchObject({ kind: 'proposed', repaired: true });
      expect(allowed.sent).toHaveLength(3);
    });

    it('sends none when the first repair’s answer was not kept: there is nothing for it to revise', async () => {
      const { harness, sent } = scriptedEngine({ replies: [invalid, invalid, valid], keptByStep: { primary: 'x' } });
      await expect(harness.propose(input({ role: copying }), signal)).resolves.toMatchObject({
        kind: 'invalid_output',
      });
      expect(sent).toHaveLength(2);
    });

    it('stops at the role’s budget for the attempt: each repair is reserved and checked on its own', async () => {
      // Two requests a day for the role: the primary and the first repair fit; the second repair does not, and nothing is sent for it.
      const tight = scriptedEngine({ replies: [invalid, invalid, valid], keptByStep: kept, roleRequestsPerDay: 2 });
      await expect(tight.harness.propose(input({ role: copying }), signal)).resolves.toEqual({
        kind: 'budget_exhausted',
        dimension: 'role',
        limit: 'requests',
      });
      expect(tight.sent).toHaveLength(2);
      expect(tight.reserved).toHaveLength(2);
      const roomy = scriptedEngine({ replies: [invalid, invalid, valid], keptByStep: kept, roleRequestsPerDay: 3 });
      await expect(roomy.harness.propose(input({ role: copying }), signal)).resolves.toMatchObject({
        kind: 'proposed',
      });
      expect(roomy.reserved).toHaveLength(3);
    });

    it('counts a refusal with more findings than the harness lists as mixed: its `more` entry is not a copy, so it gets no second repair', async () => {
      // The harness lists at most eight findings and closes the list with a `more` entry (`MAX_ISSUES`). That entry's code is not the role's,
      // and what it counts is unknown, so a refusal that was cut is not one of copies only.
      const copiesAt = (count: number): ReasoningRole<unknown> => ({
        ...copying,
        outputSchema: z.object({ ok: z.boolean() }).superRefine((value, context) => {
          if (!value.ok)
            for (let index = 0; index < count; index += 1)
              context.addIssue({ code: 'custom', path: [], message: 'x', params: { safeCode: 'copied' } });
        }),
      });
      const eight = scriptedEngine({ replies: [invalid, invalid, valid], keptByStep: kept });
      await expect(eight.harness.propose(input({ role: copiesAt(8) }), signal)).resolves.toMatchObject({
        kind: 'proposed',
        repaired: true,
      });
      expect(eight.sent).toHaveLength(3);
      const nine = scriptedEngine({ replies: [invalid, invalid, valid], keptByStep: kept });
      await expect(nine.harness.propose(input({ role: copiesAt(9) }), signal)).resolves.toMatchObject({
        kind: 'invalid_output',
      });
      expect(nine.sent).toHaveLength(2);
      expect(nine.sent[1]?.system).toContain('(root): more (1 more)');
    });

    it('sends none when no request that carries the first repair’s answer fits: the findings alone are not a second repair', async () => {
      const big = { primary: 'small answer', repair: 'x'.repeat(4_000) };
      const fits = scriptedEngine({ replies: [invalid, invalid, valid], keptByStep: big, maxRequestBytes: 20_000 });
      await expect(fits.harness.propose(input({ role: copying }), signal)).resolves.toMatchObject({ kind: 'proposed' });
      expect(fits.sent).toHaveLength(3);
      // The first repair fits (it carries the small answer); the second would carry 4,000 characters more than the limit allows.
      const tight = scriptedEngine({ replies: [invalid, invalid, valid], keptByStep: big, maxRequestBytes: 3_000 });
      await expect(tight.harness.propose(input({ role: copying }), signal)).resolves.toMatchObject({
        kind: 'invalid_output',
      });
      expect(tight.sent).toHaveLength(2);
      expect(tight.reserved.map((reservation) => reservation.step)).toEqual(['primary', 'repair']);
    });

    it('refuses a role that names no code, a malformed one, or has no refused answer to revise, before anything is sent', async () => {
      for (const role of [
        { ...copying, secondRepairOnlyFor: [] },
        { ...copying, secondRepairOnlyFor: ['Not A Code'] },
        { ...copying, secondRepairOnlyFor: Array.from({ length: 17 }, (_unused, index) => `code_${String(index)}`) },
        { ...copying, repairWithPreviousAnswer: false },
      ]) {
        const { harness, sent } = scriptedEngine({ replies: [invalid, invalid, valid], keptByStep: kept });
        await expect(harness.propose(input({ role }), signal)).resolves.toEqual({
          kind: 'refused',
          reason: 'role_invalid',
        });
        expect(sent).toHaveLength(0);
      }
    });

    describe('a role without the field is as it was, one repair and no more', () => {
      it('gives up after one repair, with the same requests and the same reservations as the role with the field up to that point', async () => {
        const without = scriptedEngine({ replies: [invalid, invalid, valid], keptByStep: kept });
        await expect(without.harness.propose(input({ role: withoutField }), signal)).resolves.toMatchObject({
          kind: 'invalid_output',
        });
        expect(without.sent).toHaveLength(2);
        expect(without.reserved.map((reservation) => reservation.step)).toEqual(['primary', 'repair']);
        const opted = scriptedEngine({ replies: [invalid, valid], keptByStep: kept });
        await opted.harness.propose(input({ role: copying }), signal);
        // The first two requests do not depend on the field: byte for byte the same.
        expect(JSON.stringify(opted.sent)).toBe(JSON.stringify(without.sent));
        expect(opted.reserved.slice(0, 2).map((reservation) => reservation.requestHash)).toEqual(
          without.reserved.map((reservation) => reservation.requestHash),
        );
      });

      it('sends the requests it sent before the field existed, pinned by their hash', async () => {
        // The digest was taken from the harness as it was before D-445, over the same script: a primary refused, a first repair
        // that carries its answer and its notes, and a first repair refused again. Any change to either request changes it.
        const { harness, sent, reserved } = scriptedEngine({ replies: [invalid, invalid, valid], keptByStep: kept });
        await harness.propose(input({ role: withoutField }), signal);
        const digest = createHash('sha256').update(JSON.stringify(sent)).digest('hex');
        expect(digest).toBe(PRE_D445_REQUESTS_SHA256);
        expect(reserved.map((reservation) => [reservation.step, reservation.requestHash])).toEqual(
          PRE_D445_RESERVATIONS,
        );
        expect(reserved.map((reservation) => reservation.causationAttemptId)).toEqual([undefined, reserved[0]?.id]);
      });
    });
  });

  describe('the repair request for a role that revises its refused answer', () => {
    const keptAnswer = `PREVIOUS-ANSWER ${'x'.repeat(1_000)}`;
    const revising: ReasoningRole<unknown> = {
      ...input().role,
      repairWithPreviousAnswer: true,
      repairNotes: () => 'NOTES-FROM-THE-ROLE '.repeat(5),
    };
    const sizeOf = (request: ModelRequest | undefined) => JSON.stringify(request).length;
    /** The size of the richest repair request, measured with no limit. */
    async function fullRepairSize() {
      const { harness, sent } = scriptedEngine({ replies: [invalid, valid], keptAnswer });
      await harness.propose(input({ role: revising }), signal);
      return sizeOf(sent[1]);
    }

    it('sends the answer and the role’s notes when they fit', async () => {
      const { harness, sent } = scriptedEngine({ replies: [invalid, valid], keptAnswer });
      await harness.propose(input({ role: revising }), signal);
      expect(sent[1]?.user).toContain('PREVIOUS-ANSWER');
      expect(sent[1]?.user).toContain('NOTES-FROM-THE-ROLE');
    });

    it('drops the notes first when the request would be too large', async () => {
      const limit = (await fullRepairSize()) - 10;
      const { harness, sent } = scriptedEngine({ replies: [invalid, valid], keptAnswer, maxRequestBytes: limit });
      await expect(harness.propose(input({ role: revising }), signal)).resolves.toMatchObject({ repaired: true });
      expect(sent[1]?.user).toContain('PREVIOUS-ANSWER');
      expect(sent[1]?.user).not.toContain('NOTES-FROM-THE-ROLE');
    });

    it('then drops the answer, keeping the findings', async () => {
      const limit = (await fullRepairSize()) - 700;
      const { harness, sent } = scriptedEngine({ replies: [invalid, valid], keptAnswer, maxRequestBytes: limit });
      await expect(harness.propose(input({ role: revising }), signal)).resolves.toMatchObject({ repaired: true });
      expect(sent[1]?.user).not.toContain('PREVIOUS-ANSWER');
      expect(sent[1]?.system).toContain('ok: invalid_value');
    });

    it('keeps the refusal of the first answer when not even the findings fit', async () => {
      const { harness, sent } = scriptedEngine({ replies: [invalid, valid], keptAnswer });
      await harness.propose(input({ role: revising }), signal);
      const primarySize = sizeOf(sent[0]);
      const tight = scriptedEngine({ replies: [invalid, valid], keptAnswer, maxRequestBytes: primarySize + 5 });
      await expect(tight.harness.propose(input({ role: revising }), signal)).resolves.toMatchObject({
        kind: 'invalid_output',
        reason: 'OUTPUT_SCHEMA_MISMATCH',
      });
      expect(tight.sent).toHaveLength(1);
    });

    it('sends no answer when the role does not ask for it', async () => {
      const { harness, sent } = scriptedEngine({ replies: [invalid, valid], keptAnswer });
      await harness.propose(input(), signal);
      expect(sent[1]?.user).not.toContain('PREVIOUS-ANSWER');
    });
  });
});
