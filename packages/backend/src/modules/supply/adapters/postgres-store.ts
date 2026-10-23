import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { requestHash } from '../../../infrastructure/receipts/index.js';
import type { Demand, SupplyStore } from '../application/ports.js';

/** Scope predicates are mandatory even for opaque IDs; private commands never enter shared work. */
export const supplyStore: SupplyStore = {
  async read(scope, id) {
    const r = await transactionOf(scope)
      .selectFrom('supply.requests')
      .selectAll()
      .where('universe_id', '=', scope.authority.universeId)
      .where('privacy_epoch', '=', scope.authority.privacyEpoch)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) return undefined;
    return {
      id: r.id,
      command: r.command as unknown as Demand['command'],
      status: r.state as Demand['status'],
      ...(r.planner_run_id !== null && r.planner_slot !== null
        ? { planned: { runId: r.planner_run_id, slot: r.planner_slot } }
        : {}),
      requestRevision: r.request_revision,
      revision: r.revision,
      decision: r.decision as Demand['decision'],
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      ...(r.brief ? { brief: r.brief as unknown as Demand['brief'] } : {}),
      ...(r.work_id ? { workId: r.work_id } : {}),
      ...(r.reason ? { reason: r.reason as Demand['reason'] } : {}),
      ...(r.content ? { content: r.content as unknown as Demand['content'] } : {}),
      ...(r.content_availability_revision ? { contentAvailabilityRevision: r.content_availability_revision } : {}),
      ...(r.source_availability_revision ? { sourceAvailabilityRevision: r.source_availability_revision } : {}),
    };
  },
  async insert(scope, d) {
    await transactionOf(scope)
      .insertInto('supply.requests')
      .values({
        universe_id: scope.authority.universeId,
        privacy_epoch: scope.authority.privacyEpoch,
        id: d.id,
        command: JSON.stringify(d.command),
        state: d.status,
        origin: d.planned ? 'planner' : 'person',
        planner_run_id: d.planned?.runId ?? null,
        planner_slot: d.planned?.slot ?? null,
        request_revision: d.requestRevision,
        revision: d.revision,
        decision: d.decision,
        work_id: d.workId ?? null,
        brief: d.brief ? JSON.stringify(d.brief) : null,
        reason: d.reason ?? null,
        content: d.content ? JSON.stringify(d.content) : null,
        content_availability_revision: d.contentAvailabilityRevision ?? null,
        source_availability_revision: d.sourceAvailabilityRevision ?? null,
        created_at: new Date(d.createdAt),
        updated_at: new Date(d.updatedAt),
      })
      .execute();
  },
  async finish(scope, d) {
    const changed = await transactionOf(scope)
      .updateTable('supply.requests')
      .set({
        state: d.status,
        request_revision: d.requestRevision,
        revision: d.revision,
        reason: d.reason ?? null,
        content: d.content ? JSON.stringify(d.content) : null,
        content_availability_revision: d.contentAvailabilityRevision ?? null,
        source_availability_revision: d.sourceAvailabilityRevision ?? null,
        updated_at: new Date(d.updatedAt),
      })
      .where('universe_id', '=', scope.authority.universeId)
      .where('privacy_epoch', '=', scope.authority.privacyEpoch)
      .where('id', '=', d.id)
      .where('state', 'in', ['requested', 'deferred'])
      .executeTakeFirst();
    if (changed.numUpdatedRows !== 1n) throw new Error('SUPPLY_REQUEST_NOT_OPEN');
  },
  async joinOrCreate(scope, brief, id) {
    const key = requestHash('supply-public-canonical.v1', brief);
    const r = await sql<{
      id: string;
    }>`insert into supply.work(id,canonical_key,brief) values(${id}::uuid,${key},${JSON.stringify(brief)}::jsonb)
      on conflict(canonical_key) where active do update set canonical_key=excluded.canonical_key returning id`.execute(
      transactionOf(scope),
    );
    const actual = r.rows[0]!.id;
    return { id: actual, joined: actual !== id };
  },
  async findOpenPlanned(scope, brief) {
    const row = await transactionOf(scope)
      .selectFrom('supply.requests')
      .select(['id', 'state'])
      .where('universe_id', '=', scope.authority.universeId)
      .where('privacy_epoch', '=', scope.authority.privacyEpoch)
      .where('origin', '=', 'planner')
      .where('state', 'in', ['deferred', 'ready'])
      .where(sql<boolean>`brief = ${JSON.stringify(brief)}::jsonb`)
      .orderBy('created_at')
      .executeTakeFirst();
    return row ? { id: row.id, state: row.state as 'deferred' | 'ready' } : undefined;
  },
  async closeWork(scope, id) {
    await transactionOf(scope)
      .updateTable('supply.work')
      .set({ active: false, closed_at: new Date() })
      .where('id', '=', id)
      .where('active', '=', true)
      .execute();
  },
};
