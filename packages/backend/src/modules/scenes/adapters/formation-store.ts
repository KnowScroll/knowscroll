import { sql, type Kysely } from 'kysely';
import { fromKysely, type PgBoss } from 'pg-boss';
import { FormationPresentationFactSchema } from '@knowscroll/contracts';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf, withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import type { FormationRecord, FormationStore, FormationRecoveryCandidate } from '../application/ports.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import {
  RecoverFormationJobSchema,
  recoverFormationQueue,
  projectSceneQueue,
  ProjectSceneJobSchema,
} from '../events.js';
interface Row {
  presentation_key: string;
  transition_id: string;
  recorded_at: Date;
  geography_revision: number;
  structure_revision: number;
  activity_revision: number;
  target_count: number;
  fact: unknown;
  limited: boolean;
  claim_id: string | null;
  attempt_nonce: string | null;
  claimed_at: Date | null;
  claim_expires_at: Date | null;
  disposition: 'shown' | 'skipped' | null;
  terminal_at: Date | null;
}
function record(r: Row): FormationRecord {
  return {
    key: String(r.presentation_key),
    transitionId: r.transition_id,
    recordedAt: r.recorded_at.toISOString(),
    geography: {
      revision: r.geography_revision,
      structureRevision: r.structure_revision,
      activityRevision: r.activity_revision,
    },
    targetCount: r.target_count,
    limit: r.limited,
    ...(r.fact ? { fact: FormationPresentationFactSchema.parse(r.fact) } : {}),
    ...(r.claim_id
      ? {
          claim: {
            claimId: r.claim_id,
            attemptNonce: r.attempt_nonce!,
            claimedAt: r.claimed_at!.toISOString(),
            expiresAt: r.claim_expires_at!.toISOString(),
          },
        }
      : {}),
    ...(r.disposition ? { terminal: { disposition: r.disposition, recordedAt: r.terminal_at!.toISOString() } } : {}),
  };
}
export const formationStore: FormationStore = {
  async record(scope, r) {
    await sql`insert into scenes.formation_presentations(universe_id,privacy_epoch,transition_id,recorded_at,geography_revision,structure_revision,activity_revision,target_count,fact,limited)
      values(${scope.authority.universeId}::uuid,${scope.authority.privacyEpoch},${r.transitionId}::uuid,${r.recordedAt}::timestamptz,${r.geography.revision},${r.geography.structureRevision},${r.geography.activityRevision},${r.targetCount},${r.fact ? JSON.stringify(r.fact) : null}::jsonb,${r.limit})`.execute(
      transactionOf(scope),
    );
  },
  async read(scope, target) {
    const rows =
      await sql<Row>`select * from scenes.formation_presentations where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch}
      ${target.kind === 'transition' ? sql`and transition_id=${target.transitionId}::uuid` : sql``}
      order by recorded_at desc,presentation_key desc limit 1`.execute(transactionOf(scope));
    return rows.rows[0] ? record(rows.rows[0]) : undefined;
  },
  async claim(scope, id, c) {
    const result =
      await sql`update scenes.formation_presentations set claim_id=${c.claimId}::uuid,attempt_nonce=${c.attemptNonce}::uuid,claimed_at=${c.claimedAt}::timestamptz,claim_expires_at=${c.expiresAt}::timestamptz
      where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch} and transition_id=${id}::uuid and claim_id is null and disposition is null`.execute(
        transactionOf(scope),
      );
    if (result.numAffectedRows !== 1n) throw new Error('FORMATION_CLAIM_CONFLICT');
  },
  async terminal(scope, id, claimId, disposition, recordedAt) {
    const result =
      await sql`update scenes.formation_presentations set disposition=${disposition},terminal_at=${recordedAt}::timestamptz
      where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch} and transition_id=${id}::uuid and claim_id=${claimId}::uuid and disposition is null`.execute(
        transactionOf(scope),
      );
    return result.numAffectedRows === 1n;
  },
};
/** Global discovery sees only bounded due row identities; every effect re-enters its exact root.
 * The durable child is committed first. Erasing a personal row removes every link from these
 * global ordinal-only payloads to its IDs. Overlapping cron passes may visit an ordinal twice. */
export function formationRecoveryPage(db: Kysely<Database>, boss: PgBoss) {
  return (input: unknown) =>
    withTransaction(db, 'formation-recovery-index', async (tx) => {
      const q = RecoverFormationJobSchema.parse(input);
      await sql`select set_config('statement_timeout','2000ms',true),set_config('lock_timeout','250ms',true)`.execute(
        tx,
      );
      const ceiling =
        'throughKey' in q
          ? q.throughKey
          : (
              await sql<{
                key: string | null;
              }>`select max(presentation_key)::text as key from scenes.formation_presentations`.execute(tx)
            ).rows[0]?.key;
      if (!ceiling) return [];
      const after = 'afterKey' in q ? q.afterKey : '0';
      const result = await sql<
        FormationRecoveryCandidate & { key: string }
      >`select presentation_key::text as key,universe_id as "universeId",privacy_epoch as "privacyEpoch",transition_id as "transitionId",claim_id as "claimId"
      from scenes.formation_presentations where presentation_key>${after}::bigint and presentation_key<=${ceiling}::bigint
      and claim_id is not null and disposition is null and claim_expires_at<=CURRENT_TIMESTAMP order by presentation_key limit 101`.execute(
        tx,
      );
      const page = result.rows.slice(0, 100);
      if (result.rows.length > 100) {
        const child = RecoverFormationJobSchema.parse({ v: 1, afterKey: page[99]!.key, throughKey: ceiling });
        if (!('afterKey' in child)) throw new Error('FORMATION_CURSOR_REQUIRED');
        await sql`select pg_advisory_xact_lock(hashtextextended(${`${recoverFormationQueue.name}:${child.afterKey}:${child.throughKey}`},0))`.execute(
          tx,
        );
        const live = await sql<{
          live: boolean;
        }>`select exists(select 1 from pgboss.job where name=${recoverFormationQueue.name}
        and data->>'v'='1' and data->>'afterKey'=${child.afterKey} and data->>'throughKey'=${child.throughKey}
        and ((state in('created','retry') and keep_until>pgboss.job_now()) or(state='active' and started_on+expire_seconds*interval '1 second'>=pgboss.job_now()
          and(heartbeat_seconds is null or heartbeat_on+heartbeat_seconds*interval '1 second'>=pgboss.job_now())))) as live`.execute(
          tx,
        );
        if (!live.rows[0]?.live) {
          const id = await boss.send(recoverFormationQueue.name, child, { db: fromKysely(tx) });
          if (id === null) throw new Error('FORMATION_CONTINUATION_REQUIRED');
        }
      }
      return page.map(({ key: _key, ...candidate }) => candidate);
    });
}

/** U05 promises pending projection only for a real current live delivery, including pg-boss
 * retention/lease/heartbeat expiry. The older Scene-read adapter is unchanged. */
export async function formationProjectionPending(scope: PersonalScopeTx) {
  const rows = await sql<{ data: unknown }>`select data from pgboss.job where name=${projectSceneQueue.name}
 and data->>'universeId'=${scope.authority.universeId} and data->>'privacyEpoch'=${String(scope.authority.privacyEpoch)}
 and ((state in('created','retry') and keep_until>pgboss.job_now())
 or(state='active' and started_on+expire_seconds*interval '1 second'>=pgboss.job_now()
 and(heartbeat_seconds is null or heartbeat_on+heartbeat_seconds*interval '1 second'>=pgboss.job_now())))
 order by (data->'geography'->>'revision')::bigint desc limit 1`.execute(transactionOf(scope));
  const parsed = ProjectSceneJobSchema.safeParse(rows.rows[0]?.data);
  return parsed.success
    ? { geographyRevision: parsed.data.geography.revision, personalRevision: parsed.data.personalRevision }
    : undefined;
}
