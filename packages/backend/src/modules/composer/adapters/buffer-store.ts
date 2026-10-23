import { sql } from 'kysely';
import { z } from 'zod';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PreparedBuffer } from '../domain/buffer.js';
import type { ReadComposerBuffer, ReleaseComposerBuffer, StoreComposerBuffer } from '../application/ports.js';

const MODE = 'vertical';

const SelectionSchema = z
  .array(
    z.strictObject({
      assetId: z.string().min(1),
      assetRevision: z.number().int().min(1),
      catalogWatermark: z.string(),
    }),
  )
  .min(1)
  .max(3);
const AssessmentsSchema = z.strictObject({
  roleVersion: z.string(),
  model: z.string(),
  assessedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  entries: z.array(
    z.strictObject({
      assetId: z.string(),
      assetRevision: z.number().int().min(1),
      relevance: z.number().min(0).max(1),
      appropriateness: z.number().min(0).max(1),
      redundancy: z.number().min(0).max(1),
    }),
  ),
});

interface BufferRow {
  readonly session_id: string;
  readonly intent_revision: number;
  readonly source_offer_id: string;
  readonly source_exposure_id: string;
  readonly decision_id: string;
  readonly selection: unknown;
  readonly assessments: unknown;
  readonly prepared_at: Date;
  readonly expires_at: Date;
}

/** The stored buffer for exactly this session, revision and source offer; any other row is not this key's. */
const readComposerBuffer: ReadComposerBuffer = async (scope, key) => {
  const { universeId, privacyEpoch } = scope.authority;
  const rows =
    await sql<BufferRow>`select session_id,intent_revision,source_offer_id,source_exposure_id,decision_id,selection,assessments,prepared_at,expires_at
    from composer.buffers
    where universe_id=${universeId}::uuid and mode=${MODE} and privacy_epoch=${privacyEpoch}
      and session_id=${key.sessionId}::uuid and intent_revision=${key.intentRevision}
      and source_offer_id=${key.source.offerId}::uuid and source_exposure_id=${key.source.exposureId}::uuid`.execute(
      transactionOf(scope),
    );
  const row = rows.rows[0];
  if (!row) return undefined;
  const buffer: PreparedBuffer = {
    sessionId: row.session_id,
    intentRevision: row.intent_revision,
    source: { offerId: row.source_offer_id, exposureId: row.source_exposure_id },
    decisionId: row.decision_id,
    selection: SelectionSchema.parse(row.selection),
    preparedAt: new Date(row.prepared_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    ...(row.assessments === null ? {} : { assessments: AssessmentsSchema.parse(row.assessments) }),
  };
  return buffer;
};

/** Replaces the person's vertical buffer. The previous one was never served, so its decision goes too. */
const storeComposerBuffer: StoreComposerBuffer = async (scope, buffer) => {
  const { universeId, privacyEpoch } = scope.authority;
  const db = transactionOf(scope);
  const previous = await sql<{
    decision_id: string;
  }>`delete from composer.buffers where universe_id=${universeId}::uuid and mode=${MODE} returning decision_id`.execute(
    db,
  );
  for (const row of previous.rows)
    await sql`delete from composer.decisions where universe_id=${universeId}::uuid and id=${row.decision_id}::uuid`.execute(
      db,
    );
  await sql`insert into composer.buffers(universe_id,mode,privacy_epoch,session_id,intent_revision,source_offer_id,source_exposure_id,decision_id,selection,assessments,prepared_at,expires_at)
    values(${universeId}::uuid,${MODE},${privacyEpoch},${buffer.key.sessionId}::uuid,${buffer.key.intentRevision},${buffer.key.source.offerId}::uuid,${buffer.key.source.exposureId}::uuid,${buffer.decisionId}::uuid,${JSON.stringify(buffer.selection)}::jsonb,${buffer.assessments ? JSON.stringify(buffer.assessments) : null}::jsonb,${buffer.preparedAt.toISOString()}::timestamptz,${buffer.expiresAt.toISOString()}::timestamptz)`.execute(
    db,
  );
};

const releaseComposerBuffer: ReleaseComposerBuffer = async (scope, decisionId, how) => {
  const { universeId } = scope.authority;
  const db = transactionOf(scope);
  await sql`delete from composer.buffers where universe_id=${universeId}::uuid and mode=${MODE} and decision_id=${decisionId}::uuid`.execute(
    db,
  );
  if (how === 'discarded')
    await sql`delete from composer.decisions where universe_id=${universeId}::uuid and id=${decisionId}::uuid`.execute(
      db,
    );
};

/** The `composer.buffers` store. The API reads and releases; the worker stores; tests may seed. */
export const composerBufferStore = {
  read: readComposerBuffer,
  store: storeComposerBuffer,
  release: releaseComposerBuffer,
} as const;
