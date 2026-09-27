/**
 * #162 — admitting a model-written Scroll (ADR-0041 §2, §6).
 *
 * A checked Scroll enters the library in one transaction under the substrate lock: its family and
 * source (inserted if absent), the snapshot and the private material it was checked against, its
 * claims (`created_by = 'model_proposal'`) with their verbatim quotes, the Scroll asset with its
 * concept and claim annotations, and the `scroll_writing` record. A refused reply records reason
 * codes only. The pair of material and request hashes decides once: a pair already decided returns
 * that decision and writes nothing.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { MaterialHost } from '../../../core/src/scrolls/material.ts';
import type { CheckedScroll, OfferedConcept } from '../../../core/src/scrolls/writing.ts';
import { lockSubstrateExclusive, sha256 } from './read-set.ts';
import { ensureRow } from './seed.ts';

/** Model-written Scrolls are ordered after this, clear of the editorial seed, which numbers its
 * Scrolls by their index in content/editorial-scrolls.json (a seed with one more Scroll must not collide). */
const MODEL_SCROLL_ORDER_FLOOR = 99_999;

export interface WritingIdentity { materialSha256: string; requestSha256: string }
export interface WritingRecord {
  transport: 'fixture' | 'minimax'; model: string; inputBytes: number;
  /** Token counts only; never a prompt or a reply. */
  usage: Record<string, unknown>;
  versions: Record<string, string>;
}
export interface WritingMaterial {
  /** The final URL the page was read from. */
  url: string; title: string | null; host: MaterialHost;
  /** The normalized visible text whose SHA-256 is the identity's material hash. */
  text: string; retrievedAt: string;
}
export type AlreadyDecided = { status: 'already_decided'; writingId: string; assetId: string | null; reasons: string[] };

/** The plan's concepts as the request offers them (plan order; unknown codes are simply absent), and
 * every code the substrate knows. */
export async function loadConceptOffer(client: pg.PoolClient, codes: readonly string[]): Promise<{ offered: OfferedConcept[]; known: Set<string> }> {
  const rows = (await client.query<OfferedConcept>('SELECT code, name, description FROM concept')).rows;
  const byCode = new Map(rows.map(r => [r.code, r]));
  return { offered: codes.flatMap(code => byCode.get(code) ?? []), known: new Set(byCode.keys()) };
}

/** `changed`: the substrate holds this URL, but not with a current snapshot of exactly this text. */
export async function sourceStanding(client: pg.PoolClient, url: string, contentSha256: string): Promise<'new' | 'same' | 'changed'> {
  const row = (await client.query<{ current: string | null }>(
    `SELECT (SELECT content_sha256 FROM source_snapshot WHERE source_id = s.id AND status = 'current') AS current FROM semantic_source s WHERE s.url = $1`,
    [url],
  )).rows[0];
  if (!row) return 'new';
  return row.current === contentSha256 ? 'same' : 'changed';
}

export async function findScrollWriting(client: pg.PoolClient, identity: WritingIdentity): Promise<AlreadyDecided | null> {
  const row = (await client.query<{ id: string; asset_id: string | null; reasons: string[] }>(
    'SELECT id, asset_id, reasons FROM scroll_writing WHERE material_sha256 = $1 AND request_sha256 = $2',
    [identity.materialSha256, identity.requestSha256],
  )).rows[0];
  return row ? { status: 'already_decided', writingId: row.id, assetId: row.asset_id, reasons: row.reasons } : null;
}

/** A refusal keeps its reason codes and hashes, never the reply or the material. */
export async function recordRefusedScroll(client: pg.PoolClient, input: { identity: WritingIdentity; url: string; reasons: readonly string[]; record: WritingRecord }):
  Promise<{ status: 'refused'; writingId: string; reasons: string[] } | AlreadyDecided> {
  const { identity, record } = input;
  const inserted = (await client.query<{ id: string }>(
    `INSERT INTO scroll_writing(id,material_sha256,request_sha256,source_url,transport,model,versions,input_bytes,usage,status,reasons)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'refused',$10) ON CONFLICT (material_sha256, request_sha256) DO NOTHING RETURNING id`,
    [randomUUID(), identity.materialSha256, identity.requestSha256, input.url, record.transport, record.model,
      JSON.stringify(record.versions), record.inputBytes, JSON.stringify(record.usage), JSON.stringify(input.reasons)],
  )).rows[0];
  return inserted ? { status: 'refused', writingId: inserted.id, reasons: [...input.reasons] } : (await findScrollWriting(client, identity))!;
}

export async function admitModelScroll(client: pg.PoolClient, input: { identity: WritingIdentity; material: WritingMaterial; scroll: CheckedScroll; record: WritingRecord }):
  Promise<{ status: 'admitted'; writingId: string; assetId: string } | { status: 'refused'; writingId: string; reasons: string[] } | AlreadyDecided> {
  const { identity, material, scroll, record } = input;
  await lockSubstrateExclusive(client);
  const prior = await findScrollWriting(client, identity);
  if (prior) return prior;
  // Checked again under the lock: a correction may have landed since the page was read.
  const standing = await sourceStanding(client, material.url, identity.materialSha256);
  if (standing === 'changed') return recordRefusedScroll(client, { identity, url: material.url, reasons: ['source_changed'], record });

  // A page the substrate already holds keeps its own source and current snapshot (the same text, as
  // `sourceStanding` just proved); a new page becomes a source under its URL's key, with a first
  // snapshot.
  const { host } = material;
  let source = (await client.query<{ snapshot_id: string; title: string; publisher: string }>(
    `SELECT ss.id AS snapshot_id, s.title, s.publisher FROM semantic_source s JOIN source_snapshot ss ON ss.source_id = s.id AND ss.status = 'current' WHERE s.url = $1`,
    [material.url],
  )).rows[0];
  if (!source) {
    const familyId = await ensureRow(client, 'evidence_family', 'key', { key: host.family.key, kind: host.family.kind, description: host.family.description }, ['kind', 'description']);
    const title = material.title !== null && material.title.length >= 3 ? material.title.slice(0, 300).trim() : material.url.slice(0, 300);
    const sourceId = await ensureRow(client, 'semantic_source', 'key', {
      key: `${host.keyPrefix}.page-${sha256(material.url).slice(0, 16)}`, url: material.url, title, publisher: host.publisher, family_id: familyId,
    }, ['url', 'title', 'publisher', 'family_id']);
    source = { snapshot_id: randomUUID(), title, publisher: host.publisher };
    await client.query('INSERT INTO source_snapshot(id,source_id,revision,retrieved_on,content_sha256) VALUES($1,$2,1,$3,$4)',
      [source.snapshot_id, sourceId, material.retrievedAt.slice(0, 10), identity.materialSha256]);
  }
  await client.query('INSERT INTO source_material(snapshot_id,content,retrieved_at) VALUES($1,$2,$3) ON CONFLICT (snapshot_id) DO NOTHING',
    [source.snapshot_id, material.text, material.retrievedAt]);

  const conceptIds = new Map((await client.query<{ id: string; code: string }>('SELECT id, code FROM concept WHERE code = ANY($1::text[])',
    [[...scroll.concepts.map(c => c.code), ...scroll.claims.flatMap(c => c.concepts.map(l => l.code))]])).rows.map(r => [r.code, r.id]));
  const claimPrefix = `clm.model.${sha256(`${identity.materialSha256}:${identity.requestSha256}`).slice(0, 16)}`;
  const claimIds: string[] = [];
  for (const [index, claim] of scroll.claims.entries()) {
    const claimId = randomUUID();
    claimIds.push(claimId);
    await client.query(`INSERT INTO claim(id,key,statement,truth_state,created_by) VALUES($1,$2,$3,'documented','model_proposal')`,
      [claimId, `${claimPrefix}.${index + 1}`, claim.statement]);
    for (const link of claim.concepts) {
      await client.query('INSERT INTO claim_concept(claim_id,concept_id,role) VALUES($1,$2,$3)', [claimId, conceptIds.get(link.code), link.role]);
    }
    await client.query('INSERT INTO claim_support(id,claim_id,snapshot_id,quote,support_kind) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), claimId, source.snapshot_id, claim.quote, claim.supportKind]);
  }

  // The source title and URL stay internal: readers never see a source (owner decision, 2026-09-24).
  const assetId = randomUUID();
  await client.query(
    `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
     VALUES($1,1,'Scroll',$2,$3,$4,$5,$6,'documented',(SELECT GREATEST(COALESCE(MAX(editorial_order), -1), $7) + 1 FROM asset))`,
    [assetId, scroll.title, scroll.summary, scroll.body, `${source.publisher} · ${source.title}`, material.url, MODEL_SCROLL_ORDER_FLOOR],
  );
  for (const c of scroll.concepts) await client.query('INSERT INTO asset_concept(asset_id,concept_id,role) VALUES($1,$2,$3)', [assetId, conceptIds.get(c.code), c.role]);
  for (const claimId of claimIds) await client.query('INSERT INTO asset_claim(asset_id,claim_id) VALUES($1,$2)', [assetId, claimId]);

  const writingId = randomUUID();
  await client.query(
    `INSERT INTO scroll_writing(id,material_sha256,request_sha256,source_url,transport,model,versions,input_bytes,usage,status,reasons,snapshot_id,asset_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'admitted','[]',$10,$11)`,
    [writingId, identity.materialSha256, identity.requestSha256, material.url, record.transport, record.model,
      JSON.stringify(record.versions), record.inputBytes, JSON.stringify(record.usage), source.snapshot_id, assetId],
  );
  return { status: 'admitted', writingId, assetId };
}
