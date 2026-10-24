import type { PersonalAuthority, PersonalScopeTx } from '../../modules/identity/public.js';
import { outcomeCodes } from './execute-attempt.js';
import {
  PersonalReasoningRefused,
  type AttemptLedger,
  type AttemptRef,
  type AttemptRow,
  type HarnessPorts,
  type PersonalRecordingPurpose,
  type RunDescriptor,
} from './ports.js';

/**
 * The personal authority binding of the shared engine. The engine knows nothing about universes:
 * it runs attempts against an `AttemptLedger` and a `withScope`. For a personal run both are
 * replaced by the versions here, which recheck the owner's authority under the personal lock
 * before every private read or write (blueprint §15, §19) and still let every outcome be accounted
 * after authority is gone.
 */

/** The attempt the engine is about to run: the private-read checks bind to exactly this request. */
interface PlannedAttempt {
  readonly step: 'primary' | 'repair';
  readonly requestHash: string;
}

type ScopeEntry<T> =
  | { readonly kind: 'entered'; readonly value: T }
  | { readonly kind: 'refused'; readonly refusal: { readonly kind: string; readonly accountingRevoked?: true } };

type ReportedRefusal = Exclude<PersonalReasoningRefused['reason'], 'scope_refused'>;

/** Refusal kinds the personal access adapter raises that the caller sees as they are; any other is `scope_refused`. */
function isReportedRefusal(kind: string): kind is ReportedRefusal {
  return (
    kind === 'run_mismatch' || kind === 'run_closed' || kind === 'output_ineligible' || kind === 'request_mismatch'
  );
}

/** The value of a scope entry that was granted; a refusal becomes `PersonalReasoningRefused`. */
function enteredValue<T>(entry: ScopeEntry<T>): T {
  if (entry.kind === 'entered') return entry.value;
  throw new PersonalReasoningRefused(
    isReportedRefusal(entry.refusal.kind) ? entry.refusal.kind : 'scope_refused',
    entry.refusal.accountingRevoked === true,
  );
}

/** Refuses a harness built without the personal access adapter: private reads would be unguarded. */
export function requirePersonalAccess(ports: HarnessPorts): void {
  const access = ports.personalAccess;
  if (
    !access ||
    typeof access.enter !== 'function' ||
    typeof access.check !== 'function' ||
    typeof access.checkAttempt !== 'function' ||
    typeof access.readProtected !== 'function'
  )
    throw new Error('PERSONAL_REASONING_ACCESS_REQUIRED');
}

/**
 * What one personal `propose` call has learned while the engine ran its attempts. The engine
 * reports progress only through plan and ledger callbacks, so the guards read it from here. One
 * instance per call, never shared between calls. The three facts and who changes them:
 *
 * - the planned attempt: set by the engine before each attempt (`plan`);
 * - whether the latest refused scope entry came from revoked authority whose reservation may
 *   still be released (`enter`);
 * - whether any attempt was settled in the ledger (`recordSettlement`).
 */
export class PersonalCall {
  #planned: PlannedAttempt | undefined;
  #accountingRevoked = false;
  #settled = false;

  constructor(
    private readonly ports: HarnessPorts,
    private readonly purpose: PersonalRecordingPurpose | undefined,
    readonly authority: PersonalAuthority,
    readonly descriptor: RunDescriptor,
  ) {}

  /** The engine is about to run this attempt; later private reads must match it exactly. */
  plan(step: 'primary' | 'repair', requestHash: string): void {
    this.#planned = { step, requestHash };
  }

  /** Enters the personal scope, with the authority recheck after the lock wait. */
  async enter<T>(authority: PersonalAuthority, work: (scope: PersonalScopeTx) => Promise<T>): Promise<ScopeEntry<T>> {
    this.#accountingRevoked = false;
    const entry = await this.ports.personalAccess.enter(authority, this.descriptor, this.purpose, work);
    this.#accountingRevoked = entry.kind === 'refused' && entry.refusal.accountingRevoked === true;
    return entry;
  }

  /** Whether the owner's authority holds right now: the lock-free check, then the scope entry. */
  async authorityHolds(authority: PersonalAuthority): Promise<boolean> {
    if (!(await this.ports.authorityHolds(authority))) return false;
    try {
      return (await this.enter(authority, () => Promise.resolve(true))).kind === 'entered';
    } catch (error) {
      if (error instanceof PersonalReasoningRefused) return false;
      throw error;
    }
  }

  /** Authority recheck for a read or write inside an open scope. */
  check(scope: PersonalScopeTx): Promise<void> {
    return this.ports.personalAccess.check(scope, this.descriptor, this.purpose);
  }

  /** The step being read must be the planned one, and so must the request hash. */
  async checkAttempt(scope: PersonalScopeTx, step: string): Promise<void> {
    const planned = this.#planned;
    if (!planned || step !== planned.step) throw new PersonalReasoningRefused('request_mismatch');
    await this.ports.personalAccess.checkAttempt(scope, this.descriptor, planned.step, planned.requestHash);
  }

  /** Reads the planned attempt's latest ledger row, under the lock. Refusals surface as exceptions. */
  async findAttempt(scopeId: string, runId: string, step: string): Promise<AttemptRow | undefined> {
    if (scopeId !== this.authority.universeId || runId !== this.descriptor.id)
      throw new PersonalReasoningRefused('run_mismatch');
    const entry = await this.enter(this.authority, async (scope) => {
      await this.checkAttempt(scope, step);
      return this.ports.ledger.findLocked(scope, runId, step);
    });
    return enteredValue(entry);
  }

  /** Reads the protected request bytes of the planned attempt under the lock. */
  async readProtectedRequest(attempt: AttemptRef): Promise<Uint8Array | undefined> {
    const planned = this.#planned;
    if (!planned) throw new PersonalReasoningRefused('request_mismatch');
    const entry = await this.enter(this.authority, async (scope) => {
      await this.checkAttempt(scope, planned.step);
      return this.ports.personalAccess.readProtected(
        scope,
        this.descriptor,
        attempt,
        planned.step,
        planned.requestHash,
      );
    });
    return enteredValue(entry);
  }

  /** An attempt was settled in the ledger. Accounting always runs, including after revocation. */
  recordSettlement(): void {
    this.#settled = true;
  }

  /**
   * Releases the reservation of an attempt the engine could not dispatch because authority was
   * refused. It happens only when the refusal came from revoked authority, the attempt belongs to
   * this universe and the ledger can prove the reservation never dispatched. Otherwise it stays held
   * for an operator, so a stale or foreign refusal can never cancel a newer claim's reservation.
   */
  async releaseRefusedReservation(attempt: AttemptRef): Promise<boolean> {
    const planned = this.#planned;
    if (!this.#accountingRevoked || !planned || attempt.scopeId !== this.authority.universeId) return false;
    const released = await this.ports.ledger.releaseUndispatchedPersonal?.({
      scopeId: attempt.scopeId,
      privacyEpoch: this.authority.privacyEpoch,
      run: this.descriptor,
      step: planned.step,
      requestHash: planned.requestHash,
      attemptId: attempt.attemptId,
    });
    return released === 'released';
  }

  /**
   * What to report after authority refused something the engine needed. If an attempt was already
   * settled, an answer exists but may not be returned, so the reason is `output_ineligible`.
   * Otherwise a private read refused after revocation still lets the planned reservation be
   * released when the ledger can prove it never dispatched; without that proof it stays held.
   *
   * Errors from the release propagate: the job retries and finds the same state.
   */
  async refusalReason(refusal: PersonalReasoningRefused): Promise<PersonalReasoningRefused['reason']> {
    const planned = this.#planned;
    if (!this.#settled && refusal.reason === 'scope_refused' && refusal.accountingRevoked && planned) {
      await this.ports.ledger.releaseUndispatchedPersonal?.({
        scopeId: this.authority.universeId,
        privacyEpoch: this.authority.privacyEpoch,
        run: this.descriptor,
        step: planned.step,
        requestHash: planned.requestHash,
      });
    }
    return this.#settled ? 'output_ineligible' : refusal.reason;
  }
}

/** When each ports object last purged: a personal call builds a new engine every time. */
const lastPurgeAt = new WeakMap<HarnessPorts, number>();

/**
 * The attempt ledger of one personal call, grouped by what the engine is doing:
 *
 * - inspection and admission: every read or write under the lock rechecks authority first, and
 *   the run's recording proof is added when the run is admitted;
 * - dispatch: intent is committed, and the protected bytes are read, only for the planned attempt;
 * - settlement: always accounted, even after authority is gone, and remembered on the call;
 * - purge: at most once per `purgeIntervalMs` per ports object, whatever the number of calls.
 *
 * Every other ledger operation passes through unchanged.
 */
export function guardPersonalLedger(call: PersonalCall, ports: HarnessPorts): AttemptLedger {
  const ledger = ports.ledger;
  return {
    ...ledger,

    // Inspection and admission.
    find: (scopeId, runId, step) => call.findAttempt(scopeId, runId, step),
    async findLocked(scope, runId, step) {
      await call.check(scope);
      if (runId !== call.descriptor.id) throw new PersonalReasoningRefused('run_mismatch');
      await call.checkAttempt(scope, step);
      return ledger.findLocked(scope, runId, step);
    },
    async admitRun(scope, run) {
      await call.check(scope);
      return ledger.admitRun(scope, {
        ...run,
        ...(call.descriptor.recording ? { recording: call.descriptor.recording } : {}),
      });
    },
    async budgetUsage(scope, roleId) {
      await call.check(scope);
      return ledger.budgetUsage(scope, roleId);
    },
    async canStartRun(scope, roleId) {
      await call.check(scope);
      return ledger.canStartRun(scope, roleId);
    },
    async reserve(scope, reservation) {
      await call.check(scope);
      return ledger.reserve(scope, reservation);
    },

    // Dispatch.
    async commitDispatch(scope, attemptId, dispatch) {
      await call.check(scope);
      return ledger.commitDispatch(scope, attemptId, dispatch);
    },
    readProtectedRequest: (attempt) => call.readProtectedRequest(attempt),

    // Settlement.
    async settle(attempt, from, to, details) {
      if (from === 'reserved' && to === 'not_sent' && details?.outcomeCode === outcomeCodes.authorityRefused)
        return call.releaseRefusedReservation(attempt);
      const settled = await ledger.settle(attempt, from, to, details);
      if (settled) call.recordSettlement();
      return settled;
    },

    // Purge.
    async purgeExpiredRequests(limit) {
      const now = ports.now();
      if (now - (lastPurgeAt.get(ports) ?? Number.NEGATIVE_INFINITY) < ports.settings.purgeIntervalMs) return 0;
      lastPurgeAt.set(ports, now);
      return ledger.purgeExpiredRequests(limit);
    },
  };
}
