import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import { localMediaStore } from '../../../infrastructure/media-store/index.js';
import greenhouse from '../approved/greenhouse.json' with { type: 'json' };
import seasons from '../approved/seasons-v5.json' with { type: 'json' };
import tides from '../approved/tides-v4.json' with { type: 'json' };
import { cutroomReadClient } from './cutroom/read-client.js';
import { validateEngineRecord } from './cutroom/validate-record.js';
import { probeReel } from './cutroom/probe.js';

const approved = { greenhouse, 'seasons-v5': seasons, 'tides-v4': tides };
export interface CutroomImportSettings {
  readonly world: string;
  readonly mediaRoot: string;
  readonly cutroomOrigin: string;
  readonly cutroomArtifactRoot: string;
  readonly ffprobePath?: string;
}
/** Worker-only composition. No external wait, copy or probe runs in a DB transaction. */
export function makeCutroomReelImporter(db: Kysely<Database>, settings: CutroomImportSettings) {
  return async (command: { runId: string; script: string; fixture?: boolean }) => {
    if (!['dev', 'stage', 'ci', 'local'].includes(settings.world)) return { kind: 'refused', reason: 'world' } as const;
    if (command.fixture && !['ci', 'local'].includes(settings.world))
      return { kind: 'refused', reason: 'fixture_world' } as const;
    if (command.fixture) {
      const database = await sql<{ name: string }>`select current_database() as name`.execute(db);
      if (!/^(ks_it_|knowscroll_fixture_)/.test(database.rows[0]?.name ?? ''))
        return { kind: 'refused', reason: 'fixture_database' } as const;
    }
    if (!Object.hasOwn(approved, command.script)) return { kind: 'refused', reason: 'script' } as const;
    const source = approved[command.script as keyof typeof approved];
    if (command.runId !== source.approvedRunId) return { kind: 'refused', reason: 'run' } as const;
    const previous = await sql<{
      asset_id: string;
    }>`select asset_id from content.reel_imports where run_id = ${command.runId}::uuid`.execute(db);
    if (previous.rows[0]) return { kind: 'unchanged', assetId: previous.rows[0].asset_id } as const;
    const engine = cutroomReadClient({ origin: settings.cutroomOrigin, artifactRoot: settings.cutroomArtifactRoot });
    if (!(await engine.ready()).ready) return { kind: 'refused', reason: 'engine_not_ready' } as const;
    const status = await engine.status(command.runId);
    const result = await engine.result(command.runId);
    const record = await engine.record(command.runId);
    if (
      status.runId !== command.runId ||
      result.runId !== command.runId ||
      record.runId !== command.runId ||
      !validateEngineRecord(status, result, record)
    )
      return { kind: 'refused', reason: 'record' } as const;
    const file = await engine.openArtifact(result.video.path, command.runId);
    const staged = await localMediaStore(settings.mediaRoot).stage(file.stream);
    try {
      if (
        (!command.fixture &&
          (staged.sha256 !== source.approvedMediaSha256 || staged.size !== source.approvedMediaBytes)) ||
        file.size !== staged.size
      )
        return { kind: 'refused', reason: 'file_changed' } as const;
      const probe = await probeReel(staged.path, settings.ffprobePath);
      const media = await staged.commit();
      const assetId = source.id;
      const title = `${command.fixture ? '[Fixture] ' : ''}${source.brief.title}`;
      const document = {
        schemaVersion: 'reel-document.v1',
        assetId,
        revision: 1,
        title,
        summary: source.brief.summary,
        language: 'en',
        truthLabel: 'generated',
        fixture: command.fixture === true,
        captions: 'burned_in',
        mediaKey: media.key,
        durationMs: probe.durationMs,
        width: probe.width,
        height: probe.height,
      };
      const documentSha256 = createHash('sha256').update(JSON.stringify(document)).digest('hex');
      const provenance = {
        schemaVersion: 'reel-provenance.v1',
        kind: 'cutroom_import',
        script: command.script,
        sourceRevision: 'legacy/v1-final',
        sourceSha256: createHash('sha256').update(JSON.stringify(source)).digest('hex'),
        approval: source.approval,
        brief: source.brief,
        runId: command.runId,
        requestId: result.requestId,
        contractRevision: '94ee04a1c48069c293203de326d4801360ca6158',
        witness: { label: 'engine-attested, not independent', record },
        reportedCostCents: result.costCents,
        mediaSha256: media.sha256,
        probe,
        fixture: command.fixture === true,
      };
      return await withTransaction(db, 'content.admission', async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${`content.asset:${assetId}`}, 0))`.execute(trx);
        const existing = await sql<{
          asset_id: string;
        }>`select asset_id from content.reel_imports where run_id = ${command.runId}::uuid`.execute(trx);
        if (existing.rows[0]) return { kind: 'unchanged', assetId: existing.rows[0].asset_id } as const;
        const asset = await trx.selectFrom('content.assets').select('id').where('id', '=', assetId).executeTakeFirst();
        if (asset) return { kind: 'refused', reason: 'asset_exists' } as const;
        const insertedMedia = await sql<{
          id: string;
        }>`insert into content.media_objects (id, logical_key, backend, sha256, size_bytes, mime, probe)
          values (${randomUUID()}::uuid, ${media.key}, 'local', ${media.sha256}, ${media.size}, 'video/mp4', ${JSON.stringify(probe)}::jsonb)
          on conflict (sha256) do nothing returning id`.execute(trx);
        const existingMedia =
          insertedMedia.rows[0] ??
          (await sql<{ id: string }>`select id from content.media_objects where sha256 = ${media.sha256}`.execute(trx))
            .rows[0];
        const mediaId = existingMedia?.id;
        if (!mediaId) throw new Error('media_insert_failed');
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
            document_sha256: documentSha256,
            explanation_unit_id: `legacy-cutroom-${command.script}`,
            language: 'en',
            title,
            reading_facts: JSON.stringify({
              v: 2,
              measuresVersion: 'reel-duration.v1',
              totalWeight: 0,
              estimatedReadingMs: probe.durationMs,
              blocks: [],
              nested: [],
              reelDurationMs: probe.durationMs,
            }),
          })
          .execute();
        await trx
          .insertInto('content.asset_provenance')
          .values({
            asset_id: assetId,
            revision: 1,
            provenance_version: 'reel-provenance.v1',
            provenance: JSON.stringify(provenance),
          })
          .execute();
        await sql`insert into content.reel_imports (run_id, asset_id, asset_revision, media_id, script_name, fixture)
          values (${command.runId}::uuid, ${assetId}::uuid, 1, ${mediaId}::uuid, ${command.script}, ${command.fixture === true})`.execute(
          trx,
        );
        return { kind: 'created', assetId, revision: 1, sha256: media.sha256, size: media.size } as const;
      });
    } finally {
      await staged.discard();
    }
  };
}
