import type { z } from 'zod';
import type { PersonalAuthority, PersonalScopeTx } from '../../modules/identity/public.js';
import { reservedTokensFor, type BudgetCap, type BudgetDimension, type ReportedUsage } from '../domain/budgets.js';
import {
  MAX_ANSWER_DEPTH,
  exceedsDepth,
  extractJsonObject,
  issueFor,
  issueForExtraction,
  validateOutput,
  validSafeCustomIssues,
  type OutputIssue,
  type SafeCustomIssues,
} from '../domain/output.js';
import { HARNESS_PROMPT_VERSION, buildPrompt } from '../domain/prompt.js';
import { makeExecuteAttempt, type AttemptResult, type Judgement } from './execute-attempt.js';
import {
  MAX_STORED_OUTPUT_BYTES,
  PersonalReasoningRefused,
  type PersonalRecordingPurpose,
  type HarnessPorts,
  type ExecutionPorts,
  type ModelPort,
  type ModelReply,
  type ReasoningEffort,
  type RunDescriptor,
} from './ports.js';

/** The most a role may ask a provider to produce in one answer. */
export const MAX_ROLE_OUTPUT_TOKENS = 16_384;
/** Context bounds (before the request-size check). */
export const MAX_CONTEXT_ITEMS = 64;
export const MAX_CONTEXT_ITEM_CHARS = 32_768;
export const MAX_INSTRUCTION_CHARS = 32_768;

/**
 * A role, owned by its module (blueprint §15 "Shared engine, module-owned roles"): instructions,
 * output schema and limits. The module also owns the context builder, the semantic validator and
 * the applier; the harness only executes.
 */
export interface ReasoningRole<T> {
  /** `<module>.<role>`, e.g. `planning.planner`. */
  readonly id: string;
  /** The role's own version (instructions + schema); recorded on every run and attempt. */
  readonly version: string;
  readonly instructions: string;
  /**
   * The contract of an answer: structure plus any semantic checks the owning module expresses as
   * refinements. Schema acceptance is not a quality judgement.
   */
  readonly outputSchema: z.ZodType<T>;
  /**
   * Optional static code → hint catalogue for custom issues with `params.safeCode`. Owned by
   * role code, never context/provider/user data. At most 128 codes (lowercase, digits, `_`, 64
   * chars), each hint 1–256 characters without Unicode Cc/Cf controls. Only enumerable string
   * data properties are accepted; hidden, accessor and symbol entries refuse admission.
   * Unknown codes/messages stay suppressed.
   * Changes to this feedback contract require a role version change.
   */
  readonly safeCustomIssues?: SafeCustomIssues;
  /** Output ceiling per attempt (reasoning + answer), 1 … `MAX_ROLE_OUTPUT_TOKENS`. */
  readonly maxOutputTokens: number;
  /** How hard a model that thinks should think; omitted leaves the provider's default. */
  readonly effort?: ReasoningEffort;
  /**
   * The one repair also carries the refused answer, as delimited data to revise. Only nonpersonal
   * production keeps refused answers, so a personal role never receives it.
   */
  readonly repairWithPreviousAnswer?: boolean;
  /**
   * Facts the role can derive from the refused answer that a fixed finding cannot carry (for the
   * Scroll writer, which source words it copied). Called only when the repair carries the previous
   * answer, with that answer's text; pure, deterministic and bounded by the harness. The harness
   * escapes the result and sends it as delimited data (`<repair-notes>`) in the user message, never
   * in the system text, so it may hold third-party text such as public research. Return
   * `undefined` for no notes; a throw is treated as no notes.
   */
  readonly repairNotes?: (previousAnswer: string) => string | undefined;
  /** Fewer context items than this is refused before anything is reserved (default 0). */
  readonly minContextItems?: number;
  /** The role's daily budget; defaults to the configured per-role cap. */
  readonly budget?: BudgetCap;
}

/** The business run the module is trying to complete (blueprint §15 "Three execution records"). */
export interface ReasoningRun<A = PersonalAuthority> {
  /** Stable across queue deliveries of the same work (a UUID). */
  readonly id: string;
  /** Whose personal scope the run is for; rechecked under the lock at admission and dispatch. */
  readonly authority: A;
  readonly ownerModule: string;
  readonly purpose: string;
  /** The owning module's policy version for this decision. */
  readonly policyVersion: string;
}

/** One prepared context item. `text` is data, never instructions; only `ref` is recorded on the run. */
export interface ContextItem {
  readonly ref: string;
  readonly kind: string;
  readonly text: string;
}

/**
 * The bounded context a module froze for this run (D-021, blueprint §26 minimisation). It is a
 * reference to the module's frozen bundle plus at most `MAX_CONTEXT_ITEMS` prepared items of at
 * most `MAX_CONTEXT_ITEM_CHARS` characters: topic/unit references and authorised excerpts. It is
 * never a raw observation stream, another person's private data or a secret, and the harness has
 * no other way to receive context. Only `bundleRef` and the item `ref`s are recorded on the run;
 * item text exists only in the protected request bytes (erased with the universe, expiring).
 */
export interface ReasoningContext {
  /** The module's reference to its frozen bundle (with the revisions it used). */
  readonly bundleRef: string;
  readonly items: readonly ContextItem[];
}

export interface ProposeLimits {
  /** Whether one repair attempt may follow an invalid answer (default `true`). */
  readonly allowRepair?: boolean;
}

export interface ProposeInput<T, A = PersonalAuthority> {
  readonly run: ReasoningRun<A>;
  readonly role: ReasoningRole<T>;
  readonly context: ReasoningContext;
  readonly limits?: ProposeLimits;
}

/** Why the harness refused to run (or to hand back) an attempt. */
export type ProposeRefusal =
  | 'provider_unavailable'
  | 'role_invalid'
  | 'run_invalid'
  | 'context_invalid'
  | 'context_insufficient'
  | 'request_too_large'
  | 'scope_refused'
  | 'run_mismatch'
  | 'run_closed'
  | 'request_mismatch'
  | 'dispatch_lost'
  | 'attempts_exhausted'
  | 'failure_brake'
  | 'output_ineligible'
  | 'attempt_written_off';

/**
 * The typed outcome of `propose` (blueprint §23 pattern 3). Only `proposed` carries output, and
 * the module must still validate it semantically and recheck authority under the lock in the
 * transaction that applies it.
 */
export type ProposeOutcome<T> =
  | {
      readonly kind: 'proposed';
      readonly output: T;
      readonly attemptId: string;
      readonly usage: ReportedUsage;
      /** The answer came from the one repair attempt. */
      readonly repaired: boolean;
      /** A late conclusive answer after the attempt had been marked `unknown`. */
      readonly reconciled: boolean;
    }
  | { readonly kind: 'invalid_output'; readonly attemptId: string; readonly reason: string }
  /** May have reached the provider; reconciled or written off by an operator, never resent. */
  | { readonly kind: 'unknown'; readonly attemptId: string }
  /** The provider conclusively refused or failed (e.g. `HTTP_429`, `HTTP_500`). */
  | { readonly kind: 'failed'; readonly attemptId: string; readonly code: string }
  | { readonly kind: 'refused'; readonly reason: ProposeRefusal; readonly attemptId?: string }
  | { readonly kind: 'budget_exhausted'; readonly dimension: BudgetDimension; readonly limit: 'requests' | 'tokens' }
  | { readonly kind: 'quota_unavailable'; readonly attemptId: string };

/** The harness used by module-owned roles. */
export interface ReasoningHarness<A = PersonalAuthority, S = PersonalScopeTx> {
  /**
   * Runs one role proposal for one business run: at most one primary attempt and, after a
   * conclusively invalid answer, at most one repair attempt. No tool loop.
   *
   * Inputs: run (ID, authority, owner module, purpose, policy version), role (instructions,
   * schema, limits), the module's frozen context and limits; an abort signal (worker shutdown).
   * Output: a `ProposeOutcome`. Authority: admission and dispatch run under `withPersonalScope`
   * (rechecked after the lock wait); a usable answer is returned only while the authority still
   * holds (lock-free check), and the module rechecks under the lock when applying it.
   * Side effects: run, attempts, protected request bytes, usage receipts, diagnostics; at most one
   * provider invocation per attempt; nothing in the module's own tables.
   * Failure/retry: safe to call again for the same run on every queue delivery. A redelivery
   * answers from the ledger (a kept answer is returned again without a second paid call), never
   * resends a dispatched attempt, and refuses a different request for the same run step.
   * Exceptions are infrastructure failures (database unavailable, lock busy): retry the job.
   * A run that was closed (`closeRun`) answers `run_closed` to every later call, including a
   * redelivery whose answer is still kept in the ledger: the module's applier closes the run in
   * the transaction that applies the result, so a handler seeing `run_closed` knows the work is
   * done. A run admitted at one privacy epoch answers `run_mismatch` to a call under another.
   * A conclusive provider failure (`failed`) charges nothing unless usage was reported, ends the
   * attempt, and does not retry: starting a new run is the caller's decision.
   * Invariants: no transaction spans the network; unknown outcomes are never resent or repaired;
   * a repair is a new admitted attempt with its own reservation and causation, only after the
   * first attempt is conclusively complete; provider-returned values are redacted before they are
   * stored or returned.
   */
  propose<T>(input: ProposeInput<T, A>, signal: AbortSignal): Promise<ProposeOutcome<T>>;
  /**
   * Closes an admitted run: the module's applier calls it in the same transaction that applies or
   * rejects a `proposed` result.
   *
   * Inputs: the open personal scope of the run's universe (the capability proves the lock is held
   * and the authority was rechecked) and `{ runId, state: 'completed' | 'failed' | 'cancelled' }`.
   * Output: `closed`, or `not_open` when the run was already closed or does not exist in this
   * universe. Personal compatibility additionally takes its first own-account gate and requires actual
   * initial1/on plus an unproved legacy run; recording-aware roles use the separate sole-entry apply facade.
   * Production scope authorization remains its owning composition's responsibility.
   * Side effects: one update of the run row (state, `closed_at`, fence + 1) inside the caller's
   * transaction, so a rollback leaves the run open. Failure/retry: idempotent (a second call
   * answers `not_open`); database errors propagate and roll the caller's transaction back.
   * Invariants: a closed run starts no new attempt and returns no kept answer (`propose` answers
   * `run_closed`). The fence only increases and is recorded for audit; the applier's idempotency
   * token is this call's own answer (`closed` once, `not_open` after).
   */
  closeRun(
    scope: S,
    run: { readonly runId: string; readonly state: 'completed' | 'failed' | 'cancelled' },
  ): Promise<'closed' | 'not_open'>;
}

const roleIdPattern = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
const versionPattern = /^[A-Za-z0-9._-]{1,32}$/;
const codePattern = /^[a-z][a-z0-9_-]{0,63}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const refPattern = /^[A-Za-z0-9_.:@/-]{1,128}$/;

function roleProblem<T>(role: ReasoningRole<T>): boolean {
  return (
    !roleIdPattern.test(role.id) ||
    !versionPattern.test(role.version) ||
    role.instructions.trim() === '' ||
    role.instructions.length > MAX_INSTRUCTION_CHARS ||
    !Number.isInteger(role.maxOutputTokens) ||
    role.maxOutputTokens < 1 ||
    role.maxOutputTokens > MAX_ROLE_OUTPUT_TOKENS ||
    (role.minContextItems !== undefined && (!Number.isInteger(role.minContextItems) || role.minContextItems < 0)) ||
    (role.safeCustomIssues !== undefined && !validSafeCustomIssues(role.safeCustomIssues))
  );
}

/** The most characters of a role's repair notes the harness sends. */
const MAX_REPAIR_NOTES_CHARS = 2_000;

/** The role's notes about a refused answer, bounded; none when the role has none or fails to produce them. */
function repairNotesOf<T>(role: ReasoningRole<T>, previousAnswer: string): string | undefined {
  if (role.repairNotes === undefined) return undefined;
  try {
    const notes = role.repairNotes(previousAnswer);
    return typeof notes === 'string' && notes.trim() !== '' ? notes.slice(0, MAX_REPAIR_NOTES_CHARS) : undefined;
  } catch {
    return undefined;
  }
}

function runProblem<A>(run: ReasoningRun<A>): boolean {
  return (
    !uuidPattern.test(run.id) ||
    !codePattern.test(run.ownerModule) ||
    !codePattern.test(run.purpose) ||
    !versionPattern.test(run.policyVersion)
  );
}

function contextProblem(context: ReasoningContext): boolean {
  return (
    !refPattern.test(context.bundleRef) ||
    context.items.length > MAX_CONTEXT_ITEMS ||
    context.items.some(
      (item) =>
        !refPattern.test(item.ref) ||
        !/^[a-z][a-z0-9_]{0,31}$/.test(item.kind) ||
        item.text.length > MAX_CONTEXT_ITEM_CHARS,
    )
  );
}

const utf8 = new TextEncoder();

/**
 * Creates the reasoning harness (blueprint §15). Every port is injected: the provider transport
 * (already wrapped by the transaction guard), the attempt ledger, authority checks, hashing,
 * redaction, IDs, clock, diagnostics and settings.
 */
export function makeReasoningHarness(ports: HarnessPorts): ReasoningHarness {
  return makeBoundPersonalHarness(ports);
}

const personalPurgeTimes = new WeakMap<HarnessPorts, number>();
/** Personal-only per-call wrappers. Production continues using the unchanged engine directly. */
export function makeBoundPersonalHarness(ports: HarnessPorts, purpose?: PersonalRecordingPurpose): ReasoningHarness {
  if (
    !ports.personalAccess ||
    typeof ports.personalAccess.enter !== 'function' ||
    typeof ports.personalAccess.check !== 'function' ||
    typeof ports.personalAccess.checkAttempt !== 'function' ||
    typeof ports.personalAccess.readProtected !== 'function'
  )
    throw new Error('PERSONAL_REASONING_ACCESS_REQUIRED');
  return {
    async propose(input, signal) {
      const descriptor: RunDescriptor = {
        id: input.run.id,
        ownerModule: input.run.ownerModule,
        purpose: input.run.purpose,
        roleId: input.role.id,
        roleVersion: input.role.version,
        policyVersion: input.run.policyVersion,
        provider: ports.model?.provider ?? '',
        model: ports.model?.model ?? '',
        contextBundleRef: input.context.bundleRef,
        contextRefs: input.context.items.map((item) => item.ref),
        ...(purpose
          ? {
              recording: {
                accountId: purpose.accountId,
                generation: purpose.recordingGeneration,
                contextSha256: purpose.contextSha256,
                modelContextSha256: purpose.modelContextSha256,
              },
            }
          : {}),
      };
      let settled = false;
      let planned: { readonly step: 'primary' | 'repair'; readonly requestHash: string } | undefined;
      const access = ports.personalAccess;
      let accountingRevoked = false;
      async function enter<T>(authority: PersonalAuthority, work: (scope: PersonalScopeTx) => Promise<T>) {
        accountingRevoked = false;
        const result = await access.enter(authority, descriptor, purpose, work);
        accountingRevoked = result.kind === 'refused' && result.refusal.accountingRevoked === true;
        return result;
      }
      const check = (scope: PersonalScopeTx) => access.check(scope, descriptor, purpose);
      const checkAttempt = async (scope: PersonalScopeTx, step: string) => {
        if (!planned || step !== planned.step) throw new PersonalReasoningRefused('request_mismatch');
        await access.checkAttempt(scope, descriptor, planned.step, planned.requestHash);
      };
      const ledger = ports.ledger;
      const wrapped: HarnessPorts['ledger'] = {
        ...ledger,
        async purgeExpiredRequests(limit) {
          const now = ports.now();
          if (now - (personalPurgeTimes.get(ports) ?? Number.NEGATIVE_INFINITY) < ports.settings.purgeIntervalMs)
            return 0;
          personalPurgeTimes.set(ports, now);
          return ledger.purgeExpiredRequests(limit);
        },
        async find(scopeId, runId, step) {
          if (scopeId !== input.run.authority.universeId || runId !== input.run.id)
            throw new PersonalReasoningRefused('run_mismatch');
          const read = await enter(input.run.authority, async (scope) => {
            await checkAttempt(scope, step);
            return ledger.findLocked(scope, runId, step);
          });
          if (read.kind !== 'entered')
            throw new PersonalReasoningRefused(
              ['run_mismatch', 'run_closed', 'output_ineligible', 'request_mismatch'].includes(read.refusal.kind)
                ? (read.refusal.kind as 'run_mismatch' | 'run_closed' | 'output_ineligible' | 'request_mismatch')
                : 'scope_refused',
              read.refusal.accountingRevoked === true,
            );
          return read.value;
        },
        async findLocked(scope, runId, step) {
          await check(scope);
          if (runId !== descriptor.id) throw new PersonalReasoningRefused('run_mismatch');
          await checkAttempt(scope, step);
          return ledger.findLocked(scope, runId, step);
        },
        async admitRun(scope, run) {
          await check(scope);
          return ledger.admitRun(scope, {
            ...run,
            ...(descriptor.recording ? { recording: descriptor.recording } : {}),
          });
        },
        async budgetUsage(scope, roleId) {
          await check(scope);
          return ledger.budgetUsage(scope, roleId);
        },
        async canStartRun(scope, roleId) {
          await check(scope);
          return ledger.canStartRun(scope, roleId);
        },
        async reserve(scope, reservation) {
          await check(scope);
          return ledger.reserve(scope, reservation);
        },
        async commitDispatch(scope, attemptId, dispatch) {
          await check(scope);
          return ledger.commitDispatch(scope, attemptId, dispatch);
        },
        async readProtectedRequest(attempt) {
          const expected = planned;
          if (!expected) throw new PersonalReasoningRefused('request_mismatch');
          const read = await enter(input.run.authority, async (scope) => {
            await checkAttempt(scope, expected.step);
            return access.readProtected(scope, descriptor, attempt, expected.step, expected.requestHash);
          });
          if (read.kind !== 'entered')
            throw new PersonalReasoningRefused(
              ['run_mismatch', 'run_closed', 'output_ineligible', 'request_mismatch'].includes(read.refusal.kind)
                ? (read.refusal.kind as 'run_mismatch' | 'run_closed' | 'output_ineligible' | 'request_mismatch')
                : 'scope_refused',
              read.refusal.accountingRevoked === true,
            );
          return read.value;
        },
        async settle(...args) {
          const [attempt, from, to, details] = args;
          if (from === 'reserved' && to === 'not_sent' && details?.outcomeCode === 'AUTHORITY_REFUSED') {
            // Applies to the existing admission/dispatch-refusal branches too. Stale owner/
            // claim/header denial cannot cancel a newer eligible claim's shared reservation.
            if (
              !accountingRevoked ||
              !planned ||
              (planned.step !== 'primary' && planned.step !== 'repair') ||
              attempt.scopeId !== input.run.authority.universeId
            )
              return false;
            return (
              (await ledger.releaseUndispatchedPersonal?.({
                scopeId: attempt.scopeId,
                privacyEpoch: input.run.authority.privacyEpoch,
                run: descriptor,
                step: planned.step,
                requestHash: planned.requestHash,
                attemptId: attempt.attemptId,
              })) === 'released'
            );
          }
          const result = await ledger.settle(...args);
          // Accounting ALWAYS runs, including after revocation. Only the later private read refuses.
          if (result) settled = true;
          return result;
        },
      };
      const engine = makeScopedReasoningHarness<PersonalAuthority, PersonalScopeTx>({
        ...ports,
        ledger: wrapped,
        beforeAttempt: (step, requestHash) => {
          planned = { step, requestHash };
        },
        withScope: enter,
        authorityHolds: async (authority) => {
          if (!(await ports.authorityHolds(authority))) return false;
          try {
            return (await enter(authority, () => Promise.resolve(true))).kind === 'entered';
          } catch (error) {
            if (error instanceof PersonalReasoningRefused) return false;
            throw error;
          }
        },
        scopeId: (authority) => authority.universeId,
        generation: (authority) => authority.privacyEpoch,
      });
      try {
        return await engine.propose(input, signal);
      } catch (error) {
        if (!(error instanceof PersonalReasoningRefused)) throw error;
        if (
          !settled &&
          error.reason === 'scope_refused' &&
          error.accountingRevoked &&
          planned &&
          (planned.step === 'primary' || planned.step === 'repair')
        ) {
          // A revoked private read cannot reveal the row, but exact undispatched accounting may
          // still release its proven held receipt. Missing/unproved capability leaves it held.
          await ledger.releaseUndispatchedPersonal?.({
            scopeId: input.run.authority.universeId,
            privacyEpoch: input.run.authority.privacyEpoch,
            run: descriptor,
            step: planned.step,
            requestHash: planned.requestHash,
          });
        }
        return { kind: 'refused', reason: settled ? 'output_ineligible' : error.reason };
      }
    },
    closeRun: (scope, run) => ports.personalAccess.closeLegacy(scope, run),
  };
}

/** The same proposal and attempt engine, selected only by the two concrete composition adapters. */
export function makeScopedReasoningHarness<A, S>(ports: ExecutionPorts<A, S>): ReasoningHarness<A, S> {
  const executeAttempt = makeExecuteAttempt(ports);
  let lastPurgeAt = Number.NEGATIVE_INFINITY;

  /** Expired protected requests are purged opportunistically, at most once per interval per process. */
  async function maybePurge(): Promise<void> {
    const now = ports.now();
    if (now - lastPurgeAt < ports.settings.purgeIntervalMs) return;
    lastPurgeAt = now;
    try {
      const purged = await ports.ledger.purgeExpiredRequests(500);
      if (purged > 0) ports.logEvent('reasoning.requests_purged', { count: purged });
    } catch (error) {
      ports.logEvent('reasoning.purge_failed', { error });
    }
  }

  function judgeWith<T>(schema: z.ZodType<T>, safeCustomIssues?: SafeCustomIssues) {
    /** `reason` is an `InvalidOutputReason` or the adapter's unreadable-reply code. */
    const invalid = (reason: string, issues: readonly OutputIssue[]): Judgement => ({
      valid: false,
      reason,
      issues,
    });
    return (reply: ModelReply): Judgement => {
      if (reply.answer.kind === 'unreadable') return invalid(reply.answer.code, [issueFor('REPLY_UNREADABLE')]);
      // A cut-off answer is refused even when what arrived happens to parse.
      if (reply.answer.stop === 'max_tokens') return invalid('OUTPUT_TRUNCATED', [issueFor('OUTPUT_TRUNCATED')]);
      const extracted = extractJsonObject(reply.answer.text);
      if (!extracted.ok) return invalid(extracted.reason, [issueForExtraction(extracted.reason, reply.answer.text)]);
      // Deep nesting is refused before anything is redacted, validated or stored.
      if (exceedsDepth(extracted.value, MAX_ANSWER_DEPTH))
        return invalid('OUTPUT_TOO_DEEP', [issueFor('OUTPUT_TOO_DEEP')]);
      const redacted = ports.redactRecorded(extracted.value);
      const verdict = validateOutput(schema, redacted, safeCustomIssues);
      if (!verdict.valid) return invalid(verdict.reason, verdict.issues);
      const stored = { v: 1 as const, text: JSON.stringify(redacted) };
      if (utf8.encode(JSON.stringify(stored)).length > MAX_STORED_OUTPUT_BYTES)
        return invalid('OUTPUT_TOO_LARGE', [issueFor('OUTPUT_TOO_LARGE')]);
      return { valid: true, stored };
    };
  }

  function outcomeOf<T>(
    schema: z.ZodType<T>,
    result: AttemptResult,
    repaired: boolean,
  ):
    | ProposeOutcome<T>
    | {
        readonly kind: 'repairable';
        readonly attemptId: string;
        readonly reason: string;
        readonly issues: readonly OutputIssue[];
      } {
    switch (result.kind) {
      case 'answered': {
        let value: unknown;
        try {
          value = JSON.parse(result.stored.text);
        } catch {
          return { kind: 'invalid_output', attemptId: result.attemptId, reason: 'OUTPUT_NOT_ONE_JSON_OBJECT' };
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value))
          return { kind: 'invalid_output', attemptId: result.attemptId, reason: 'OUTPUT_NOT_ONE_JSON_OBJECT' };
        const verdict = validateOutput(schema, value as Record<string, unknown>);
        if (!verdict.valid) return { kind: 'invalid_output', attemptId: result.attemptId, reason: verdict.reason };
        return {
          kind: 'proposed',
          output: verdict.output,
          attemptId: result.attemptId,
          usage: result.usage,
          repaired,
          reconciled: result.reconciled,
        };
      }
      case 'answered_invalid':
        return { kind: 'repairable', attemptId: result.attemptId, reason: result.reason, issues: result.issues };
      case 'failed':
        return { kind: 'failed', attemptId: result.attemptId, code: result.code };
      case 'unknown':
        return { kind: 'unknown', attemptId: result.attemptId };
      case 'quota_unavailable':
        return { kind: 'quota_unavailable', attemptId: result.attemptId };
      case 'budget_exhausted':
        return { kind: 'budget_exhausted', dimension: result.dimension, limit: result.limit };
      case 'ineligible':
        return { kind: 'refused', reason: 'output_ineligible', attemptId: result.attemptId };
      case 'written_off':
        return { kind: 'refused', reason: 'attempt_written_off', attemptId: result.attemptId };
      case 'refused':
        return { kind: 'refused', reason: result.reason };
    }
  }

  return {
    async propose<T>(input: ProposeInput<T, A>, signal: AbortSignal): Promise<ProposeOutcome<T>> {
      const { run, role, context } = input;
      const refuse = (reason: ProposeRefusal): ProposeOutcome<T> => {
        ports.logEvent('reasoning.admission_refused', {
          ...(uuidPattern.test(run.id) ? { runId: run.id } : {}),
          reasonCode: reason,
        });
        return { kind: 'refused', reason };
      };
      const model: ModelPort | undefined = ports.model;
      if (model === undefined) return refuse('provider_unavailable');
      if (roleProblem(role)) return refuse('role_invalid');
      if (runProblem(run)) return refuse('run_invalid');
      if (contextProblem(context)) return refuse('context_invalid');
      if (context.items.length < (role.minContextItems ?? 0)) return refuse('context_insufficient');
      await maybePurge();
      const descriptor: RunDescriptor = {
        id: run.id,
        ownerModule: run.ownerModule,
        purpose: run.purpose,
        roleId: role.id,
        roleVersion: role.version,
        policyVersion: run.policyVersion,
        provider: model.provider,
        model: model.model,
        contextBundleRef: context.bundleRef,
        contextRefs: context.items.map((item) => item.ref),
      };
      const caps = {
        global: ports.settings.caps.global,
        scope: ports.settings.caps.scope,
        role: role.budget ?? ports.settings.caps.roleDefault,
      };
      const encode = (feedback?: readonly OutputIssue[], previousAnswer?: string, repairNotes?: string) => {
        const text = buildPrompt({
          roleId: role.id,
          roleVersion: role.version,
          instructions: role.instructions,
          bundleRef: context.bundleRef,
          items: context.items,
          ...(feedback === undefined ? {} : { feedback }),
          ...(previousAnswer === undefined ? {} : { previousAnswer }),
          ...(repairNotes === undefined ? {} : { repairNotes }),
        });
        const body = model.encode({
          system: text.system,
          user: text.user,
          maxOutputTokens: role.maxOutputTokens,
          ...(role.effort === undefined ? {} : { effort: role.effort }),
        });
        return body.length > ports.settings.maxRequestBytes ? undefined : body;
      };
      const plan = (body: Uint8Array, step: 'primary' | 'repair', causationAttemptId?: string) => {
        const requestHash = ports.hashBytes(body);
        ports.beforeAttempt?.(step, requestHash);
        return {
          authority: run.authority,
          run: descriptor,
          step,
          roleId: role.id,
          roleVersion: role.version,
          promptVersion: HARNESS_PROMPT_VERSION,
          body,
          requestHash,
          maxOutputTokens: role.maxOutputTokens,
          reservedTokens: reservedTokensFor(body.length, role.maxOutputTokens),
          caps,
          ...(causationAttemptId === undefined ? {} : { causationAttemptId }),
        };
      };
      const judge = judgeWith(role.outputSchema, role.safeCustomIssues);

      const primaryBody = encode();
      if (primaryBody === undefined) return refuse('request_too_large');
      const primary = outcomeOf(
        role.outputSchema,
        await executeAttempt(model, plan(primaryBody, 'primary'), judge, signal),
        false,
      );
      if (primary.kind !== 'repairable') return primary;
      const invalid: ProposeOutcome<T> = {
        kind: 'invalid_output',
        attemptId: primary.attemptId,
        reason: primary.reason,
      };
      if (input.limits?.allowRepair === false) return invalid;

      // At most one repair: a new attempt, caused by the conclusively complete primary, sending
      // the validator's findings and, only for a production role that opts in, the model's own
      // refused answer as delimited data (a raw provider reply is never returned by the ledger).
      const previousAnswer =
        role.repairWithPreviousAnswer === true
          ? await ports.ledger.readRejectedAnswerText?.({
              scopeId: ports.scopeId(run.authority),
              attemptId: primary.attemptId,
            })
          : undefined;
      const notes = previousAnswer === undefined ? undefined : repairNotesOf(role, previousAnswer);
      // The richest request that fits: answer and notes, then the answer alone, then the findings alone.
      const repairBody =
        encode(primary.issues, previousAnswer, notes) ??
        encode(primary.issues, previousAnswer) ??
        encode(primary.issues);
      if (repairBody === undefined) return invalid;
      const repair = outcomeOf(
        role.outputSchema,
        await executeAttempt(model, plan(repairBody, 'repair', primary.attemptId), judge, signal),
        true,
      );
      return repair.kind === 'repairable'
        ? { kind: 'invalid_output', attemptId: repair.attemptId, reason: repair.reason }
        : repair;
    },

    closeRun(scope, run) {
      return ports.ledger.closeRun(scope, { runId: run.runId, state: run.state });
    },
  };
}
