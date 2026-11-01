import { sql } from 'kysely';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import type {
  FenceOwnAccount,
  FencePersonalRecording,
  PersonalScopeTx,
  ReadPersonalRecordingNow,
  RecordingScopeTx,
  WithPersonalScope,
} from '../../modules/identity/public.js';
import { transactionOf } from '../../infrastructure/postgres/personal-scope.js';
import { recordingTransactionOf } from '../../infrastructure/postgres/recording-scope.js';
import {
  PersonalReasoningRefused,
  type AttemptLedger,
  type PersonalHarnessAccess,
  type PersonalRecordingPurpose,
  type CheckPersonalRecordingRun,
  type RunDescriptor,
} from '../application/ports.js';
import { recordingProofMatches } from './ledger-values.js';
import { parsePersonalRecordingPurpose, parsePersonalRunAccountingBinding } from '../application/personal-recording.js';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
interface Header {
  owner_module: string;
  purpose: string;
  privacy_epoch: number;
  state: string;
  privacy_erased_at: Date | null;
  role_id: string;
  role_version: string;
  policy_version: string;
  provider: string;
  model: string;
  context_bundle_ref: string | null;
  context_refs: unknown;
  recording_account_id: string | null;
  recording_generation: number | null;
  recording_context_sha256: string | null;
  recording_model_context_sha256: string | null;
}
/** Exact PK header only. No output, issues, model request or owning module frozen context. */
async function header(scope: PersonalScopeTx, id: string) {
  return (
    await sql<Header>`select owner_module,purpose,privacy_epoch,state,privacy_erased_at,
    role_id,role_version,policy_version,provider,model,context_bundle_ref,context_refs,
    recording_account_id,recording_generation,recording_context_sha256,recording_model_context_sha256
    from reasoning.business_runs where universe_id=${scope.authority.universeId}::uuid and id=${id}::uuid`.execute(
      transactionOf(scope),
    )
  ).rows[0];
}
function matches(row: Header, descriptor: RunDescriptor, scope: PersonalScopeTx) {
  return (
    row.privacy_epoch === scope.authority.privacyEpoch &&
    row.owner_module === descriptor.ownerModule &&
    row.purpose === descriptor.purpose &&
    row.role_id === descriptor.roleId &&
    row.role_version === descriptor.roleVersion &&
    row.policy_version === descriptor.policyVersion &&
    row.provider === descriptor.provider &&
    row.model === descriptor.model &&
    row.context_bundle_ref === descriptor.contextBundleRef &&
    canonicalSha256(row.context_refs) === canonicalSha256(descriptor.contextRefs)
  );
}
function proofMatches(row: Header, purpose: PersonalRecordingPurpose | undefined) {
  return recordingProofMatches(
    row,
    purpose
      ? {
          accountId: purpose.accountId,
          generation: purpose.recordingGeneration,
          contextSha256: purpose.contextSha256,
          modelContextSha256: purpose.modelContextSha256,
        }
      : undefined,
  );
}

export function makePersonalReasoningAccess(p: {
  readonly withScope: WithPersonalScope;
  readonly fenceOwn: FenceOwnAccount;
  readonly fenceRecording: FencePersonalRecording;
  readonly readRecording: ReadPersonalRecordingNow;
  readonly ledger: AttemptLedger;
  readonly checkOwner?: CheckPersonalRecordingRun;
}): PersonalHarnessAccess {
  if (typeof p.fenceOwn !== 'function' || typeof p.fenceRecording !== 'function')
    throw new Error('PERSONAL_REASONING_IDENTITY_GATES_REQUIRED');
  const applyEntries = new WeakMap<RecordingScopeTx, PersonalRecordingPurpose>();
  const entries = new WeakMap<PersonalScopeTx, { readonly scope: RecordingScopeTx; readonly accountId: string }>();
  async function check(
    scope: PersonalScopeTx,
    descriptor: RunDescriptor,
    purpose: PersonalRecordingPurpose | undefined,
  ) {
    const entry = entries.get(scope);
    if (!entry) throw new PersonalReasoningRefused('scope_refused');
    recordingTransactionOf(entry.scope); // Genuine and still open; copied or closed scopes fail.
    const gate = await p.fenceRecording(scope, purpose?.recordingGeneration);
    if (gate.kind !== 'recording' || gate.scope.generation !== entry.scope.generation)
      throw new PersonalReasoningRefused('scope_refused');
    if (purpose) {
      if (
        !p.checkOwner ||
        !same(purpose.accountId, entry.accountId) ||
        !same(purpose.universeId, scope.authority.universeId) ||
        purpose.privacyEpoch !== scope.authority.privacyEpoch ||
        !same(purpose.businessRunId, descriptor.id) ||
        purpose.ownerModule !== descriptor.ownerModule ||
        purpose.purpose !== descriptor.purpose ||
        (await p.checkOwner(entry.scope, purpose)) !== 'current'
      )
        throw new PersonalReasoningRefused('scope_refused');
    } else if (entry.scope.generation !== 1) throw new PersonalReasoningRefused('scope_refused');
    const row = await header(scope, descriptor.id);
    if (!row) return;
    if (row.privacy_epoch !== scope.authority.privacyEpoch) throw new PersonalReasoningRefused('run_mismatch');
    if (row.privacy_erased_at !== null) throw new PersonalReasoningRefused('output_ineligible');
    if (!matches(row, descriptor, scope) || !proofMatches(row, purpose))
      throw new PersonalReasoningRefused('run_mismatch');
    if (row.state !== 'admitted') throw new PersonalReasoningRefused('run_closed');
  }
  return {
    async enter(authority, descriptor, purpose, work) {
      try {
        const entered = await p.withScope(authority, async (scope) => {
          const own = await p.fenceOwn(scope);
          if (own.kind !== 'active') throw new PersonalReasoningRefused('scope_refused');
          // Account binding precedes classification. A wrong actor/purpose never gains even
          // necessary cancellation authority from a later generation refusal.
          if (
            purpose &&
            (!same(purpose.accountId, own.owner.accountId) ||
              !same(purpose.universeId, scope.authority.universeId) ||
              purpose.privacyEpoch !== scope.authority.privacyEpoch)
          )
            throw new PersonalReasoningRefused('scope_refused');
          const gate = await p.fenceRecording(scope, purpose?.recordingGeneration);
          if (gate.kind !== 'recording')
            throw new PersonalReasoningRefused(
              'scope_refused',
              gate.kind === 'paused' || gate.kind === 'stale' || gate.kind === 'generation_required',
            );
          entries.set(scope, { scope: gate.scope, accountId: own.owner.accountId });
          try {
            await check(scope, descriptor, purpose);
            return await work(scope);
          } finally {
            entries.delete(scope);
          }
        });
        // Root refusal runs before the own gate. Only server-owned accounting can classify
        // actual epoch/status/barrier revocation here; account actors remain unproved/held.
        if (
          entered.kind === 'refused' &&
          authority.actor.kind === 'system' &&
          (entered.refusal.kind === 'epoch_changed' || entered.refusal.kind === 'universe_suspended')
        )
          return { ...entered, refusal: { ...entered.refusal, accountingRevoked: true as const } };
        return entered;
      } catch (error) {
        if (!(error instanceof PersonalReasoningRefused)) throw error;
        return {
          kind: 'refused',
          refusal: { kind: error.reason, ...(error.accountingRevoked ? { accountingRevoked: true as const } : {}) },
        };
      }
    },
    check,
    async checkAttempt(scope, descriptor, step, requestHash) {
      const entry = entries.get(scope);
      if (!entry) throw new PersonalReasoningRefused('scope_refused');
      recordingTransactionOf(entry.scope);
      // Fixed raw prefix, before logical-step selection. No private payload or history refill.
      const rows = (
        await sql<{ id: string; step: string; request_hash: string; reserved_at: Date }>`
        select id,step,request_hash,reserved_at from reasoning.external_attempts
        where universe_id=${scope.authority.universeId}::uuid and run_id=${descriptor.id}::uuid
        order by step limit 9`.execute(transactionOf(scope))
      ).rows;
      if (rows.length > 8 || rows.some((r) => !/^(?:primary|repair)(?:\.[234])?$/u.test(r.step)))
        throw new PersonalReasoningRefused('run_mismatch');
      const latest = rows
        .filter((r) => r.step === step || r.step.startsWith(step + '.'))
        .sort(
          (a, b) => new Date(b.reserved_at).getTime() - new Date(a.reserved_at).getTime() || b.id.localeCompare(a.id),
        )[0];
      if (latest && latest.request_hash !== requestHash) throw new PersonalReasoningRefused('request_mismatch');
    },
    async readProtected(scope, descriptor, attempt, _step, requestHash) {
      const entry = entries.get(scope);
      if (!entry || !same(scope.authority.universeId, attempt.scopeId))
        throw new PersonalReasoningRefused('run_mismatch');
      // check() already ran at this entry before this private query; exact run join prevents cross-run byte reads.
      recordingTransactionOf(entry.scope);
      const row = (
        await sql<{ body: Buffer }>`select request.body from reasoning.protected_requests request
        join reasoning.external_attempts attempt on attempt.universe_id=request.universe_id and attempt.id=request.attempt_id
        join reasoning.business_runs run on run.universe_id=attempt.universe_id and run.id=attempt.run_id
        where request.universe_id=${scope.authority.universeId}::uuid and request.attempt_id=${attempt.attemptId}::uuid
          and attempt.run_id=${descriptor.id}::uuid and attempt.request_hash=${requestHash} and attempt.privacy_erased_at is null and run.privacy_erased_at is null
          and request.expires_at>now()`.execute(transactionOf(scope))
      ).rows[0];
      return row ? new Uint8Array(row.body) : undefined;
    },
    async apply(authority, purpose, work) {
      try {
        return await p.withScope(authority, async (scope) => {
          const own = await p.fenceOwn(scope);
          if (
            own.kind !== 'active' ||
            !same(own.owner.accountId, purpose.accountId) ||
            !same(scope.authority.universeId, purpose.universeId) ||
            scope.authority.privacyEpoch !== purpose.privacyEpoch
          )
            throw new PersonalReasoningRefused('scope_refused');
          const gate = await p.fenceRecording(scope, purpose.recordingGeneration);
          if (gate.kind !== 'recording' || !p.checkOwner || (await p.checkOwner(gate.scope, purpose)) !== 'current')
            throw new PersonalReasoningRefused('scope_refused');
          const row = await header(scope, purpose.businessRunId);
          if (
            !row ||
            row.privacy_erased_at !== null ||
            row.state !== 'admitted' ||
            row.privacy_epoch !== purpose.privacyEpoch ||
            row.owner_module !== purpose.ownerModule ||
            row.purpose !== purpose.purpose ||
            !proofMatches(row, purpose)
          )
            throw new PersonalReasoningRefused('run_mismatch');
          applyEntries.set(gate.scope, purpose);
          try {
            return await work(gate.scope);
          } finally {
            applyEntries.delete(gate.scope);
          }
        });
      } catch (error) {
        if (!(error instanceof PersonalReasoningRefused)) throw error;
        return { kind: 'refused', refusal: { kind: error.reason } };
      }
    },
    async close(scope, value, run) {
      recordingTransactionOf(scope);
      const purpose = parsePersonalRecordingPurpose(value),
        issued = applyEntries.get(scope);
      if (
        !purpose ||
        !issued ||
        canonicalSha256(issued) !== canonicalSha256(purpose) ||
        !p.checkOwner ||
        !same(run.runId, purpose.businessRunId) ||
        !same(scope.personal.authority.universeId, purpose.universeId) ||
        scope.personal.authority.privacyEpoch !== purpose.privacyEpoch ||
        scope.generation !== purpose.recordingGeneration
      )
        throw new PersonalReasoningRefused('scope_refused');
      const gate = await p.fenceRecording(scope.personal, purpose.recordingGeneration);
      if (gate.kind !== 'recording' || (await p.checkOwner(scope, purpose)) !== 'current')
        throw new PersonalReasoningRefused('scope_refused');
      const row = await header(scope.personal, run.runId);
      if (
        !row ||
        row.privacy_erased_at !== null ||
        row.privacy_epoch !== purpose.privacyEpoch ||
        row.owner_module !== purpose.ownerModule ||
        row.purpose !== purpose.purpose ||
        !proofMatches(row, purpose)
      )
        throw new PersonalReasoningRefused('run_mismatch');
      return p.ledger.closeRun(scope.personal, run);
    },
    async currentOwner(scope) {
      transactionOf(scope);
      const own = await p.fenceOwn(scope);
      if (own.kind !== 'active') return undefined;
      const now = await p.readRecording(scope);
      return now.kind === 'recording' ? { accountId: own.owner.accountId, generation: now.generation } : undefined;
    },
    async closeLegacy(scope, run) {
      transactionOf(scope);
      const own = await p.fenceOwn(scope);
      if (own.kind !== 'active') throw new PersonalReasoningRefused('scope_refused');
      const gate = await p.fenceRecording(scope, undefined);
      if (gate.kind !== 'recording' || gate.scope.generation !== 1) throw new PersonalReasoningRefused('scope_refused');
      const row = await header(scope, run.runId);
      if (
        row &&
        (row.privacy_erased_at !== null ||
          row.privacy_epoch !== scope.authority.privacyEpoch ||
          !proofMatches(row, undefined))
      )
        throw new PersonalReasoningRefused('run_mismatch');
      return p.ledger.closeRun(scope, run);
    },
    async readAccounting(scope, runId, readExpectedBinding) {
      transactionOf(scope);
      if (typeof runId !== 'string' || !uuid.test(runId) || typeof readExpectedBinding !== 'function')
        return { kind: 'unavailable', reason: 'unproved' };
      const own = await p.fenceOwn(scope);
      if (own.kind !== 'active') return { kind: 'unavailable', reason: 'authority' };
      // The fixed owner callback runs only after the actual own-account gate, once, in this root transaction.
      // It reads ONLY the owning minimal header, and may retain that header locally for necessary retirement.
      const owner = Object.freeze({
        accountId: own.owner.accountId,
        universeId: own.owner.universeId,
        privacyEpoch: own.owner.privacyEpoch,
      });
      const expected = parsePersonalRunAccountingBinding(await readExpectedBinding(scope, owner));
      if (
        !expected ||
        !same(expected.accountId, own.owner.accountId) ||
        expected.privacyEpoch !== scope.authority.privacyEpoch
      )
        return { kind: 'unavailable', reason: 'unproved' };
      // No context refs, hashes, body, output or issues are returned by this query. NULL legacy is never adopted.
      const run = (
        await sql<{
          owner_module: string;
          purpose: string;
          privacy_epoch: number;
          privacy_erased: boolean;
          recording_account_id: string | null;
          recording_generation: number | null;
          proof_complete: boolean;
        }>`
          select owner_module,purpose,privacy_epoch,privacy_erased_at is not null as privacy_erased,
          recording_account_id,recording_generation,
          (recording_context_sha256 is not null and recording_model_context_sha256 is not null) as proof_complete
          from reasoning.business_runs
          where universe_id=${scope.authority.universeId}::uuid and id=${runId}::uuid`.execute(transactionOf(scope))
      ).rows[0];
      // Validated composite FK proves no RETAINED attempts for an absent parent, not zero historical liability.
      // The owner callback must have proved a still-present current-epoch header before this distinct result.
      if (!run) return { kind: 'not_found' };
      if (
        run.privacy_erased ||
        run.owner_module !== expected.ownerModule ||
        run.purpose !== expected.purpose ||
        run.privacy_epoch !== expected.privacyEpoch ||
        expected.recordingGeneration === null ||
        run.recording_generation !== expected.recordingGeneration ||
        !run.recording_account_id ||
        !same(run.recording_account_id, expected.accountId) ||
        !run.proof_complete
      )
        return { kind: 'unavailable', reason: 'unproved' };
      const rows = (
        await sql<{ id: string; step: string; state: string }>`select id,step,state from reasoning.external_attempts
        where universe_id=${scope.authority.universeId}::uuid and run_id=${runId}::uuid order by step limit 9`.execute(
          transactionOf(scope),
        )
      ).rows;
      if (rows.length > 8) return { kind: 'unavailable', reason: 'limit' };
      const states = [
        'reserved',
        'dispatched',
        'succeeded',
        'failed',
        'unknown',
        'not_sent',
        'reconciled',
        'written_off',
      ] as const;
      if (rows.some((r) => !/^(?:primary|repair)(?:\.[234])?$/u.test(r.step) || !states.some((s) => s === r.state)))
        return { kind: 'unavailable', reason: 'unproved' };
      return {
        kind: 'accounted',
        disposition: rows.some((r) => ['reserved', 'dispatched', 'unknown'].includes(r.state))
          ? 'unresolved'
          : 'conclusive',
        attempts: rows.map((r) => ({ attemptId: r.id, step: r.step, state: r.state as (typeof states)[number] })),
      };
    },
  };
}
