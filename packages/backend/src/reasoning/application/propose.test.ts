import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NO_USAGE } from '../domain/budgets.js';
import { makeScopedReasoningHarness, type ProposeInput, type ReasoningRole } from './propose.js';
import type {
  AttemptLedger,
  AttemptRow,
  ExecutionPorts,
  GuardedModelPort,
  ModelReply,
  ModelRequest,
  Reservation,
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

/** An in-memory attempt ledger: just enough state for one primary attempt and one repair. */
function memoryLedger(options: { keptAnswer?: string } = {}) {
  const rows = new Map<string, { -readonly [K in keyof AttemptRow]: AttemptRow[K] }>();
  const spend = { requests: 0, tokens: 0 };
  const ledger = {
    find: (_scopeId: string, _runId: string, step: string) => Promise.resolve(rows.get(step)),
    findLocked: (_scope: null, _runId: string, step: string) => Promise.resolve(rows.get(step)),
    admitRun: () => Promise.resolve({ kind: 'admitted' as const, fence: 1 }),
    budgetUsage: () =>
      Promise.resolve({ global: spend, role: spend, scope: spend, background: { global: spend, scope: spend } }),
    canStartRun: () => Promise.resolve(true),
    reserve: (_scope: null, reservation: Reservation) => {
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
    readRejectedAnswerText: () => Promise.resolve(options.keptAnswer),
    purgeExpiredRequests: () => Promise.resolve(0),
  };
  return ledger as unknown as AttemptLedger<null>;
}

/** The whole engine over the in-memory ledger and a scripted model: no database, no provider. */
function scriptedEngine(options: { replies: readonly string[]; maxRequestBytes?: number; keptAnswer?: string }) {
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
      return Promise.resolve({
        usage: NO_USAGE,
        answer: { kind: 'text', text: answers.shift() ?? '{}', stop: 'end' },
      });
    },
  } as unknown as GuardedModelPort;
  const ports = {
    model,
    ledger: memoryLedger(options.keptAnswer === undefined ? {} : { keptAnswer: options.keptAnswer }),
    hashBytes: (bytes: Uint8Array) => `hash-${bytes.length}`,
    redactRecorded: (value: Readonly<Record<string, unknown>>) => value,
    newId: () => `0199f0a0-0000-7000-8000-${String(++nextId).padStart(12, '0')}`,
    now: () => 1_000,
    logEvent: vi.fn(),
    settings: {
      caps: {
        global: { requestsPerDay: 1_000, tokensPerDay: 1e9 },
        scope: { requestsPerDay: 1_000, tokensPerDay: 1e9 },
        roleDefault: { requestsPerDay: 1_000, tokensPerDay: 1e9 },
      },
      backgroundSharePercent: 100,
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
  return { harness: makeScopedReasoningHarness(ports), sent };
}

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
