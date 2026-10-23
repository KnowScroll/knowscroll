import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { cutroomAccountingTransactionOf } from '../../../infrastructure/postgres/cutroom-scope.js';
import type { CutroomAccountingScopeTx } from '../../../reasoning/public.js';
import type { CommissionChainStore, SealedChainSnapshot } from '../production/commission-chain-store-ports.js';
/** Only explicit bounded Content fields, never a request body or Reasoning table query. */
async function businessMatches(scope: CutroomAccountingScopeTx) {
  const row = await cutroomAccountingTransactionOf(scope)
    .selectFrom('content.reel_commissions')
    .select([
      'attempt_id',
      'request_sha256',
      'script_sha256',
      'take',
      'ceiling_cents',
      sql<string | null>`case when octet_length(request_id)<=128 then request_id else null end`.as('request_id'),
    ])
    .where('world_id', '=', scope.worldId)
    .where('business_run_id', '=', scope.businessRunId)
    .executeTakeFirst();
  const i = scope.identity;
  return (
    row?.attempt_id === scope.attemptId &&
    row.request_id === i.requestId &&
    row.request_sha256 === i.requestSha256 &&
    row.script_sha256 === i.scriptSha256 &&
    row.take === i.take &&
    row.ceiling_cents === i.ceilingCents
  );
}
/** Immutable evidence adapter. Scope factory already owns root -> business -> attempt locks. */
export function postgresCommissionChainStore(): CommissionChainStore {
  return {
    async inspect(scope, snapshot) {
      const trx = cutroomAccountingTransactionOf(scope);
      if (!(await businessMatches(scope))) return { kind: 'refused', code: 'identity' };
      const rows = await trx
        .selectFrom('content.cutroom_chain_snapshots')
        .select(['id', 'observation_id', 'snapshot_ordinal', 'snapshot_sha256', 'projection_version'])
        .where('attempt_id', '=', scope.attemptId)
        .orderBy('snapshot_ordinal')
        .limit(33)
        .execute();
      if (
        rows.length > 32 ||
        rows.some(
          (r, index) => r.snapshot_ordinal !== index + 1 || r.projection_version !== 'cutroom-chain-snapshot.v1',
        )
      )
        return { kind: 'refused', code: 'corrupt' };
      const old = rows.find((r) => r.snapshot_sha256 === snapshot.snapshotSha256);
      if (old) {
        // A matching digest alone does not prove the stored projections correspond to its header.
        // Compare one bounded row against the snapshot already validated before this transaction.
        const stored = await trx
          .selectFrom('content.cutroom_chain_snapshots')
          .select([
            'header_utf8',
            'document_count',
            'total_document_bytes',
            'sealed_validation_time_ms',
            'engine_actual_cents',
            'over_ceiling',
            'video_kind',
          ])
          .where('id', '=', old.id)
          .executeTakeFirst();
        if (
          !stored ||
          stored.header_utf8 !== snapshot.headerUtf8 ||
          stored.document_count !== snapshot.documents.length ||
          stored.total_document_bytes !== snapshot.documents.reduce((sum, d) => sum + d.byteLength, 0) ||
          stored.sealed_validation_time_ms !== String(snapshot.header.collection.observedAtMs) ||
          stored.engine_actual_cents !== String(snapshot.header.summary.actualCents) ||
          stored.over_ceiling !== snapshot.header.summary.overCeiling ||
          stored.video_kind !== snapshot.header.summary.videoKind
        )
          return { kind: 'refused', code: 'corrupt' };
        const docs = await trx
          .selectFrom('content.cutroom_chain_documents')
          .select(['run_ordinal', 'kind', 'byte_length', 'sha256'])
          .where('snapshot_id', '=', old.id)
          .limit(9)
          .execute();
        if (
          docs.length !== snapshot.documents.length ||
          snapshot.documents.some(
            (d) =>
              !docs.some(
                (r) =>
                  r.run_ordinal === d.runOrdinal &&
                  r.kind === d.kind &&
                  r.byte_length === d.byteLength &&
                  r.sha256 === d.sha256,
              ),
          )
        )
          return { kind: 'refused', code: 'corrupt' };
        return { kind: 'replayed', snapshotId: old.id, observationId: old.observation_id };
      }
      return rows.length === 32
        ? { kind: 'refused', code: 'capacity' }
        : { kind: 'available', ordinal: rows.length + 1 };
    },
    async insert(scope, snapshot, ordinal, observationId) {
      const trx = cutroomAccountingTransactionOf(scope),
        snapshotId = randomUUID();
      const header = snapshot.header;
      await trx
        .insertInto('content.cutroom_chain_snapshots')
        .values({
          id: snapshotId,
          world_id: scope.worldId,
          business_run_id: scope.businessRunId,
          attempt_id: scope.attemptId,
          observation_id: observationId,
          snapshot_ordinal: ordinal,
          projection_version: header.version,
          header_utf8: snapshot.headerUtf8,
          snapshot_sha256: snapshot.snapshotSha256,
          document_count: snapshot.documents.length,
          total_document_bytes: snapshot.documents.reduce((sum, d) => sum + d.byteLength, 0),
          sealed_validation_time_ms: String(header.collection.observedAtMs),
          engine_actual_cents: String(header.summary.actualCents),
          over_ceiling: header.summary.overCeiling,
          video_kind: header.summary.videoKind,
        })
        .execute();
      for (const d of snapshot.documents)
        await trx
          .insertInto('content.cutroom_chain_documents')
          .values({
            snapshot_id: snapshotId,
            run_ordinal: d.runOrdinal,
            kind: d.kind,
            body_utf8: d.bodyUtf8,
            byte_length: d.byteLength,
            sha256: d.sha256,
          })
          .execute();
      return snapshotId;
    },
    async read(scope, selector) {
      const trx = cutroomAccountingTransactionOf(scope);
      if (!(await businessMatches(scope))) return;
      let query = trx
        .selectFrom('content.cutroom_chain_snapshots')
        .select([
          'id',
          'observation_id',
          'snapshot_ordinal',
          'projection_version',
          'header_utf8',
          'snapshot_sha256',
          'document_count',
          'total_document_bytes',
          'sealed_validation_time_ms',
          'engine_actual_cents',
          'over_ceiling',
          'video_kind',
        ])
        .where('world_id', '=', scope.worldId)
        .where('business_run_id', '=', scope.businessRunId)
        .where('attempt_id', '=', scope.attemptId);
      query =
        'observationId' in selector
          ? query.where('observation_id', '=', selector.observationId)
          : query.where('id', '=', selector.snapshotId).where('snapshot_sha256', '=', selector.snapshotSha256);
      const row = await query.executeTakeFirst();
      if (!row || row.projection_version !== 'cutroom-chain-snapshot.v1') return;
      const documents = await trx
        .selectFrom('content.cutroom_chain_documents')
        .select(['run_ordinal', 'kind', 'body_utf8', 'byte_length', 'sha256'])
        .where('snapshot_id', '=', row.id)
        .orderBy('run_ordinal')
        .orderBy('kind')
        .limit(9)
        .execute();
      return {
        snapshotId: row.id,
        observationId: row.observation_id,
        ordinal: row.snapshot_ordinal,
        headerUtf8: row.header_utf8,
        snapshotSha256: row.snapshot_sha256,
        documentCount: row.document_count,
        totalDocumentBytes: row.total_document_bytes,
        validationTimeMs: row.sealed_validation_time_ms,
        actualCents: row.engine_actual_cents,
        overCeiling: row.over_ceiling,
        videoKind: row.video_kind,
        documents: documents.map((d) => ({
          runOrdinal: d.run_ordinal,
          kind: d.kind as SealedChainSnapshot['documents'][number]['kind'],
          bodyUtf8: d.body_utf8,
          byteLength: d.byte_length,
          sha256: d.sha256,
        })),
      };
    },
  };
}
