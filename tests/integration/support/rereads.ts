import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import type { TestDatabase } from './database.js';
import type { FixturePerson } from './fixtures.js';

/**
 * Gives a reader `count` older re-reads of a Scroll they have really read: one legacy certificate and
 * the references to its support keys per re-read, each with its own exposure, activity and a valid
 * digest, and each activated a second before the one before it. The support counts move with them,
 * as they would for real re-reads.
 *
 * These are projection rows, not evidence: no Evidence qualification stands behind them, so a trusted
 * read must never prove a key by one of them (the real, newest exposure does). They exist so a test
 * can hold more than a thousand raw references on one key without reading a thousand Scrolls.
 */
export async function seedOlderRereads(
  database: Pick<TestDatabase<Database>, 'db'>,
  person: FixturePerson,
  exposureId: string,
  count: number,
): Promise<void> {
  const { db } = database;
  const head = await db
    .selectFrom('personal_context.recording_segment_heads')
    .select(['coverage', 'activity_id'])
    .where('universe_id', '=', person.universeId)
    .where('exposure_id', '=', exposureId)
    .where('recording_generation', '=', 1)
    .executeTakeFirstOrThrow();
  const certificate = head.coverage as { activatedAt: string } & Record<string, unknown>;
  const rows = Array.from({ length: count }, (_, n) => {
    const exposure = randomUUID(),
      activity = randomUUID(),
      payload = {
        ...certificate,
        exposureId: exposure,
        activatedAt: new Date(Date.parse(certificate.activatedAt) - (n + 1) * 1000).toISOString(),
      };
    return { exposure, activity, payload, digest: canonicalSha256({ activityId: activity, certificate: payload }) };
  });
  const u = person.universeId;
  await sql`with seed as (select * from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as s(exposure uuid,activity uuid,payload jsonb,digest text)),
    exposures as (insert into experience.exposures select (jsonb_populate_record(null::experience.exposures,to_jsonb(base)||jsonb_build_object('id',seed.exposure,'command_id',gen_random_uuid()))).* from experience.exposures base cross join seed where base.universe_id=${u}::uuid and base.id=${exposureId}::uuid returning id),
    activities as (insert into evidence.activity_revisions select (jsonb_populate_record(null::evidence.activity_revisions,to_jsonb(base)||jsonb_build_object('id',seed.activity,'exposure_id',seed.exposure))).* from evidence.activity_revisions base cross join seed join exposures on exposures.id=seed.exposure where base.universe_id=${u}::uuid and base.id=${head.activity_id}::uuid returning exposure_id,id),
    certificates as (insert into personal_context.coverage_contributions(universe_id,privacy_epoch,exposure_id,activity_id,input_sha256,payload) select ${u}::uuid,1,seed.exposure,seed.activity,seed.digest,seed.payload from seed join activities on activities.id=seed.activity returning exposure_id)
    insert into personal_context.coverage_references(universe_id,privacy_epoch,exposure_id,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256) select base.universe_id,base.privacy_epoch,certificates.exposure_id,base.topic_id,base.facet_id,base.meaning_sha256,base.explanation_unit_id,base.truth_sha256 from personal_context.recording_coverage_references base cross join certificates where base.universe_id=${u}::uuid and base.exposure_id=${exposureId}::uuid`.execute(
    db,
  );
  await sql`update personal_context.coverage_supports s set reference_count = s.reference_count + ${count}
    where s.universe_id=${u}::uuid and (s.topic_id,s.facet_id,s.meaning_sha256,s.explanation_unit_id,s.truth_sha256) in
    (select topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256 from personal_context.recording_coverage_references where universe_id=${u}::uuid and exposure_id=${exposureId}::uuid)`.execute(
    db,
  );
}
