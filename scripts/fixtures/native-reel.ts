/** Explicit disposable fixture derived from inventory-http.test.ts. Synthetic lineage/gate rows
 * are TEST SETUP, not provider outcomes. Actual authorized MP4 bytes and ffprobe metadata are used.
 * No owner data, network provider, shared contract or production publication path is modified.
 *
 * By default the Reel is minted over a labelled test Scroll of its own. `KS_NATIVE_SOURCE_ASSET`
 * names a library Scroll instead, so the Reel carries that Scroll's concepts (ADR-0043) and can be
 * explained and continued from on a device. */
import {createHash,randomUUID} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {mintGatedTestReel} from './gated-reel.ts';
const db = new URL(process.env.DATABASE_URL!);
if(!/^knowscroll_test_(native|hands)_[a-f0-9]+$/.test(db.pathname.slice(1)) || !['localhost','127.0.0.1'].includes(db.hostname)) throw Error('Disposable native database required');
const {pool}=await import('../../packages/db/src/index.ts');
const mediaRoot=process.env.KS_MEDIA_ROOT!;
if(!mediaRoot.startsWith('/Volumes/'))throw Error('SSD media directory required');
const video=process.env.KS_NATIVE_VIDEO!;
const bytes=await readFile(video);
const metadata=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=width,height,codec_type','-of','json',video],{encoding:'utf8'}));
const stream=metadata.streams.find((v:{codec_type:string})=>v.codec_type==='video');
const probe={durationSeconds:Number(metadata.format.duration),width:stream.width,height:stream.height};

async function seedLabelledScroll(tag: string): Promise<string> {
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
  return sourceAssetId;
}

async function seedMintedReel(tag: string): Promise<{ assetId: string; mediaSha256: string; sourceAssetId: string; generatedReelId: string }> {
  const sourceAssetId = process.env.KS_NATIVE_SOURCE_ASSET ?? await seedLabelledScroll(tag);
  const reel = await mintGatedTestReel(pool, sourceAssetId, {
    tag,
    title: `Supplied product demo · TEST MEDIA ${tag}`,
    summary: `Supplied video for native playback verification. No Cutroom generation or source alignment is claimed.`,
    media: { sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length, probe },
    artifactRoot: '/Volumes/Mrigesh SSD/knowscroll-dev/tmp/native-fixtures',
  });
  await mkdir(dirname(join(mediaRoot,reel.storageKey)), {recursive:true});
  await writeFile(join(mediaRoot,reel.storageKey),bytes);
  return { assetId: reel.assetId, mediaSha256: reel.mediaSha256, sourceAssetId, generatedReelId: reel.generatedReelId };
}

const tag = process.env.KS_NATIVE_TAG ?? 'native';
if (!/^[a-z0-9-]{1,40}$/.test(tag)) throw Error('Invalid test media tag');
try { console.log(JSON.stringify(await seedMintedReel(tag))); } finally { await pool.end(); }
