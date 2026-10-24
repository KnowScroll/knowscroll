import type { z } from 'zod';
import type { PersonalAuthority, PersonalScopeTx } from '../../modules/identity/public.js';
import {
  reservedTokensFor,
  type BudgetCap,
  type BudgetCaps,
  type BudgetDimension,
  type ReportedUsage,
} from '../domain/budgets.js';
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
import { makeExecuteAttempt, type AttemptPlan, type AttemptResult, type Judgement } from './execute-attempt.js';
import { PersonalCall, guardPersonalLedger, requirePersonalAccess } from './personal-guard.js';
import {
  MAX_STORED_OUTPUT_BYTES,
  PersonalReasoningRefused,
  type PersonalRecordingPurpose,
  type HarnessPorts,
  type ExecutionPorts,
  type ModelPort,
  type ModelReply,
  type ReasoningEffort,
  type RecordingRunProof,
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
   * provider invocation per attempt; nothing in the module's own tables. Before the first attempt
   * it may also purge expired protected request bytes of any run, at most once per
   * `purgeIntervalMs` (per process for personal runs): a purge failure is logged, never changes
   * the outcome and waits for the next interval or the scheduled purge job.
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
 * The identity of a run as the ledger compares it: the same run ID with any other role, policy,
 * model, bundle or owner is a mismatch. `model` is absent only when no provider is configured, which
 * refuses the proposal before the descriptor is used.
 */
function describeRun<T, A>(
  input: ProposeInput<T, A>,
  model: Pick<ModelPort, 'provider' | 'model'> | undefined,
  recording?: RecordingRunProof,
): RunDescriptor {
  return {
    id: input.run.id,
    ownerModule: input.run.ownerModule,
    purpose: input.run.purpose,
    roleId: input.role.id,
    roleVersion: input.role.version,
    policyVersion: input.run.policyVersion,
    provider: model?.provider ?? '',
    model: model?.model ?? '',
    contextBundleRef: input.context.bundleRef,
    contextRefs: input.context.items.map((item) => item.ref),
    ...(recording === undefined ? {} : { recording }),
  };
}

const recordingProofOf = (purpose: PersonalRecordingPurpose): RecordingRunProof => ({
  accountId: purpose.accountId,
  generation: purpose.recordingGeneration,
  contextSha256: purpose.contextSha256,
  modelContextSha256: purpose.modelContextSha256,
});

/**
 * Creates the reasoning harness (blueprint §15) for personal runs. Every port is injected: the
 * provider transport (already wrapped by the transaction guard), the attempt ledger, authority
 * checks, hashing, redaction, IDs, clock, diagnostics and settings.
 */
export function makeReasoningHarness(ports: HarnessPorts): ReasoningHarness {
  return makeBoundPersonalHarness(ports);
}

/**
 * The harness for personal runs: the shared engine with every ledger access and scope entry bound to
 * the owner's authority (`personal-guard.ts`). `purpose`, present for the recording-aware Planner and
 * Cartographer roles, adds the run's recording proof to its admission and its checks.
 *
 * Failure: refuses at construction (`PERSONAL_REASONING_ACCESS_REQUIRED`) when `ports` carries no
 * personal access adapter, so no private read can run unguarded. Per call, an authority refusal is
 * answered as a `refused` outcome, never thrown. Any other error is an infrastructure failure and
 * propagates for the job to retry.
 *
 * Each call builds its own engine and per-call state; only the purge throttle is shared (per `ports`).
 */
export function makeBoundPersonalHarness(ports: HarnessPorts, purpose?: PersonalRecordingPurpose): ReasoningHarness {
  requirePersonalAccess(ports);
  return {
    propose: (input, signal) => proposePersonal(ports, purpose, input, signal),
    closeRun: (scope, run) => ports.personalAccess.closeLegacy(scope, run),
  };
}

async function proposePersonal<T>(
  ports: HarnessPorts,
  purpose: PersonalRecordingPurpose | undefined,
  input: ProposeInput<T, PersonalAuthority>,
  signal: AbortSignal,
): Promise<ProposeOutcome<T>> {
  const descriptor = describeRun(input, ports.model, purpose === undefined ? undefined : recordingProofOf(purpose));
  const call = new PersonalCall(ports, purpose, input.run.authority, descriptor);
  const engine = makeScopedReasoningHarness<PersonalAuthority, PersonalScopeTx>({
    ...ports,
    ledger: guardPersonalLedger(call, ports),
    beforeAttempt: (step, requestHash) => call.plan(step, requestHash),
    withScope: (authority, work) => call.enter(authority, work),
    authorityHolds: (authority) => call.authorityHolds(authority),
    scopeId: (authority) => authority.universeId,
    generation: (authority) => authority.privacyEpoch,
  });
  try {
    return await engine.propose(input, signal);
  } catch (error) {
    if (!(error instanceof PersonalReasoningRefused)) throw error;
    return { kind: 'refused', reason: await call.refusalReason(error) };
  }
}

/** Admission's answer: the proposal may run with this provider, or it is refused with a reason. */
type ProposalAdmission =
  | { readonly kind: 'refused'; readonly reason: ProposeRefusal }
  | { readonly kind: 'admitted'; readonly model: ModelPort };

/**
 * Admission: whether a proposal may run at all, decided from its own inputs before anything is
 * recorded or reserved. The first failing check names the reason. Pure.
 */
function admitProposal<T, A>(model: ModelPort | undefined, input: ProposeInput<T, A>): ProposalAdmission {
  const { role, run, context } = input;
  const refusal = (reason: ProposeRefusal): ProposalAdmission => ({ kind: 'refused', reason });
  if (model === undefined) return refusal('provider_unavailable');
  if (roleProblem(role)) return refusal('role_invalid');
  if (runProblem(run)) return refusal('run_invalid');
  if (contextProblem(context)) return refusal('context_invalid');
  if (context.items.length < (role.minContextItems ?? 0)) return refusal('context_insufficient');
  return { kind: 'admitted', model };
}

/** Answers `refused` and records the reason code (the run ID only when it is well formed). */
function refuse<T>(logEvent: HarnessPorts['logEvent'], runId: string, reason: ProposeRefusal): ProposeOutcome<T> {
  logEvent('reasoning.admission_refused', { ...(uuidPattern.test(runId) ? { runId } : {}), reasonCode: reason });
  return { kind: 'refused', reason };
}

/** Rows deleted per opportunistic purge. */
const PURGE_BATCH = 500;

/**
 * Creates the opportunistic purge a proposal runs before its first attempt.
 *
 * Purpose: expired protected request bytes are deleted even when the scheduled purge job
 * (`reasoning.purge-expired-requests`, every 15 minutes) is late. Inputs: none per call; the
 * throttle is `settings.purgeIntervalMs`, kept per engine. Outputs: none.
 *
 * Authority: none. Like the scheduled job it is ledger-owned bookkeeping: in its own short
 * transaction it deletes up to `PURGE_BATCH` expired request bodies of any run in the database
 * (not only this proposal's), never those of a dispatched attempt, and first settles expired
 * reserved attempts `not_sent`. Side effects: those deletions, and `reasoning.requests_purged`
 * with the count.
 *
 * Failure/retry: an error is logged as `reasoning.purge_failed` and swallowed, so a purge never
 * fails a proposal. The interval is spent either way: the next opportunistic try is one interval
 * later, and the scheduled job is the backstop. A personal harness builds an engine per call, so
 * its ledger guard keeps the throttle per ports object instead (`personal-guard.ts`).
 */
function makeOpportunisticPurge<A, S>(ports: ExecutionPorts<A, S>): () => Promise<void> {
  let lastPurgeAt = Number.NEGATIVE_INFINITY;
  return async () => {
    const now = ports.now();
    if (now - lastPurgeAt < ports.settings.purgeIntervalMs) return;
    lastPurgeAt = now;
    try {
      const purged = await ports.ledger.purgeExpiredRequests(PURGE_BATCH);
      if (purged > 0) ports.logEvent('reasoning.requests_purged', { count: purged });
    } catch (error) {
      ports.logEvent('reasoning.purge_failed', { error });
    }
  };
}

/** Judges a conclusive reply: the stored answer, or why it is not usable. Pure but for `redact`. */
function judgeWith<T>(
  redact: HarnessPorts['redactRecorded'],
  schema: z.ZodType<T>,
  safeCustomIssues?: SafeCustomIssues,
): (reply: ModelReply) => Judgement {
  /** `reason` is an `InvalidOutputReason` or the adapter's unreadable-reply code. */
  const invalid = (reason: string, issues: readonly OutputIssue[]): Judgement => ({
    valid: false,
    reason,
    issues,
  });
  return (reply) => {
    if (reply.answer.kind === 'unreadable') return invalid(reply.answer.code, [issueFor('REPLY_UNREADABLE')]);
    // A cut-off answer is refused even when what arrived happens to parse.
    if (reply.answer.stop === 'max_tokens') return invalid('OUTPUT_TRUNCATED', [issueFor('OUTPUT_TRUNCATED')]);
    const extracted = extractJsonObject(reply.answer.text);
    if (!extracted.ok) return invalid(extracted.reason, [issueForExtraction(extracted.reason, reply.answer.text)]);
    // Deep nesting is refused before anything is redacted, validated or stored.
    if (exceedsDepth(extracted.value, MAX_ANSWER_DEPTH))
      return invalid('OUTPUT_TOO_DEEP', [issueFor('OUTPUT_TOO_DEEP')]);
    const redacted = redact(extracted.value);
    const verdict = validateOutput(schema, redacted, safeCustomIssues);
    if (!verdict.valid) return invalid(verdict.reason, verdict.issues);
    const stored = { v: 1 as const, text: JSON.stringify(redacted) };
    if (utf8.encode(JSON.stringify(stored)).length > MAX_STORED_OUTPUT_BYTES)
      return invalid('OUTPUT_TOO_LARGE', [issueFor('OUTPUT_TOO_LARGE')]);
    return { valid: true, stored };
  };
}

/** An attempt whose answer the validator refused and a repair may still fix. */
interface Repairable {
  readonly kind: 'repairable';
  readonly attemptId: string;
  readonly reason: string;
  readonly issues: readonly OutputIssue[];
}

type AttemptOutcome<T> = ProposeOutcome<T> | Repairable;

/**
 * Settlement's answer for the caller: what one finished attempt means for the proposal. A usable
 * answer is validated again from its stored text, so a redelivery that reads it from the ledger gets
 * the same typed output.
 */
function outcomeOf<T>(schema: z.ZodType<T>, result: AttemptResult, repaired: boolean): AttemptOutcome<T> {
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

type ExecuteAttempt<A> = (
  model: ModelPort,
  plan: AttemptPlan<A>,
  judge: (reply: ModelReply) => Judgement,
  signal: AbortSignal,
) => Promise<AttemptResult>;

/** The ports and the one-attempt executor that every step of a proposal needs. */
interface Engine<A, S> {
  readonly ports: ExecutionPorts<A, S>;
  readonly executeAttempt: ExecuteAttempt<A>;
}

/** What the primary attempt and the repair share once a proposal is admitted. Built once, never changed. */
interface Proposal<T, A> {
  readonly input: ProposeInput<T, A>;
  readonly model: ModelPort;
  readonly descriptor: RunDescriptor;
  readonly caps: BudgetCaps;
  readonly judge: (reply: ModelReply) => Judgement;
}

function admittedProposal<T, A, S>(
  ports: ExecutionPorts<A, S>,
  input: ProposeInput<T, A>,
  model: ModelPort,
): Proposal<T, A> {
  const { role } = input;
  return {
    input,
    model,
    descriptor: describeRun(input, model),
    caps: {
      global: ports.settings.caps.global,
      scope: ports.settings.caps.scope,
      role: role.budget ?? ports.settings.caps.roleDefault,
    },
    judge: judgeWith(ports.redactRecorded, role.outputSchema, role.safeCustomIssues),
  };
}

/** What a repair request adds to the primary one: the validator's findings, and optionally the answer they refer to. */
interface RepairFeedback {
  readonly issues: readonly OutputIssue[];
  readonly previousAnswer?: string | undefined;
  readonly notes?: string | undefined;
}

/** The exact request bytes, or `undefined` when they would exceed the protected store's limit. */
function encodeRequest<T, A>(
  proposal: Proposal<T, A>,
  maxRequestBytes: number,
  feedback?: RepairFeedback,
): Uint8Array | undefined {
  const { role, context } = proposal.input;
  const text = buildPrompt({
    roleId: role.id,
    roleVersion: role.version,
    instructions: role.instructions,
    bundleRef: context.bundleRef,
    items: context.items,
    ...(feedback === undefined ? {} : { feedback: feedback.issues }),
    ...(feedback?.previousAnswer === undefined ? {} : { previousAnswer: feedback.previousAnswer }),
    ...(feedback?.notes === undefined ? {} : { repairNotes: feedback.notes }),
  });
  const body = proposal.model.encode({
    system: text.system,
    user: text.user,
    maxOutputTokens: role.maxOutputTokens,
    ...(role.effort === undefined ? {} : { effort: role.effort }),
  });
  return body.length > maxRequestBytes ? undefined : body;
}

/**
 * Dispatch plan of one attempt: the exact bytes and their hash, the reservation it makes and the
 * budgets it counts against. Tells the authority binding which attempt is next (`beforeAttempt`),
 * so private reads for it can be checked against exactly this request.
 */
function planAttempt<T, A, S>(
  ports: ExecutionPorts<A, S>,
  proposal: Proposal<T, A>,
  body: Uint8Array,
  step: 'primary' | 'repair',
  causationAttemptId?: string,
): AttemptPlan<A> {
  const { run, role } = proposal.input;
  const requestHash = ports.hashBytes(body);
  ports.beforeAttempt?.(step, requestHash);
  return {
    authority: run.authority,
    run: proposal.descriptor,
    step,
    roleId: role.id,
    roleVersion: role.version,
    promptVersion: HARNESS_PROMPT_VERSION,
    body,
    requestHash,
    maxOutputTokens: role.maxOutputTokens,
    reservedTokens: reservedTokensFor(body.length, role.maxOutputTokens),
    caps: proposal.caps,
    ...(causationAttemptId === undefined ? {} : { causationAttemptId }),
  };
}

/** Admission, dispatch and settlement of one attempt (`executeAttempt`), read back as an outcome. */
async function runAttempt<T, A, S>(
  engine: Engine<A, S>,
  proposal: Proposal<T, A>,
  plan: AttemptPlan<A>,
  signal: AbortSignal,
): Promise<AttemptOutcome<T>> {
  const result = await engine.executeAttempt(proposal.model, plan, proposal.judge, signal);
  return outcomeOf(proposal.input.role.outputSchema, result, plan.step === 'repair');
}

/** The primary attempt. A request too large for the protected store is refused before anything is reserved. */
async function runPrimary<T, A, S>(
  engine: Engine<A, S>,
  proposal: Proposal<T, A>,
  signal: AbortSignal,
): Promise<AttemptOutcome<T>> {
  const { ports } = engine;
  const body = encodeRequest(proposal, ports.settings.maxRequestBytes);
  if (body === undefined) return refuse(ports.logEvent, proposal.input.run.id, 'request_too_large');
  return runAttempt(engine, proposal, planAttempt(ports, proposal, body, 'primary'), signal);
}

const invalidOutputOf = <T>(attempt: Repairable): ProposeOutcome<T> => ({
  kind: 'invalid_output',
  attemptId: attempt.attemptId,
  reason: attempt.reason,
});

/**
 * The model's own refused answer, for a role that asks to revise it. Only nonpersonal production
 * keeps refused answers, so a personal role gets none.
 */
async function keptAnswerFor<T, A, S>(
  ports: ExecutionPorts<A, S>,
  proposal: Proposal<T, A>,
  refusedAttemptId: string,
): Promise<string | undefined> {
  const { run, role } = proposal.input;
  if (role.repairWithPreviousAnswer !== true) return undefined;
  return ports.ledger.readRejectedAnswerText?.({ scopeId: ports.scopeId(run.authority), attemptId: refusedAttemptId });
}

/** The richest repair request that fits: answer and notes, then the answer alone, then the findings alone. */
function repairRequest<T, A, S>(
  ports: ExecutionPorts<A, S>,
  proposal: Proposal<T, A>,
  issues: readonly OutputIssue[],
  previousAnswer: string | undefined,
): Uint8Array | undefined {
  const { maxRequestBytes } = ports.settings;
  const notes = previousAnswer === undefined ? undefined : repairNotesOf(proposal.input.role, previousAnswer);
  return (
    encodeRequest(proposal, maxRequestBytes, { issues, previousAnswer, notes }) ??
    encodeRequest(proposal, maxRequestBytes, { issues, previousAnswer }) ??
    encodeRequest(proposal, maxRequestBytes, { issues })
  );
}

/**
 * The one repair: a new attempt, caused by the conclusively complete primary, that sends the
 * validator's findings and, only for a production role that opts in, the model's own refused answer
 * as delimited data (a raw provider reply is never returned by the ledger). When no repair request
 * fits the protected store, the primary's refusal stands.
 */
async function runRepair<T, A, S>(
  engine: Engine<A, S>,
  proposal: Proposal<T, A>,
  refused: Repairable,
  signal: AbortSignal,
): Promise<ProposeOutcome<T>> {
  const { ports } = engine;
  const previousAnswer = await keptAnswerFor(ports, proposal, refused.attemptId);
  const body = repairRequest(ports, proposal, refused.issues, previousAnswer);
  if (body === undefined) return invalidOutputOf(refused);
  const repair = await runAttempt(
    engine,
    proposal,
    planAttempt(ports, proposal, body, 'repair', refused.attemptId),
    signal,
  );
  return repair.kind === 'repairable' ? invalidOutputOf(repair) : repair;
}

/**
 * The shared proposal and attempt engine, selected only by the two concrete composition adapters
 * (personal: `makeBoundPersonalHarness`; nonpersonal production). A proposal runs admission, an
 * opportunistic purge, the primary attempt and, after a conclusively invalid answer and unless the
 * caller forbids it, one repair. No tool loop; every step passes its values explicitly.
 */
export function makeScopedReasoningHarness<A, S>(ports: ExecutionPorts<A, S>): ReasoningHarness<A, S> {
  const engine: Engine<A, S> = { ports, executeAttempt: makeExecuteAttempt(ports) };
  const purgeIfDue = makeOpportunisticPurge(ports);

  return {
    async propose<T>(input: ProposeInput<T, A>, signal: AbortSignal): Promise<ProposeOutcome<T>> {
      const admission = admitProposal(ports.model, input);
      if (admission.kind === 'refused') return refuse(ports.logEvent, input.run.id, admission.reason);
      await purgeIfDue();
      const proposal = admittedProposal(ports, input, admission.model);
      const primary = await runPrimary(engine, proposal, signal);
      if (primary.kind !== 'repairable') return primary;
      if (input.limits?.allowRepair === false) return invalidOutputOf(primary);
      return runRepair(engine, proposal, primary, signal);
    },

    closeRun(scope, run) {
      return ports.ledger.closeRun(scope, { runId: run.runId, state: run.state });
    },
  };
}
