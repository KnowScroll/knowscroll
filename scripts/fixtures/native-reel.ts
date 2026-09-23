/** Explicit disposable fixture derived from inventory-http.test.ts. Synthetic lineage/gate rows
 * are TEST SETUP, not provider outcomes. Actual authorized MP4 bytes and ffprobe metadata are used.
 * No owner data, network provider, shared contract or production publication path is modified. */
import {createHash,randomUUID} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {generationBrief} from '../../packages/contracts/src/generation.ts';
import {CUTROOM_CONTRACT_REVISION as REVISION} from '../../apps/worker/src/generation/storage.ts';
import {mintReelAsset} from '../../apps/worker/src/publication/mint.ts';
const db = new URL(process.env.DATABASE_URL!);
if(!/^knowscroll_test_native_[a-f0-9]+$/.test(db.pathname.slice(1)) || !['localhost','127.0.0.1'].includes(db.hostname)) throw Error('Disposable native database required');
const {pool}=await import('../../packages/db/src/index.ts');
const mediaRoot=process.env.KS_MEDIA_ROOT!;
if(!mediaRoot.startsWith('/Volumes/'))throw Error('SSD media directory required');
const video=process.env.KS_NATIVE_VIDEO!;
const bytes=await readFile(video);
const metadata=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=width,height,codec_type','-of','json',video],{encoding:'utf8'}));
const stream=metadata.streams.find((v:{codec_type:string})=>v.codec_type==='video');
const probe={durationSeconds:Number(metadata.format.duration),width:stream.width,height:stream.height};
const claim = (id: string, role: 'main' | 'supporting') => ({ id, role });
const sentence = (text: string, claimIds: string[]) => ({ text, claimIds });

function brief(assetId: string, tag: string) {
  return generationBrief.parse({
    version: 1,
    worldId: `inventory-http-${tag}`,
    narration: [
      sentence(`Sentence one ${tag}.`, ['c1']),
      sentence(`Sentence two ${tag}.`, ['c1']),
      sentence(`Sentence three ${tag}.`, ['c2']),
      sentence(`Sentence four ${tag}.`, ['c2']),
    ],
    claims: [claim('c1', 'main'), claim('c2', 'supporting')],
    claimSources: [{ claimId: 'c1', assetId, assetRevision: 1 }, { claimId: 'c2', assetId, assetRevision: 1 }],
    criteria: { mustShow: [{ id: 'show-1', text: 'Something visible.', type: 'presence' as const, claimId: 'c1' }], mustNotShow: [], depictionPolicyVersion: 'depiction-v1' },
    style: { id: 'library', version: 1, text: 'Quiet, documentary, no captions burned in.' },
    title: `Supplied product demo · TEST MEDIA ${tag}`,
    summary: `Supplied video for native playback verification. No Cutroom generation or source alignment is claimed.`,
  });
}

const REQUIRED_GATES = ['lineage_complete', 'source_support', 'engine_record', 'media_conformance', 'truth_label', 'repetition', 'witness_alignment'];

async function seedMintedReel(tag: string): Promise<{ assetId: string; mediaSha256: string; sourceAssetId: string; generatedReelId: string }> {
  const sourceAssetId = randomUUID();
  // ADR-0028: a minted Reel's `source_title`/`source_url` (copied verbatim from this Scroll by
  // `mintReelAsset`) is now also the composer's `sourceKey` for diversity ranking. A literal
  // identical URL across every fixture this file mints would make composer-signals-v1 see them
  // all as "one source" and cap them at max_per_source — tagged uniquely, each fixture is its own
  // source, matching what a real distinct generation would be.
  await pool.query(
    `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
     VALUES($1,1,'Scroll','Inside the supplied demo library','A labelled test encounter for exploring native playback.','This authored test note accompanies a supplied product demonstration. Open Cable Reel to play the original video, or open the authored interaction preview to compare three demos. The video is supplied media, not a Cutroom generation or evidence of source alignment. Keep records only this explicit encounter. The associated source address is a fixture, not a published reference.',$2,$3,'documented',(SELECT COALESCE(MAX(editorial_order),0)+1 FROM asset))`,
    [sourceAssetId, `Supplied demo library · TEST ${tag}`, `https://example.test/library-${tag}`],
  );

  const briefJson = brief(sourceAssetId, tag);
  const briefSha256 = createHash('sha256').update(JSON.stringify(briefJson)).digest('hex');
  const briefId = randomUUID();
  await pool.query(
    `INSERT INTO generation_brief(id,source_asset_id,source_asset_revision,truth_state,brief,brief_sha256,authored_by,review_state)
     VALUES($1,$2,1,'synthesis',$3,$4,'test','approved')`,
    [briefId, sourceAssetId, JSON.stringify(briefJson), briefSha256],
  );

  const engineId = randomUUID();
  const port = 20000 + Math.floor(Math.random() * 30000);
  await pool.query(
    `INSERT INTO cutroom_engine(id,origin,contract_revision,artifact_root,provider_mode,declared_by)
     VALUES($1,$2,$3,'/Volumes/Mrigesh SSD/knowscroll-dev/tmp/native-fixtures','standin','test')`,
    [engineId, `http://127.0.0.1:${port}`, REVISION],
  );
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
  const requestId = `ks-gen-${attemptId}`;
  const requestBody = '{}';
  await pool.query(
    `INSERT INTO cutroom_attempt(id,job_id,ordinal,request_id,request_body,body_sha256,contract_revision)
     VALUES($1,$2,1,$3,$4,$5,$6)`,
    [attemptId, jobId, requestId, requestBody, createHash('sha256').update(requestBody).digest('hex'), REVISION],
  );
  const runId = `run-${attemptId}`;
  const enginePath = `/Volumes/Mrigesh SSD/knowscroll-dev/tmp/native-fixtures/${attemptId}.mp4`;
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

  const mediaSha256 = createHash('sha256').update(bytes).digest('hex');
  const storageKey = `sha256/${mediaSha256.slice(0, 2)}/${mediaSha256.slice(2, 4)}/${mediaSha256}.mp4`;
  await pool.query(
    `INSERT INTO media_object(sha256,byte_size,content_type,probe,storage_key) VALUES($1,$4,'video/mp4',$2,$3)`,
    [mediaSha256, JSON.stringify(probe), storageKey, bytes.length],
  );

  await mkdir(dirname(join(mediaRoot,storageKey)), {recursive:true});
  await writeFile(join(mediaRoot,storageKey),bytes);
  const generatedReelId = randomUUID();
  const lineage = { briefSha256, contractRevision: REVISION, runId, recordSummary: { takes: 1, used: 1 } };
  await pool.query(
    `INSERT INTO generated_reel(id,attempt_id,brief_id,engine_id,cutroom_run_id,media_sha256,engine_path,provider_mode,truth_state,generated_label,lineage)
     VALUES($1,$2,$3,$4,$5,$6,$7,'standin','synthesis',true,$8)`,
    [generatedReelId, attemptId, briefId, engineId, runId, mediaSha256, enginePath, JSON.stringify(lineage)],
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
  return { assetId: minted.assetId, mediaSha256, sourceAssetId, generatedReelId };
}

const tag = process.env.KS_NATIVE_TAG ?? 'native';
if (!/^[a-z0-9-]{1,40}$/.test(tag)) throw Error('Invalid test media tag');
try { console.log(JSON.stringify(await seedMintedReel(tag))); } finally { await pool.end(); }
