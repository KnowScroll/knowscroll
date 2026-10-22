import {
  ClearExplorationSchema,
  ClearExplorationAcceptanceSchema,
  ClearExplorationStatusSchema,
  ReadClearExplorationStatusSchema,
  type ClearExplorationAcceptance,
} from '@knowscroll/contracts';
import type { PrivacyAuthority } from '../public.js';
import { ClearRecoveryJobSchema, ClearExplorationJobSchema } from '../events.js';
import type { ClearAccepted, ClearOperation, ClearPorts, ClearRejected, ClearStatusRead } from './clear-ports.js';
const version = 'clear-exploration.v1' as const;
function receipt(op: ClearOperation) {
  return { commandId: op.commandId, fromEpoch: op.fromEpoch, toEpoch: op.toEpoch, recordedAt: op.recordedAt };
}
function acceptance(op: ClearOperation, replayed: boolean): ClearExplorationAcceptance {
  if (op.outcomeVersion !== 1) throw new Error('CLEAR_RECEIPT_UNAVAILABLE');
  return ClearExplorationAcceptanceSchema.parse({
    version,
    ...receipt(op),
    operation: 'privacy.clear-exploration',
    outcome: 'accepted',
    replayed,
  });
}
/** Account-lifetime receipt replay occurs only after current authenticated ownership/epoch fencing. */
export function makeClearExploration(ports: ClearPorts) {
  return {
    start(authority: PrivacyAuthority, input: unknown) {
      return ports.withPrivacyScope(authority, async (scope): Promise<ClearAccepted | ClearRejected> => {
        const parsed = ClearExplorationSchema.safeParse(input);
        if (!parsed.success) return { kind: 'rejected', code: 'INVALID_REQUEST' };
        const body = parsed.data,
          hash = ports.hash(body);
        const old = await ports.store.read(scope, { kind: 'command', commandId: body.commandId });
        if (old) {
          if (old.requestHash !== hash) return { kind: 'rejected', code: 'COMMAND_KEY_REUSED' };
          try {
            return { kind: 'ok', value: acceptance(old, true) };
          } catch {
            return { kind: 'rejected', code: 'SERVICE_UNAVAILABLE' };
          }
        }
        if (
          body.expectedPrivacyEpoch !== scope.authority.privacyEpoch ||
          scope.barrierId !== null ||
          scope.authority.privacyEpoch >= 2147483647 ||
          scope.revisionAtEntry > 2147483645
        )
          return { kind: 'rejected', code: 'CONFLICT' };
        // Bounded owner snapshot is captured before barrier publication, under root/run/attempt/receipt locks.
        const liabilities = await ports.reasoning.capture(scope);
        const op = await ports.store.create(scope, body.commandId, hash, liabilities);
        await ports.enqueue(scope, { v: 1, accountId: scope.authority.accountId, commandId: body.commandId });
        return { kind: 'ok', value: acceptance(op, false) };
      });
    },
    status(authority: PrivacyAuthority, input: unknown) {
      return ports.withPrivacyScope(authority, async (scope): Promise<ClearStatusRead | ClearRejected> => {
        const parsed = ReadClearExplorationStatusSchema.safeParse(input);
        if (!parsed.success) return { kind: 'rejected', code: 'INVALID_REQUEST' };
        const target = parsed.data.target,
          op = await ports.store.read(scope, target);
        const snapshot = {
          version,
          scope: { accountId: scope.authority.accountId, privacyEpoch: scope.authority.privacyEpoch },
          target,
        };
        const candidate = !op
          ? { ...snapshot, status: 'not_recorded' }
          : op.completed
            ? { ...snapshot, status: 'completed_live', receipt: receipt(op) }
            : op.failureCode
              ? { ...snapshot, status: 'failed', receipt: receipt(op), phase: op.phase, code: op.failureCode }
              : { ...snapshot, status: 'pending', receipt: receipt(op), phase: op.phase };
        const result = ClearExplorationStatusSchema.safeParse(candidate);
        return result.success && (!op || op.outcomeVersion === 1)
          ? { kind: 'ok', value: result.data }
          : { kind: 'rejected', code: 'SERVICE_UNAVAILABLE' };
      });
    },
    async process(input: unknown): Promise<void> {
      const job = ClearExplorationJobSchema.parse(input);
      await ports.withMaintenance(job.accountId, job.commandId, async (scope) => {
        if (!ports.isCore(scope)) return;
        await ports.eraseCore(scope);
        await ports.store.coreDone(scope);
      });
      // A new transaction can only obtain exact-set accounting authority after core_done.
      await ports.withMaintenance(job.accountId, job.commandId, async (scope) => {
        if (ports.isCore(scope)) throw new Error('CLEAR_CORE_INCOMPLETE');
        const result = await ports.reasoning.verifyAndPrune(scope);
        if (scope.completed && result === 'pending') throw new Error('CLEAR_ACCOUNTING_UNVERIFIED');
        if (scope.completed) {
          if (result === 'verified' && scope.cleanupDueAt !== null) await ports.store.cleanupDone(scope);
          return;
        }
        const wake = await ports.store.accountingDone(scope, result);
        if (wake) await ports.enqueue(scope, job, new Date(Math.min(wake.getTime(), ports.now().getTime() + 86399000)));
      });
    },
    async recover(input: unknown = { v: 1 }): Promise<{ scheduled: number; skipped: number }> {
      ClearRecoveryJobSchema.parse(input);
      const candidates = await ports.readRecoveryCandidates();
      if (candidates.length > 25) throw new Error('CLEAR_RECOVERY_BATCH_INVALID');
      let scheduled = 0,
        skipped = 0;
      for (const candidate of candidates) {
        try {
          const applied = await ports.withRecoveryMaintenance(
            candidate.accountId,
            candidate.commandId,
            async (scope) => {
              if (!(await ports.store.claimRecovery(scope))) return false;
              await ports.enqueue(scope, {
                v: 1,
                accountId: scope.binding.accountId,
                commandId: scope.binding.commandId,
              });
              return true;
            },
          );
          if (applied) scheduled++;
          else skipped++;
        } catch (error) {
          const code = (error as { readonly code?: unknown }).code;
          if (code === '55P03' || code === '57014' || code === 'SCOPE_BUSY') {
            skipped++;
            continue;
          }
          throw error;
        }
      }
      return { scheduled, skipped };
    },
    async fail(input: unknown, code: 'temporarily_unavailable' | 'completion_unverified'): Promise<void> {
      const job = ClearExplorationJobSchema.parse(input);
      await ports.withMaintenance(job.accountId, job.commandId, (scope) => ports.store.fail(scope, code));
    },
  };
}
