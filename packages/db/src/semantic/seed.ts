/**
 * #131 — loading the editorial substrate seed (content/substrate.json) idempotently.
 *
 * Knowledge rows are immutable, so "load" means insert-if-absent and then verify that whatever is
 * present is exactly what the seed says. A different statement under an existing key, or a source
 * whose content hash changed, is a conflict: it must become a new key or a correction, never a
 * silent overwrite of what a reader was already shown. Editorial bridge proposals then go through
 * the same validator as every other proposer (`submitBridgeProposal`).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { substrateSeed, type SubstrateSeed } from '../../../contracts/src/semantic.ts';
import { lockSubstrateExclusive, sha256 } from './read-set.ts';
import { submitBridgeProposal, type ProposalResult } from './proposals.ts';
import { revalidateAdmittedBridges } from './corrections.ts';

export class SubstrateSeedConflict extends Error {
  constructor(message: string) { super(message); this.name = 'SubstrateSeedConflict'; }
}

export type SeedLoadResult = {
  status: 'loaded' | 'already_loaded';
  version: string;
  counts: Record<string, number>;
  proposals: { key: string; result: ProposalResult }[];
};

/** Insert-if-absent by natural key, then prove the stored row equals what the seed says. */
async function ensureRow(client: pg.PoolClient, table: string, keyColumn: string, values: Record<string, unknown>, compare: string[]): Promise<string> {
  const columns = Object.keys(values);
  const inserted = await client.query(
    `INSERT INTO ${table}(id,${columns.join(',')}) VALUES($1,${columns.map((_, i) => `$${i + 2}`).join(',')})
     ON CONFLICT (${keyColumn}) DO NOTHING RETURNING id`,
    [randomUUID(), ...columns.map(c => values[c])],
  );
  if (inserted.rowCount) return inserted.rows[0].id;
  const row = (await client.query(`SELECT * FROM ${table} WHERE ${keyColumn}=$1`, [values[keyColumn]])).rows[0];
  for (const column of compare) {
    const stored = row[column] instanceof Date ? row[column].toISOString().slice(0, 10) : row[column];
    if (String(stored) !== String(values[column])) {
      throw new SubstrateSeedConflict(`${table} ${String(values[keyColumn])}: stored ${column} differs from the seed; add a new key or record a correction`);
    }
  }
  return row.id;
}

function parentsFirst(seed: SubstrateSeed): SubstrateSeed['concepts'] {
  const byCode = new Map(seed.concepts.map(c => [c.code, c]));
  const out: SubstrateSeed['concepts'] = [];
  const placed = new Set<string>();
  const place = (code: string, path: Set<string>) => {
    if (placed.has(code)) return;
    if (path.has(code)) throw new SubstrateSeedConflict(`concept hierarchy cycle through ${code}`);
    const concept = byCode.get(code);
    if (!concept) throw new SubstrateSeedConflict(`unknown concept ${code}`);
    if (concept.parentCode) place(concept.parentCode, new Set([...path, code]));
    placed.add(code);
    out.push(concept);
  };
  for (const c of seed.concepts) place(c.code, new Set());
  return out;
}

export async function loadSubstrateSeed(client: pg.PoolClient, rawText: string): Promise<SeedLoadResult> {
  const seed = substrateSeed.parse(JSON.parse(rawText));
  const contentSha = sha256(rawText);
  await lockSubstrateExclusive(client);

  const prior = (await client.query('SELECT content_sha256, counts FROM semantic_seed_load WHERE version=$1', [seed.version])).rows[0];
  if (prior) {
    if (prior.content_sha256 !== contentSha) throw new SubstrateSeedConflict(`seed ${seed.version} was loaded with different content; publish a new version`);
    return { status: 'already_loaded', version: seed.version, counts: prior.counts, proposals: [] };
  }

  const familyIds = new Map<string, string>();
  for (const f of seed.families) familyIds.set(f.key, await ensureRow(client, 'evidence_family', 'key', { key: f.key, kind: f.kind, description: f.description }, ['kind', 'description']));

  const snapshotIds = new Map<string, string>();
  for (const s of seed.sources) {
    const sourceId = await ensureRow(client, 'semantic_source', 'key',
      { key: s.key, url: s.url, title: s.title, publisher: s.publisher, family_id: familyIds.get(s.familyKey) }, ['url', 'title', 'publisher', 'family_id']);
    const current = (await client.query('SELECT id, content_sha256 FROM source_snapshot WHERE source_id=$1 AND status=$2', [sourceId, 'current'])).rows[0];
    if (current) {
      if (current.content_sha256 !== s.contentSha256) throw new SubstrateSeedConflict(`source ${s.key} content changed; record a correction and a new snapshot revision`);
      snapshotIds.set(s.key, current.id);
      continue;
    }
    const anyPrior = (await client.query('SELECT count(*)::int AS n FROM source_snapshot WHERE source_id=$1', [sourceId])).rows[0].n as number;
    if (anyPrior > 0) throw new SubstrateSeedConflict(`source ${s.key} has no current snapshot (corrected or revoked); a new revision needs re-verification`);
    const id = randomUUID();
    await client.query('INSERT INTO source_snapshot(id,source_id,revision,retrieved_on,content_sha256) VALUES($1,$2,1,$3,$4)', [id, sourceId, s.retrievedAt, s.contentSha256]);
    snapshotIds.set(s.key, id);
  }

  const conceptIds = new Map<string, string>();
  for (const c of parentsFirst(seed)) {
    conceptIds.set(c.code, await ensureRow(client, 'concept', 'code', {
      code: c.code, name: c.name, description: c.description, kind: c.kind,
      parent_id: c.parentCode ? conceptIds.get(c.parentCode) : null, created_by: 'editorial',
    }, ['name', 'description', 'kind', 'parent_id']));
  }

  // Knowledge links are part of a claim's identity: a later seed may not quietly add a concept, a
  // quote or an annotation to something a reader was already shown. After insert-if-absent, what is
  // stored must equal exactly what this seed says.
  const sameSet = async (label: string, sql: string, params: unknown[], expected: string[]) => {
    const stored = (await client.query<{ k: string }>(sql, params)).rows.map(r => r.k).sort();
    if (JSON.stringify(stored) !== JSON.stringify([...expected].sort())) {
      throw new SubstrateSeedConflict(`${label}: stored links differ from the seed; add a new key or record a correction`);
    }
  };

  const claimIds = new Map<string, string>();
  for (const claim of seed.claims) {
    // An existing claim is only compared, never extended: inserting first would let a later seed
    // add a link and then find it "already there".
    const existed = ((await client.query('SELECT 1 FROM claim WHERE key=$1', [claim.key])).rowCount ?? 0) > 0;
    const id = await ensureRow(client, 'claim', 'key', { key: claim.key, statement: claim.statement, truth_state: claim.truthState, created_by: 'editorial' }, ['statement', 'truth_state']);
    claimIds.set(claim.key, id);
    if (!existed) for (const link of claim.concepts) {
      await client.query('INSERT INTO claim_concept(claim_id,concept_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [id, conceptIds.get(link.code), link.role]);
    }
    if (!existed) for (const support of claim.support) {
      await client.query(
        'INSERT INTO claim_support(id,claim_id,snapshot_id,quote,support_kind) VALUES($1,$2,$3,$4,$5) ON CONFLICT (claim_id,snapshot_id,quote) DO NOTHING',
        [randomUUID(), id, snapshotIds.get(support.sourceKey), support.quote, support.supportKind],
      );
    }
    await sameSet(`claim ${claim.key} concepts`,
      `SELECT c.code || ':' || cc.role AS k FROM claim_concept cc JOIN concept c ON c.id = cc.concept_id WHERE cc.claim_id = $1`, [id],
      claim.concepts.map(l => `${l.code}:${l.role}`));
    await sameSet(`claim ${claim.key} support`,
      `SELECT s.snapshot_id || ':' || s.support_kind || ':' || s.quote AS k FROM claim_support s WHERE s.claim_id = $1`, [id],
      claim.support.map(q => `${snapshotIds.get(q.sourceKey)}:${q.supportKind}:${q.quote}`));
  }

  for (const r of seed.relations) {
    await client.query(
      `INSERT INTO concept_relation(id,from_concept_id,to_concept_id,kind,claim_id) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (from_concept_id,to_concept_id,kind) DO NOTHING`,
      [randomUUID(), conceptIds.get(r.from), conceptIds.get(r.to), r.kind, claimIds.get(r.claimKey)],
    );
    const stored = (await client.query<{ claim_id: string }>('SELECT claim_id FROM concept_relation WHERE from_concept_id=$1 AND to_concept_id=$2 AND kind=$3',
      [conceptIds.get(r.from), conceptIds.get(r.to), r.kind])).rows[0]!;
    if (stored.claim_id !== claimIds.get(r.claimKey)) throw new SubstrateSeedConflict(`relation ${r.from} ${r.kind} ${r.to} is already backed by another claim`);
  }

  for (const annotation of seed.assets) {
    const present = (await client.query('SELECT 1 FROM asset WHERE id=$1', [annotation.assetId])).rowCount;
    if (!present) throw new SubstrateSeedConflict(`annotated asset ${annotation.assetId} is not installed; seed editorial Scrolls first`);
    const annotated = ((await client.query('SELECT 1 FROM asset_concept WHERE asset_id=$1 LIMIT 1', [annotation.assetId])).rowCount ?? 0) > 0;
    if (!annotated) for (const c of annotation.concepts) {
      await client.query('INSERT INTO asset_concept(asset_id,concept_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [annotation.assetId, conceptIds.get(c.code), c.role]);
    }
    if (!annotated) for (const key of annotation.claims) {
      await client.query('INSERT INTO asset_claim(asset_id,claim_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [annotation.assetId, claimIds.get(key)]);
    }
    await sameSet(`asset ${annotation.assetId} concepts`,
      `SELECT c.code || ':' || ac.role AS k FROM asset_concept ac JOIN concept c ON c.id = ac.concept_id WHERE ac.asset_id = $1`, [annotation.assetId],
      annotation.concepts.map(c => `${c.code}:${c.role}`));
    await sameSet(`asset ${annotation.assetId} claims`,
      `SELECT cl.key AS k FROM asset_claim x JOIN claim cl ON cl.id = x.claim_id WHERE x.asset_id = $1`, [annotation.assetId], annotation.claims);
  }

  // New knowledge can invalidate an existing connection (a later contradiction, say): revalidate
  // every admitted bridge against the substrate as this seed leaves it, and record what changed.
  // A universe's own revoked bridge keeps its reason on its own (erasable) row; the shared log is
  // written only when shared knowledge changed, so it never dates a private event.
  const shared = (await revalidateAdmittedBridges(client, null, { seedVersion: seed.version })).filter(x => x.universeId === null);
  if (shared.length > 0) {
    const correctionId = randomUUID();
    await client.query(
      `INSERT INTO semantic_correction(id,target_kind,target_id,action,reason,actor_kind) VALUES($1,'seed_load',NULL,'revalidated',$2,'editorial')`,
      [correctionId, `Editorial seed ${seed.version} changed the substrate`],
    );
    for (const r of shared) {
      await client.query(
        `INSERT INTO semantic_correction_effect(correction_id,target_kind,target_id,before_status,after_status,reasons) VALUES($1,'bridge',$2,'admitted','revoked',$3)`,
        [correctionId, r.id, JSON.stringify(r.reasons)],
      );
    }
  }

  const proposals: SeedLoadResult['proposals'] = [];
  for (const p of seed.bridgeProposals) {
    proposals.push({ key: p.key, result: await submitBridgeProposal(client, { scope: { kind: 'shared' }, proposerKind: 'editorial', proposerRef: `${seed.version}:${p.key}`, payload: p.payload }) });
  }

  const counts = {
    families: seed.families.length, sources: seed.sources.length, concepts: seed.concepts.length, claims: seed.claims.length,
    relations: seed.relations.length, assets: seed.assets.length, bridgeProposals: seed.bridgeProposals.length,
    bridgesAdmitted: proposals.filter(p => p.result.status === 'admitted').length,
  };
  await client.query('INSERT INTO semantic_seed_load(version,content_sha256,counts) VALUES($1,$2,$3)', [seed.version, contentSha, JSON.stringify(counts)]);
  return { status: 'loaded', version: seed.version, counts, proposals };
}
