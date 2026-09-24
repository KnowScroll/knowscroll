/**
 * TEST SETUP, not a provider outcome: one Reel minted over a given library Scroll, through the
 * supply chain's own guards (migrations 0013–0015) rather than around them. The lineage is
 * synthetic: a stand-in engine, a settled attempt with a completed video, recorded gate verdicts
 * (the Visual Witness gate `unavailable`), `test_eligible` (which the database accepts only inside a
 * disposable `knowscroll_test_*` database), then the product's own `mintReelAsset`. No network and
 * no media bytes: a caller that plays the Reel writes them at `storageKey` itself.
 */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { generationBrief } from '../../packages/contracts/src/generation.ts';
import { CUTROOM_CONTRACT_REVISION as REVISION } from '../../apps/worker/src/generation/storage.ts';
import { mintReelAsset } from '../../apps/worker/src/publication/mint.ts';
import { insertFakeEngine } from '../../tests/helpers/generation-fixture.ts';

const REQUIRED_GATES = ['lineage_complete', 'source_support', 'engine_record', 'media_conformance', 'truth_label', 'repetition', 'witness_alignment'];

export interface GatedReelMedia { sha256: string; byteSize: number; probe: { durationSeconds: number; width: number; height: number } }

export interface GatedReelOptions {
  tag: string;
  title: string;
  summary: string;
  /** Real bytes' identity and probe; omitted, each Reel gets its own synthetic 9:16 media row. */
  media?: GatedReelMedia;
  /** The stand-in engine's declared artifact root; engine paths are provenance only. */
  artifactRoot?: string;
}

export interface GatedReel { assetId: string; generatedReelId: string; mediaSha256: string; storageKey: string; sourceAssetId: string }

const sentence = (text: string, claimIds: string[]) => ({ text, claimIds });

export async function mintGatedTestReel(pool: pg.Pool, sourceAssetId: string, options: GatedReelOptions): Promise<GatedReel> {
  const { tag } = options;
  const artifactRoot = options.artifactRoot ?? '/tmp/gated-reel-fixtures';
  const source = (await pool.query<{ revision: number }>(`SELECT revision FROM asset WHERE id=$1 AND kind='Scroll'`, [sourceAssetId])).rows[0];
  if (!source) throw new Error(`No library Scroll ${sourceAssetId} to mint a test Reel over`);

  const briefJson = generationBrief.parse({
    version: 1,
    worldId: `gated-reel-${tag}`,
    narration: [
      sentence(`Sentence one ${tag}.`, ['c1']),
      sentence(`Sentence two ${tag}.`, ['c1']),
      sentence(`Sentence three ${tag}.`, ['c2']),
      sentence(`Sentence four ${tag}.`, ['c2']),
    ],
    claims: [{ id: 'c1', role: 'main' }, { id: 'c2', role: 'supporting' }],
    claimSources: [{ claimId: 'c1', assetId: sourceAssetId, assetRevision: source.revision }, { claimId: 'c2', assetId: sourceAssetId, assetRevision: source.revision }],
    criteria: { mustShow: [{ id: 'show-1', text: 'Something visible.', type: 'presence', claimId: 'c1' }], mustNotShow: [], depictionPolicyVersion: 'depiction-v1' },
    style: { id: 'library', version: 1, text: 'Quiet, documentary, no captions burned in.' },
    title: options.title,
    summary: options.summary,
  });
  const briefSha256 = createHash('sha256').update(JSON.stringify(briefJson)).digest('hex');
  const briefId = randomUUID();
  await pool.query(
    `INSERT INTO generation_brief(id,source_asset_id,source_asset_revision,truth_state,brief,brief_sha256,authored_by,review_state)
     VALUES($1,$2,$3,'synthesis',$4,$5,'test','approved')`,
    [briefId, sourceAssetId, source.revision, JSON.stringify(briefJson), briefSha256],
  );

  const engineId = randomUUID();
  await insertFakeEngine(pool, { id: engineId, artifactRoot, providerMode: 'standin' });
  const grantId = randomUUID();
  await pool.query(`INSERT INTO generation_budget_grant(id,mode,cap_cents,expires_at) VALUES($1,'standin',100000,now()+interval '30 days')`, [grantId]);
  await pool.query('UPDATE generation_budget_grant SET reserved_cents=reserved_cents+500 WHERE id=$1', [grantId]);

  const jobId = randomUUID();
  await pool.query(
    `INSERT INTO generation_job(id,brief_id,engine_id,grant_id,until,budget_cents,deadline_at)
     VALUES($1,$2,$3,$4,'video',500,now()+interval '1 hour')`,
    [jobId, briefId, engineId, grantId],
  );

  const attemptId = randomUUID();
  const requestBody = '{}';
  await pool.query(
    `INSERT INTO cutroom_attempt(id,job_id,ordinal,request_id,request_body,body_sha256,contract_revision)
     VALUES($1,$2,1,$3,$4,$5,$6)`,
    [attemptId, jobId, `ks-gen-${attemptId}`, requestBody, createHash('sha256').update(requestBody).digest('hex'), REVISION],
  );
  const runId = `run-${attemptId}`;
  const enginePath = `${artifactRoot}/${attemptId}.mp4`;
  await pool.query(`UPDATE cutroom_attempt SET state='dispatch_committed', dispatch_committed_at=now() WHERE id=$1`, [attemptId]);
  await pool.query(`UPDATE cutroom_attempt SET state='accepted', run_id=$2, accepted_at=now() WHERE id=$1`, [attemptId, runId]);
  await pool.query(
    `UPDATE cutroom_attempt SET state='finished', finished_at=now(), reported_cost_cents=0, settlement='settled',
       result=jsonb_build_object('status','completed','until','video','video',jsonb_build_object('path',$2::text)),
       record_summary=jsonb_build_object('contractVersion',1,'runId',$3::text,'pictures','[]'::jsonb,
         'takes',jsonb_build_array(jsonb_build_object('takeId','t1','shotId','s1','number',1,'used',true,'checks','[]'::jsonb)),
         'degradations','[]'::jsonb)
     WHERE id=$1`,
    [attemptId, enginePath, runId],
  );

  const media = options.media ?? {
    sha256: createHash('sha256').update(`${attemptId}-media`).digest('hex'), byteSize: 4096,
    probe: { durationSeconds: 7.25, width: 1080, height: 1920 },
  };
  const storageKey = `sha256/${media.sha256.slice(0, 2)}/${media.sha256.slice(2, 4)}/${media.sha256}.mp4`;
  await pool.query(
    `INSERT INTO media_object(sha256,byte_size,content_type,probe,storage_key) VALUES($1,$2,'video/mp4',$3,$4)`,
    [media.sha256, media.byteSize, JSON.stringify(media.probe), storageKey],
  );

  const generatedReelId = randomUUID();
  const lineage = { briefSha256, contractRevision: REVISION, runId, recordSummary: { takes: 1, used: 1 } };
  await pool.query(
    `INSERT INTO generated_reel(id,attempt_id,brief_id,engine_id,cutroom_run_id,media_sha256,engine_path,provider_mode,truth_state,generated_label,lineage)
     VALUES($1,$2,$3,$4,$5,$6,$7,'standin','synthesis',true,$8)`,
    [generatedReelId, attemptId, briefId, engineId, runId, media.sha256, enginePath, JSON.stringify(lineage)],
  );

  for (const gate of REQUIRED_GATES) {
    const verdict = gate === 'witness_alignment' ? 'unavailable' : 'pass';
    await pool.query(
      `INSERT INTO publication_gate_result(id,generated_reel_id,policy_version,gate,verdict,evidence) VALUES($1,$2,'publication-v1',$3,$4,$5)`,
      [randomUUID(), generatedReelId, gate, verdict, JSON.stringify(verdict === 'unavailable' ? { reason: 'test' } : {})],
    );
  }
  await pool.query(`UPDATE generated_reel SET availability='test_eligible', availability_policy_version='publication-v1', availability_decided_at=now() WHERE id=$1`, [generatedReelId]);

  const minted = await mintReelAsset(pool, generatedReelId);
  return { assetId: minted.assetId, generatedReelId, mediaSha256: media.sha256, storageKey, sourceAssetId };
}
