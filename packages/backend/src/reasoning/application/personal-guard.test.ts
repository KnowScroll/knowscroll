import { describe, expect, it, vi } from 'vitest';
import type { PersonalAuthority, PersonalScopeTx } from '../../modules/identity/public.js';
import { PersonalCall, guardPersonalLedger, requirePersonalAccess } from './personal-guard.js';
import {
  PersonalReasoningRefused,
  type AttemptRef,
  type HarnessPorts,
  type PersonalHarnessAccess,
  type RunDescriptor,
} from './ports.js';

// Hand-built protocol fixtures: fake ports and a fake ledger. No database, provider or real authority.
const universeId = '0199f0a0-0000-7000-8000-000000000002';
const runId = '0199f0a0-0000-7000-8000-000000000003';
const authority: PersonalAuthority = {
  universeId,
  privacyEpoch: 7,
  actor: { kind: 'system', purpose: 'fixture.reasoning' },
};
const scope = {} as PersonalScopeTx;
const requestHash = 'b'.repeat(64);
const descriptor: RunDescriptor = {
  id: runId,
  ownerModule: 'fixture',
  purpose: 'fixture-purpose',
  roleId: 'fixture.echo',
  roleVersion: 'v1',
  policyVersion: 'fixture.v1',
  provider: 'fixture',
  model: 'fixture-model',
  contextBundleRef: 'fixture.bundle:1',
  contextRefs: ['fixture:item'],
};
const attempt: AttemptRef = { scopeId: universeId, attemptId: '0199f0a0-0000-7000-8000-000000000009' };

type Entry = Awaited<ReturnType<PersonalHarnessAccess['enter']>>;

function fixture(options: { recording?: RunDescriptor['recording']; enter?: () => Promise<Entry> } = {}) {
  const access = {
    enter: vi.fn(async (_authority, _descriptor, _purpose, work: (scope: PersonalScopeTx) => Promise<unknown>) =>
      options.enter === undefined ? { kind: 'entered' as const, value: await work(scope) } : options.enter(),
    ),
    check: vi.fn(() => Promise.resolve()),
    checkAttempt: vi.fn(() => Promise.resolve()),
    readProtected: vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3]))),
  };
  const ledger = {
    findLocked: vi.fn(() => Promise.resolve(undefined)),
    admitRun: vi.fn(() => Promise.resolve({ kind: 'admitted' as const, fence: 1 })),
    budgetUsage: vi.fn(() => Promise.resolve({ global: {}, scope: {}, role: {} })),
    canStartRun: vi.fn(() => Promise.resolve(true)),
    reserve: vi.fn(() => Promise.resolve()),
    commitDispatch: vi.fn(() => Promise.resolve(true)),
    settle: vi.fn(() => Promise.resolve(true)),
    purgeExpiredRequests: vi.fn(() => Promise.resolve(3)),
    releaseUndispatchedPersonal: vi.fn((): Promise<'released' | 'unavailable'> => Promise.resolve('released')),
  };
  const clock = { now: 1_000 };
  const ports = {
    personalAccess: access,
    ledger,
    authorityHolds: vi.fn(() => Promise.resolve(true)),
    now: () => clock.now,
    settings: { purgeIntervalMs: 1_000 },
  } as unknown as HarnessPorts;
  const withRecording = options.recording === undefined ? descriptor : { ...descriptor, recording: options.recording };
  const call = new PersonalCall(ports, undefined, authority, withRecording);
  return { access, ledger, clock, ports, call, guarded: guardPersonalLedger(call, ports) };
}

const refused = (kind: string, accountingRevoked?: true): Entry => ({
  kind: 'refused',
  refusal: { kind, ...(accountingRevoked === undefined ? {} : { accountingRevoked }) },
});

describe('requirePersonalAccess', () => {
  it('refuses ports without a complete personal access adapter', () => {
    const { ports } = fixture();
    expect(() => requirePersonalAccess(ports)).not.toThrow();
    const access = ports.personalAccess as unknown as Record<string, unknown>;
    expect(() => requirePersonalAccess({ ...ports, personalAccess: undefined } as unknown as HarnessPorts)).toThrow(
      'PERSONAL_REASONING_ACCESS_REQUIRED',
    );
    for (const missing of ['enter', 'check', 'checkAttempt', 'readProtected'])
      expect(() =>
        requirePersonalAccess({
          ...ports,
          personalAccess: { ...access, [missing]: undefined },
        } as unknown as HarnessPorts),
      ).toThrow('PERSONAL_REASONING_ACCESS_REQUIRED');
  });
});

describe('the attempt the private reads are bound to', () => {
  it('refuses any read before an attempt is planned, and a read of another step', async () => {
    const { call, access } = fixture();
    await expect(call.checkAttempt(scope, 'primary')).rejects.toMatchObject({ reason: 'request_mismatch' });
    call.plan('primary', requestHash);
    await expect(call.checkAttempt(scope, 'repair')).rejects.toMatchObject({ reason: 'request_mismatch' });
    expect(access.checkAttempt).not.toHaveBeenCalled();
  });

  it('checks the planned step and request hash with the access adapter', async () => {
    const { call, access } = fixture();
    call.plan('repair', requestHash);
    await call.checkAttempt(scope, 'repair');
    expect(access.checkAttempt).toHaveBeenCalledWith(scope, descriptor, 'repair', requestHash);
  });

  it('reads the protected request of the planned attempt under the lock', async () => {
    const { call, access } = fixture();
    await expect(call.readProtectedRequest(attempt)).rejects.toMatchObject({ reason: 'request_mismatch' });
    call.plan('primary', requestHash);
    await expect(call.readProtectedRequest(attempt)).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(access.readProtected).toHaveBeenCalledWith(scope, descriptor, attempt, 'primary', requestHash);
  });

  it('answers a read the adapter refuses with its reason, or scope_refused for any other kind', async () => {
    for (const [kind, reason] of [
      ['run_mismatch', 'run_mismatch'],
      ['run_closed', 'run_closed'],
      ['output_ineligible', 'output_ineligible'],
      ['request_mismatch', 'request_mismatch'],
      ['authority_gone', 'scope_refused'],
    ] as const) {
      const { call } = fixture({ enter: () => Promise.resolve(refused(kind, true)) });
      call.plan('primary', requestHash);
      await expect(call.readProtectedRequest(attempt)).rejects.toMatchObject({
        reason,
        accountingRevoked: true,
      });
    }
  });
});

describe('inspecting the ledger', () => {
  it('refuses another universe or run before entering the scope', async () => {
    const { call, access } = fixture();
    call.plan('primary', requestHash);
    await expect(call.findAttempt('0199f0a0-0000-7000-8000-0000000000ff', runId, 'primary')).rejects.toMatchObject({
      reason: 'run_mismatch',
    });
    await expect(call.findAttempt(universeId, '0199f0a0-0000-7000-8000-0000000000ff', 'primary')).rejects.toMatchObject(
      {
        reason: 'run_mismatch',
      },
    );
    expect(access.enter).not.toHaveBeenCalled();
  });

  it('reads the latest attempt under the lock after checking the planned attempt', async () => {
    const { call, ledger, access } = fixture();
    call.plan('primary', requestHash);
    await call.findAttempt(universeId, runId, 'primary');
    expect(access.checkAttempt).toHaveBeenCalledWith(scope, descriptor, 'primary', requestHash);
    expect(ledger.findLocked).toHaveBeenCalledWith(scope, runId, 'primary');
  });

  it('rechecks authority before any other read or write in the open scope', async () => {
    const { guarded, ledger, access, call } = fixture();
    call.plan('primary', requestHash);
    access.check.mockRejectedValue(new PersonalReasoningRefused('scope_refused'));
    await expect(guarded.budgetUsage(scope, 'fixture.echo')).rejects.toBeInstanceOf(PersonalReasoningRefused);
    await expect(guarded.canStartRun(scope, 'fixture.echo')).rejects.toBeInstanceOf(PersonalReasoningRefused);
    await expect(guarded.findLocked(scope, runId, 'primary')).rejects.toBeInstanceOf(PersonalReasoningRefused);
    await expect(
      guarded.commitDispatch(scope, attempt.attemptId, {
        dispatchId: 'd',
        dispatchedBy: 'worker:1',
        quota: { verdict: 'not_applicable', intervalRemainingPercent: null, weeklyRemainingPercent: null },
      }),
    ).rejects.toBeInstanceOf(PersonalReasoningRefused);
    expect(ledger.budgetUsage).not.toHaveBeenCalled();
    expect(ledger.canStartRun).not.toHaveBeenCalled();
    expect(ledger.findLocked).not.toHaveBeenCalled();
    expect(ledger.commitDispatch).not.toHaveBeenCalled();
  });

  it('adds the run’s recording proof when it is admitted', async () => {
    const recording = {
      accountId: '0199f0a0-0000-7000-8000-000000000001',
      generation: 3,
      contextSha256: 'a'.repeat(64),
      modelContextSha256: 'c'.repeat(64),
    };
    const { guarded, ledger } = fixture({ recording });
    await guarded.admitRun(scope, descriptor);
    expect(ledger.admitRun).toHaveBeenCalledWith(scope, { ...descriptor, recording });
    const plain = fixture();
    await plain.guarded.admitRun(scope, descriptor);
    expect(plain.ledger.admitRun).toHaveBeenCalledWith(scope, descriptor);
  });

  it('refuses a locked read for another run', async () => {
    const { guarded, call } = fixture();
    call.plan('primary', requestHash);
    await expect(guarded.findLocked(scope, 'another-run', 'primary')).rejects.toMatchObject({
      reason: 'run_mismatch',
    });
  });
});

describe('settling a reservation the engine could not dispatch', () => {
  const authorityRefused = { outcomeCode: 'AUTHORITY_REFUSED' };

  it('releases it when revoked authority refused the entry and the ledger proves it never dispatched', async () => {
    const { guarded, call, ledger } = fixture({ enter: () => Promise.resolve(refused('scope_refused', true)) });
    call.plan('primary', requestHash);
    await call.enter(authority, () => Promise.resolve(true));
    await expect(guarded.settle(attempt, 'reserved', 'not_sent', authorityRefused)).resolves.toBe(true);
    expect(ledger.releaseUndispatchedPersonal).toHaveBeenCalledWith({
      scopeId: universeId,
      privacyEpoch: 7,
      run: descriptor,
      step: 'primary',
      requestHash,
      attemptId: attempt.attemptId,
    });
    expect(ledger.settle).not.toHaveBeenCalled();
  });

  it('keeps it held when the ledger cannot prove it', async () => {
    const { guarded, call, ledger } = fixture({ enter: () => Promise.resolve(refused('scope_refused', true)) });
    ledger.releaseUndispatchedPersonal.mockResolvedValue('unavailable');
    call.plan('primary', requestHash);
    await call.enter(authority, () => Promise.resolve(true));
    await expect(guarded.settle(attempt, 'reserved', 'not_sent', authorityRefused)).resolves.toBe(false);
  });

  it.each([
    ['the refusal did not come from revoked authority', refused('scope_refused'), attempt, true],
    ['the last entry was granted', undefined, attempt, true],
    ['the attempt belongs to another universe', refused('scope_refused', true), { ...attempt, scopeId: 'other' }, true],
    ['nothing was planned', refused('scope_refused', true), attempt, false],
  ] as const)('does not release it when %s', async (_name, entry, target, planned) => {
    const { guarded, call, ledger } = fixture(entry === undefined ? {} : { enter: () => Promise.resolve(entry) });
    if (planned) call.plan('primary', requestHash);
    await call.enter(authority, () => Promise.resolve(true));
    await expect(guarded.settle(target, 'reserved', 'not_sent', authorityRefused)).resolves.toBe(false);
    expect(ledger.releaseUndispatchedPersonal).not.toHaveBeenCalled();
    expect(ledger.settle).not.toHaveBeenCalled();
  });

  it('forgets a revoked refusal once a later entry is granted', async () => {
    const { guarded, call, access, ledger } = fixture();
    access.enter.mockResolvedValueOnce(refused('scope_refused', true));
    call.plan('primary', requestHash);
    await call.enter(authority, () => Promise.resolve(true));
    await call.enter(authority, () => Promise.resolve(true));
    await expect(guarded.settle(attempt, 'reserved', 'not_sent', authorityRefused)).resolves.toBe(false);
    expect(ledger.releaseUndispatchedPersonal).not.toHaveBeenCalled();
  });
});

describe('settling an attempt', () => {
  it('always accounts, and reports through the call only what the ledger settled', async () => {
    const { guarded, call, ledger } = fixture();
    call.plan('primary', requestHash);
    ledger.settle.mockResolvedValueOnce(false);
    await expect(guarded.settle(attempt, 'dispatched', 'succeeded', { outcomeCode: 'SUCCEEDED' })).resolves.toBe(false);
    await expect(call.refusalReason(new PersonalReasoningRefused('run_closed'))).resolves.toBe('run_closed');
    await expect(guarded.settle(attempt, 'dispatched', 'succeeded', { outcomeCode: 'SUCCEEDED' })).resolves.toBe(true);
    expect(ledger.settle).toHaveBeenCalledWith(attempt, 'dispatched', 'succeeded', { outcomeCode: 'SUCCEEDED' });
    await expect(call.refusalReason(new PersonalReasoningRefused('run_closed'))).resolves.toBe('output_ineligible');
  });
});

describe('what to report after authority refused something', () => {
  it('releases the planned reservation when a revoked private read refused before any settlement', async () => {
    const { call, ledger } = fixture();
    call.plan('repair', requestHash);
    const reason = await call.refusalReason(new PersonalReasoningRefused('scope_refused', true));
    expect(reason).toBe('scope_refused');
    expect(ledger.releaseUndispatchedPersonal).toHaveBeenCalledWith({
      scopeId: universeId,
      privacyEpoch: 7,
      run: descriptor,
      step: 'repair',
      requestHash,
    });
  });

  it.each([
    ['the refusal is not a scope refusal', new PersonalReasoningRefused('run_closed', true), 'run_closed'],
    ['authority was not revoked', new PersonalReasoningRefused('scope_refused'), 'scope_refused'],
  ] as const)('releases nothing when %s', async (_name, refusal, expected) => {
    const { call, ledger } = fixture();
    call.plan('primary', requestHash);
    await expect(call.refusalReason(refusal)).resolves.toBe(expected);
    expect(ledger.releaseUndispatchedPersonal).not.toHaveBeenCalled();
  });

  it('releases nothing when no attempt was planned, and nothing after a settlement', async () => {
    const unplanned = fixture();
    await unplanned.call.refusalReason(new PersonalReasoningRefused('scope_refused', true));
    expect(unplanned.ledger.releaseUndispatchedPersonal).not.toHaveBeenCalled();
    const settled = fixture();
    settled.call.plan('primary', requestHash);
    settled.call.recordSettlement();
    await expect(settled.call.refusalReason(new PersonalReasoningRefused('scope_refused', true))).resolves.toBe(
      'output_ineligible',
    );
    expect(settled.ledger.releaseUndispatchedPersonal).not.toHaveBeenCalled();
  });
});

describe('whether the owner’s authority holds', () => {
  it('is false without entering when the lock-free check fails', async () => {
    const { call, ports, access } = fixture();
    vi.mocked(ports.authorityHolds).mockResolvedValue(false);
    await expect(call.authorityHolds(authority)).resolves.toBe(false);
    expect(access.enter).not.toHaveBeenCalled();
  });

  it('is true only when the scope is entered, and false when the entry is refused or throws a refusal', async () => {
    await expect(fixture().call.authorityHolds(authority)).resolves.toBe(true);
    await expect(
      fixture({ enter: () => Promise.resolve(refused('scope_refused')) }).call.authorityHolds(authority),
    ).resolves.toBe(false);
    await expect(
      fixture({ enter: () => Promise.reject(new PersonalReasoningRefused('scope_refused')) }).call.authorityHolds(
        authority,
      ),
    ).resolves.toBe(false);
  });

  it('lets an infrastructure failure propagate', async () => {
    const failure = new Error('database unavailable');
    await expect(fixture({ enter: () => Promise.reject(failure) }).call.authorityHolds(authority)).rejects.toBe(
      failure,
    );
  });
});

describe('purging expired request bytes', () => {
  it('purges at most once per interval per ports object, however many calls ask', async () => {
    const first = fixture();
    const second = guardPersonalLedger(new PersonalCall(first.ports, undefined, authority, descriptor), first.ports);
    await expect(first.guarded.purgeExpiredRequests(500)).resolves.toBe(3);
    first.clock.now += 999;
    await expect(first.guarded.purgeExpiredRequests(500)).resolves.toBe(0);
    await expect(second.purgeExpiredRequests(500)).resolves.toBe(0);
    expect(first.ledger.purgeExpiredRequests).toHaveBeenCalledTimes(1);
    first.clock.now += 1;
    await expect(second.purgeExpiredRequests(500)).resolves.toBe(3);
    expect(first.ledger.purgeExpiredRequests).toHaveBeenCalledTimes(2);
    expect(first.ledger.purgeExpiredRequests).toHaveBeenLastCalledWith(500);
  });

  it('keeps a separate throttle for each ports object', async () => {
    const one = fixture();
    const other = fixture();
    await one.guarded.purgeExpiredRequests(500);
    await expect(other.guarded.purgeExpiredRequests(500)).resolves.toBe(3);
  });
});
