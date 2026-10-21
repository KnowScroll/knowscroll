import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { cutroomTransactionOf } from '../../../infrastructure/postgres/cutroom-scope.js';
import type { CommissionStore } from '../production/commission-ports.js';
export const postgresCommissionStore: CommissionStore = {
  async lock(scope, id) {
    const r = await sql<{
      world_id: 'dev' | 'stage';
      business_run_id: string;
      command_sha256: string;
      attempt_id: string | null;
    }>`select world_id,business_run_id,command_sha256,attempt_id from content.reel_commissions where world_id=${scope.authority.worldId} and business_run_id=${id}::uuid for update`.execute(
      cutroomTransactionOf(scope),
    );
    const row = r.rows[0];
    return row
      ? {
          worldId: row.world_id,
          businessRunId: row.business_run_id,
          commandSha256: row.command_sha256,
          attemptId: row.attempt_id,
        }
      : undefined;
  },
  async insert(scope, c, commandSha, packageUtf8) {
    const result =
      await sql`insert into content.reel_commissions(world_id,business_run_id,generation,script_sha256,evidence_sha256,policy_version,approval_ref,command_sha256,package_utf8,package_sha256,request_sha256,request_id,take,ceiling_cents)
   values(${scope.authority.worldId},${c.businessRunId}::uuid,${c.generation},${c.scriptSha256},${c.evidenceSha256},${c.policyVersion},${c.approvalRef},${commandSha},${packageUtf8},${createHash('sha256').update(packageUtf8, 'utf8').digest('hex')},${c.requestSha256},${c.requestId},${c.take},${c.ceilingCents}) on conflict do nothing returning business_run_id`.execute(
        cutroomTransactionOf(scope),
      );
    return result.rows.length === 1;
  },
  async bind(scope, id, attemptId) {
    const result =
      await sql`update content.reel_commissions set attempt_id=${attemptId}::uuid where world_id=${scope.authority.worldId} and business_run_id=${id}::uuid and attempt_id is null`.execute(
        cutroomTransactionOf(scope),
      );
    if (result.numAffectedRows !== 1n) throw new Error('COMMISSION_ATTEMPT_ALREADY_BOUND');
  },
};
