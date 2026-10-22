import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { ReelDocumentSchema } from '@knowscroll/contracts';
import { cutroomTransactionOf } from '../../../infrastructure/postgres/cutroom-scope.js';
import { parseCommissionReviewPacket } from '../production/commission-review.js';
import type { CommissionPublicationStore } from '../production/commission-publication-ports.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

/** Content owns public asset/publication writes. Financial effects use the injected Reasoning
 * port in the SAME existing scope; no internal Reasoning mutation is hidden in this adapter. */
export function postgresCommissionPublication(
  options: { readonly fixture?: boolean } = {},
): CommissionPublicationStore {
  return {
    async load(scope, target) {
      const trx = cutroomTransactionOf(scope);
      if (!scope.enabled || scope.mode !== 'admit' || scope.authority.worldId !== target.worldId) return;
      if (options.fixture) {
        const name = (await sql<{ name: string }>`select current_database() name`.execute(trx)).rows[0]?.name;
        if (!name || !/^(ks_it_|knowscroll_fixture_)/.test(name)) return;
      }
      const r = (
        await sql<{
          generation: number;
          attempt_id: string;
          script_sha256: string;
          request_sha256: string;
          packet_utf8: string;
          publication_id: string | null;
          snapshot_sha256: string | null;
          asset_id: string | null;
        }>`select c.generation,c.attempt_id,c.script_sha256,c.request_sha256,r.packet_utf8,
        p.id publication_id,p.snapshot_sha256,p.asset_id
        from content.reel_commissions c join content.cutroom_reviews r using(world_id,business_run_id)
        left join content.cutroom_publications p using(world_id,business_run_id)
        where c.world_id=${target.worldId} and c.business_run_id=${target.businessRunId}::uuid
          and c.attempt_id=${target.attemptId}::uuid and r.revoked_at is null for update of c`.execute(trx)
      ).rows[0];
      if (!r || r.generation !== scope.authority.generation) return;
      const packet = parseCommissionReviewPacket(JSON.parse(r.packet_utf8));
      if (
        !packet ||
        packet.worldId !== target.worldId ||
        packet.businessRunId !== target.businessRunId ||
        packet.generation !== r.generation ||
        packet.scriptSha256 !== r.script_sha256 ||
        packet.requestSha256 !== r.request_sha256
      )
        return;
      if (r.publication_id && (!r.snapshot_sha256 || !r.asset_id)) throw new Error('CUTROOM_PUBLICATION_INCOMPLETE');
      return {
        packet,
        ...(r.publication_id
          ? {
              publication: {
                publicationId: r.publication_id,
                snapshotSha256: r.snapshot_sha256!,
                assetId: r.asset_id!,
              },
            }
          : {}),
      };
    },
    async insert(scope, target, packet, snapshot, media) {
      const trx = cutroomTransactionOf(scope),
        assetId = target.businessRunId,
        publicationId = randomUUID();
      if (
        scope.authority.worldId !== target.worldId ||
        scope.authority.generation !== packet.generation ||
        !scope.enabled ||
        scope.mode !== 'admit'
      )
        throw new Error('CUTROOM_PUBLICATION_AUTHORITY');
      if (snapshot.report.video.kind !== 'candidate' || snapshot.report.cost.overCeiling)
        throw new Error('CUTROOM_PUBLICATION_HELD');
      const tipSha = snapshot.report.video.runSha256;
      const finalRun = snapshot.header.runs.find((r) => hash(JSON.stringify(r.runId)) === tipSha)?.runId;
      if (!finalRun) throw new Error('CUTROOM_PUBLICATION_RUN_IDENTITY');
      const title = `${options.fixture ? '[Fixture] ' : ''}${packet.script.title}`;
      const document = ReelDocumentSchema.parse({
        schemaVersion: 'reel-document.v1',
        assetId,
        revision: 1,
        title,
        summary: packet.script.narration[0]!.text,
        language: 'en',
        truthLabel: 'generated',
        fixture: options.fixture === true,
        captions: 'burned_in',
        mediaKey: media.key,
        durationMs: media.probe.durationMs,
        width: media.probe.width,
        height: media.probe.height,
      });
      const publication = {
        version: 'cutroom-publication.v1',
        worldId: target.worldId,
        businessRunId: target.businessRunId,
        attemptId: target.attemptId,
        snapshotId: snapshot.snapshotId,
        snapshotSha256: snapshot.snapshotSha256,
        scriptSha256: packet.scriptSha256,
        requestSha256: packet.requestSha256,
        reviewSha256: packet.reviewSha256,
        corpusSha256: packet.corpusSnapshotSha256,
        humanEvidenceRef: snapshot.header.execution.humanEvidenceRef,
        finalRunId: finalRun,
        mediaSha256: media.sha256,
        mediaBytes: media.size,
        actualCents: snapshot.report.cost.actualCents,
        labels: snapshot.report.video.labels,
        attestation: snapshot.report.attestation,
      };
      const utf8 = JSON.stringify(publication);
      if (Buffer.byteLength(utf8) > 16384) throw new Error('CUTROOM_PUBLICATION_BOUNDS');
      await sql`select pg_advisory_xact_lock(hashtextextended(${`content.asset:${assetId}`},0))`.execute(trx);
      if (await trx.selectFrom('content.assets').select('id').where('id', '=', assetId).executeTakeFirst())
        throw new Error('CUTROOM_PUBLICATION_ASSET_EXISTS');
      const inserted = (
        await sql<{ id: string }>`insert into content.media_objects(id,logical_key,backend,sha256,size_bytes,mime,probe)
        values(${randomUUID()}::uuid,${media.key},'local',${media.sha256},${media.size},'video/mp4',${JSON.stringify(media.probe)}::jsonb)
        on conflict(sha256) do nothing returning id`.execute(trx)
      ).rows[0];
      const known = (
        await sql<{
          id: string;
          logical_key: string;
          size_bytes: string;
          mime: string;
          backend: string;
        }>`select id,logical_key,size_bytes::text,mime,backend from content.media_objects where sha256=${media.sha256}`.execute(
          trx,
        )
      ).rows[0];
      if (
        !known ||
        known.logical_key !== media.key ||
        Number(known.size_bytes) !== media.size ||
        known.mime !== 'video/mp4' ||
        known.backend !== 'local'
      )
        throw new Error('CUTROOM_PUBLICATION_MEDIA_CONFLICT');
      const mediaId = inserted?.id ?? known.id;
      await trx
        .insertInto('content.assets')
        .values({ id: assetId, revision: 1, kind: 'reel', status: 'admitted' })
        .execute();
      await trx
        .insertInto('content.asset_revisions')
        .values({
          asset_id: assetId,
          revision: 1,
          provenance_kind: 'cutroom_import',
          document_version: 'reel-document.v1',
          document: JSON.stringify(document),
          document_sha256: hash(JSON.stringify(document)),
          explanation_unit_id: `cutroom:${packet.scriptSha256.slice(0, 32)}`,
          language: 'en',
          title,
          reading_facts: JSON.stringify({
            v: 2,
            measuresVersion: 'reel-duration.v1',
            totalWeight: 0,
            estimatedReadingMs: media.probe.durationMs,
            blocks: [],
            nested: [],
            reelDurationMs: media.probe.durationMs,
          }),
        })
        .execute();
      // The owning0016 trigger derives discovery metadata once; no duplicate direct insert.
      await trx
        .insertInto('content.asset_provenance')
        .values({
          asset_id: assetId,
          revision: 1,
          provenance_version: 'reel-provenance.v1',
          provenance: JSON.stringify({
            schemaVersion: 'reel-provenance.v1',
            kind: 'cutroom_import',
            ...publication,
            probe: media.probe,
            fixture: options.fixture === true,
          }),
        })
        .execute();
      await sql`insert into content.cutroom_publications(id,world_id,business_run_id,attempt_id,snapshot_id,snapshot_sha256,asset_id,asset_revision,media_id,final_run_id,publication_utf8,publication_sha256)
        values(${publicationId}::uuid,${target.worldId},${target.businessRunId}::uuid,${target.attemptId}::uuid,${snapshot.snapshotId}::uuid,${snapshot.snapshotSha256},
          ${assetId}::uuid,1,${mediaId}::uuid,${finalRun},${utf8},${hash(utf8)})`.execute(trx);
      // Existing immutable cutroom_reviews already inventories this v2 script across statuses;
      // duplicating it into legacy cutroom_corpus would make its own recheck a false repetition.
      return { publicationId, assetId };
    },
  };
}
