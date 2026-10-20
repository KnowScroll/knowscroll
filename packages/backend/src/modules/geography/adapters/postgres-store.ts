import { sql } from 'kysely';
import { UniverseDeltaSchema, GeographyAliasSchema } from '@knowscroll/contracts';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { GeographyStore, GeographyRun, GeographyContext } from '../application/ports.js';
import { GeographyProposalSchema, type Place, type Route } from '../domain/policy.js';
const owner = (s: Parameters<GeographyStore['state']>[0]) => ({
  tx: transactionOf(s),
  u: s.authority.universeId,
  e: s.authority.privacyEpoch,
});
/** Every private lookup retains universe and epoch predicates; IDs grant no access. */
export const geographyStore: GeographyStore = {
  async state(scope) {
    const { tx, u, e } = owner(scope);
    const row = (
      await sql<{
        revision: number;
        structure_revision: number;
        activity_revision: number;
        desired_revision: number;
        material_revision: number;
        published_revision: number;
        active_run_id: string | null;
      }>`select * from geography.state where universe_id=${u}::uuid and privacy_epoch=${e}`.execute(tx)
    ).rows[0];
    return row
      ? {
          revision: row.revision,
          structureRevision: row.structure_revision,
          activityRevision: row.activity_revision,
          desiredRevision: row.desired_revision,
          materialRevision: row.material_revision,
          publishedRevision: row.published_revision,
          ...(row.active_run_id ? { activeRunId: row.active_run_id } : {}),
        }
      : {
          revision: 0,
          structureRevision: 0,
          activityRevision: 0,
          desiredRevision: 0,
          materialRevision: 0,
          publishedRevision: 0,
        };
  },
  async writeState(scope, s) {
    const { tx, u, e } = owner(scope);
    await sql`insert into geography.state(universe_id,privacy_epoch,revision,structure_revision,activity_revision,desired_revision,material_revision,published_revision,active_run_id)
 values(${u}::uuid,${e},${s.revision},${s.structureRevision},${s.activityRevision},${s.desiredRevision},${s.materialRevision},${s.publishedRevision},${s.activeRunId ?? null}::uuid)
 on conflict(universe_id,privacy_epoch) do update set revision=excluded.revision,structure_revision=excluded.structure_revision,activity_revision=excluded.activity_revision,desired_revision=excluded.desired_revision,material_revision=excluded.material_revision,published_revision=excluded.published_revision,active_run_id=excluded.active_run_id`.execute(
      tx,
    );
  },
  async view(scope) {
    const { tx, u, e } = owner(scope);
    const objects = (
      await sql<{
        id: string;
        semantic_key: string;
        payload: Place;
      }>`select id,semantic_key,payload from geography.objects where universe_id=${u}::uuid and privacy_epoch=${e} order by id limit 1001`.execute(
        tx,
      )
    ).rows;
    const relations = (
      await sql<{
        id: string;
        semantic_key: string;
        kind: string;
        payload: unknown;
      }>`select id,semantic_key,kind,payload from geography.relations where universe_id=${u}::uuid and privacy_epoch=${e} order by id limit 1001`.execute(
        tx,
      )
    ).rows;
    if (objects.some((r) => r.id !== r.payload.id || r.semantic_key !== r.payload.key))
      throw new Error('GEOGRAPHY_STORED_IDENTITY');
    return {
      state: await geographyStore.state(scope),
      objects: objects.map((r) => r.payload),
      routes: relations
        .filter((r) => r.kind === 'route')
        .map((r) => {
          const route = r.payload as Route;
          if (route.id !== r.id) throw new Error('GEOGRAPHY_STORED_IDENTITY');
          return route;
        }),
      aliases: relations.filter((r) => r.kind === 'alias').map((r) => GeographyAliasSchema.parse(r.payload)),
    };
  },
  async run(scope, id) {
    const { tx, u, e } = owner(scope);
    const r = (
      await sql<{
        id: string;
        desired_revision: number;
        status: GeographyRun['status'];
        claim_id: string | null;
        claim_until: Date | null;
        context: GeographyContext | null;
        proposal: unknown;
        attempt_id: string | null;
        outcome: string | null;
      }>`select * from geography.runs where universe_id=${u}::uuid and privacy_epoch=${e} and id=${id}::uuid`.execute(
        tx,
      )
    ).rows[0];
    return r
      ? {
          id: r.id,
          desiredRevision: r.desired_revision,
          status: r.status,
          ...(r.claim_id && r.claim_until ? { claimId: r.claim_id, claimUntil: r.claim_until.toISOString() } : {}),
          ...(r.context ? { context: r.context } : {}),
          ...(r.proposal ? { proposal: GeographyProposalSchema.parse(r.proposal) } : {}),
          ...(r.attempt_id ? { attemptId: r.attempt_id } : {}),
          ...(r.outcome ? { outcome: r.outcome } : {}),
        }
      : undefined;
  },
  async writeRun(scope, r) {
    const { tx, u, e } = owner(scope);
    await sql`insert into geography.runs(universe_id,privacy_epoch,id,desired_revision,status,claim_id,claim_until,context,proposal,attempt_id,outcome)
 values(${u}::uuid,${e},${r.id}::uuid,${r.desiredRevision},${r.status},${r.claimId ?? null}::uuid,${r.claimUntil ?? null}::timestamptz,${r.context ? JSON.stringify(r.context) : null}::jsonb,${r.proposal ? JSON.stringify(r.proposal) : null}::jsonb,${r.attemptId ?? null}::uuid,${r.outcome ?? null})
 on conflict(universe_id,id) do update set desired_revision=excluded.desired_revision,status=excluded.status,claim_id=excluded.claim_id,claim_until=excluded.claim_until,context=excluded.context,proposal=excluded.proposal,attempt_id=excluded.attempt_id,outcome=excluded.outcome,updated_at=now()`.execute(
      tx,
    );
  },
  async findDelta(scope, id) {
    const { tx, u, e } = owner(scope);
    const r = (
      await sql<{
        input_sha256: string;
        payload: unknown;
      }>`select input_sha256,payload from geography.deltas where universe_id=${u}::uuid and privacy_epoch=${e} and transition_id=${id}::uuid`.execute(
        tx,
      )
    ).rows[0];
    return r ? { hash: r.input_sha256, delta: UniverseDeltaSchema.parse(r.payload) } : undefined;
  },
  async deltas(scope, after, limit) {
    const { tx, u, e } = owner(scope);
    const rows = (
      await sql<{
        payload: unknown;
      }>`select payload from geography.deltas where universe_id=${u}::uuid and privacy_epoch=${e} and revision>${after} order by revision limit ${limit}`.execute(
        tx,
      )
    ).rows;
    return rows.map((r) => UniverseDeltaSchema.parse(r.payload));
  },
  async saveObject(scope, o, refs) {
    const { tx, u, e } = owner(scope);
    await sql`insert into geography.objects(universe_id,privacy_epoch,id,semantic_key,payload,support_refs) values(${u}::uuid,${e},${o.id}::uuid,${o.key},${JSON.stringify(o)}::jsonb,${JSON.stringify(refs)}::jsonb)
 on conflict(universe_id,id) do update set payload=excluded.payload,support_refs=excluded.support_refs`.execute(tx);
  },
  async saveRoute(scope, r, refs) {
    const { tx, u, e } = owner(scope);
    const key = [r.fromKey, r.toKey].sort().join('|');
    await sql`insert into geography.relations(universe_id,privacy_epoch,id,semantic_key,kind,payload,support_refs) values(${u}::uuid,${e},${r.id}::uuid,${key},'route',${JSON.stringify(r)}::jsonb,${JSON.stringify(refs)}::jsonb)
 on conflict(universe_id,id) do update set payload=excluded.payload,support_refs=excluded.support_refs`.execute(tx);
  },
  async writeDelta(scope, runId, hash, d) {
    const { tx, u, e } = owner(scope);
    await sql`insert into geography.deltas(universe_id,privacy_epoch,revision,transition_id,run_id,policy_version,input_sha256,payload) values(${u}::uuid,${e},${d.geography.revision},${d.transitionId}::uuid,${runId}::uuid,'geography-passive.v1',${hash},${JSON.stringify(d)}::jsonb)`.execute(
      tx,
    );
  },
};
