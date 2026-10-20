import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import {
  composeEncounter,
  type ComposerDecision,
  type PersistComposerDecision,
  type ReadComposerDecision,
  type PruneComposerDecisions,
  type ComposerOperatorAccess,
} from '../public.js';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function uuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}
export function makeComposerStore(access: ComposerOperatorAccess): {
  persistComposerDecision: PersistComposerDecision;
  readComposerDecision: ReadComposerDecision;
  pruneComposerDecisions: PruneComposerDecisions;
} {
  return {
    async persistComposerDecision(scope, binding, decision) {
      if (decision.universeId !== scope.authority.universeId || decision.privacyEpoch !== scope.authority.privacyEpoch)
        throw new Error('COMPOSER_SCOPE_MISMATCH');
      if (
        !uuid(binding.decisionId) ||
        !uuid(binding.commandId) ||
        (binding.sessionId === undefined) !== (binding.intentRevision === undefined) ||
        (binding.sessionId !== undefined && !uuid(binding.sessionId)) ||
        (binding.intentRevision !== undefined &&
          (!Number.isSafeInteger(binding.intentRevision) || binding.intentRevision < 0))
      )
        throw new Error('COMPOSER_BINDING_INVALID');
      // The saved result must be the immutable replay of these exact pure inputs.
      if (canonical(decision) !== canonical(composeEncounter(decision.input)))
        throw new Error('COMPOSER_REPLAY_INVALID');
      const payload = canonical(decision);
      if (Buffer.byteLength(payload) > 262144) throw new Error('COMPOSER_DECISION_LIMIT');
      const hash = createHash('sha256').update(canonical({ binding, decision })).digest('hex');
      const db = transactionOf(scope);
      const inserted =
        await sql`insert into composer.decisions(id,universe_id,privacy_epoch,command_id,session_id,intent_revision,input_sha256,policy_version,payload,expires_at)
        values(${binding.decisionId}::uuid,${scope.authority.universeId}::uuid,${scope.authority.privacyEpoch},${binding.commandId}::uuid,${binding.sessionId ?? null}::uuid,${binding.intentRevision ?? null},${hash},${decision.policyVersion},${payload}::jsonb,now()+interval '30 days') on conflict do nothing returning id`.execute(
          db,
        );
      if (inserted.rows.length) return 'stored';
      const existing = await sql<{
        input_sha256: string;
      }>`select input_sha256 from composer.decisions where id=${binding.decisionId}::uuid and universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch} and command_id=${binding.commandId}::uuid`.execute(
        db,
      );
      if (existing.rows[0]?.input_sha256 !== hash) throw new Error('COMPOSER_DECISION_CONFLICT');
      return 'replayed';
    },
    async readComposerDecision(scope, decisionId) {
      if (!access.isOperator(scope.authority)) throw new Error('COMPOSER_OPERATOR_REQUIRED');
      const rows = await sql<{
        id: string;
        command_id: string;
        session_id: string | null;
        intent_revision: number | null;
        payload: ComposerDecision;
        input_sha256: string;
      }>`select id,command_id,session_id,intent_revision,payload,input_sha256 from composer.decisions where id=${decisionId}::uuid and universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch} and expires_at>now()`.execute(
        transactionOf(scope),
      );
      const r = rows.rows[0];
      return r
        ? {
            binding: {
              decisionId: r.id,
              commandId: r.command_id,
              ...(r.session_id !== null && r.intent_revision !== null
                ? { sessionId: r.session_id, intentRevision: r.intent_revision }
                : {}),
            },
            decision: r.payload,
            inputSha256: r.input_sha256,
          }
        : undefined;
    },
    async pruneComposerDecisions(scope, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('COMPOSER_PRUNE_LIMIT');
      const result =
        await sql`delete from composer.decisions where id in (select id from composer.decisions where universe_id=${scope.authority.universeId}::uuid and expires_at<=now() order by expires_at,id limit ${limit}) returning id`.execute(
          transactionOf(scope),
        );
      return result.rows.length;
    },
  };
}
