/**
 * #131 — mechanical verification of the editorial substrate seed (content/substrate.json).
 *
 *   pnpm exec tsx scripts/substrate/verify-substrate.ts [--require-snapshots] [--receipt path]
 *
 * Always: strict schema, referential integrity (families, sources, concept parents, claim
 * concepts, relation claims, annotated assets exist in content/editorial-scrolls.json, bridge
 * proposal claim keys). With local snapshots (artifacts/source-snapshots/<key>.txt, written by
 * snapshot_source.py): the snapshot hash must equal the seed's recorded hash and every claim quote
 * must be an exact passage of that text after the shared normalization. `--require-snapshots`
 * turns a missing snapshot into a failure instead of an "unverified" line — use it before
 * committing new or changed claims. CI has no snapshots and therefore proves integrity only.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { substrateSeed, type SubstrateSeed } from '../../packages/contracts/src/semantic.ts';

export type QuoteCheck = { claimKey: string; sourceKey: string; status: 'verified' | 'missing_in_snapshot' | 'unverified_no_snapshot' };
export type SeedReport = { errors: string[]; quotes: QuoteCheck[]; sources: { key: string; status: 'hash_match' | 'hash_mismatch' | 'no_snapshot' }[] };

/** Mirrors snapshot_source.py's normalize(): NFC and whitespace collapse only. */
export function normalizeSnapshotText(text: string): string {
  return text.normalize('NFC').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

export function checkSubstrateSeed(
  raw: unknown,
  editorialAssetIds: ReadonlySet<string>,
  readSnapshot: (sourceKey: string) => string | null,
): SeedReport {
  const errors: string[] = [];
  const parsed = substrateSeed.safeParse(raw);
  if (!parsed.success) {
    return { errors: parsed.error.issues.map(i => `schema ${i.path.join('.')}: ${i.message}`), quotes: [], sources: [] };
  }
  const seed: SubstrateSeed = parsed.data;
  const unique = (label: string, keys: string[]) => {
    const seen = new Set<string>();
    for (const key of keys) { if (seen.has(key)) errors.push(`duplicate ${label} ${key}`); seen.add(key); }
    return seen;
  };
  const families = unique('family', seed.families.map(f => f.key));
  const sources = unique('source', seed.sources.map(s => s.key));
  unique('source url', seed.sources.map(s => s.url));
  const concepts = unique('concept', seed.concepts.map(c => c.code));
  const claims = unique('claim', seed.claims.map(c => c.key));
  unique('bridge proposal', seed.bridgeProposals.map(b => b.key));
  unique('asset annotation', seed.assets.map(a => a.assetId));

  for (const s of seed.sources) if (!families.has(s.familyKey)) errors.push(`source ${s.key} names unknown family ${s.familyKey}`);
  for (const c of seed.concepts) {
    if (c.parentCode !== null && !concepts.has(c.parentCode)) errors.push(`concept ${c.code} names unknown parent ${c.parentCode}`);
    if (c.parentCode === c.code) errors.push(`concept ${c.code} is its own parent`);
  }
  // A parent chain must terminate: the hierarchy is a forest, never a cycle.
  const parentOf = new Map(seed.concepts.map(c => [c.code, c.parentCode]));
  for (const c of seed.concepts) {
    const walked = new Set<string>();
    let at: string | null | undefined = c.code;
    while (at) { if (walked.has(at)) { errors.push(`concept hierarchy cycle through ${c.code}`); break; } walked.add(at); at = parentOf.get(at); }
  }
  for (const claim of seed.claims) {
    for (const link of claim.concepts) if (!concepts.has(link.code)) errors.push(`claim ${claim.key} names unknown concept ${link.code}`);
    for (const support of claim.support) if (!sources.has(support.sourceKey)) errors.push(`claim ${claim.key} cites unknown source ${support.sourceKey}`);
  }
  for (const r of seed.relations) {
    if (!concepts.has(r.from) || !concepts.has(r.to)) errors.push(`relation ${r.from}→${r.to} names an unknown concept`);
    if (!claims.has(r.claimKey)) errors.push(`relation ${r.from}→${r.to} names unknown claim ${r.claimKey}`);
    if (r.from === r.to) errors.push(`relation ${r.from} relates a concept to itself`);
  }
  for (const a of seed.assets) {
    if (!editorialAssetIds.has(a.assetId)) errors.push(`asset annotation ${a.assetId} is not an editorial Scroll`);
    if (a.concepts.filter(c => c.role === 'primary').length !== 1) errors.push(`asset ${a.assetId} must have exactly one primary concept`);
    for (const c of a.concepts) if (!concepts.has(c.code)) errors.push(`asset ${a.assetId} names unknown concept ${c.code}`);
    for (const k of a.claims) if (!claims.has(k)) errors.push(`asset ${a.assetId} names unknown claim ${k}`);
  }
  for (const b of seed.bridgeProposals) {
    const p = b.payload;
    if (!concepts.has(p.fromConcept) || !concepts.has(p.toConcept)) errors.push(`bridge proposal ${b.key} names an unknown concept`);
    for (const e of p.evidence) if (!claims.has(e.claimKey)) errors.push(`bridge proposal ${b.key} cites unknown claim ${e.claimKey}`);
    for (const k of p.counterevidence.claimKeys) if (!claims.has(k)) errors.push(`bridge proposal ${b.key} cites unknown counterevidence ${k}`);
  }

  const sourceReports: SeedReport['sources'] = [];
  const snapshotText = new Map<string, string>();
  for (const s of seed.sources) {
    const text = readSnapshot(s.key);
    if (text === null) { sourceReports.push({ key: s.key, status: 'no_snapshot' }); continue; }
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');
    if (digest !== s.contentSha256) { sourceReports.push({ key: s.key, status: 'hash_mismatch' }); errors.push(`source ${s.key} snapshot hash does not match the seed`); continue; }
    sourceReports.push({ key: s.key, status: 'hash_match' });
    snapshotText.set(s.key, text);
  }
  const quotes: QuoteCheck[] = [];
  for (const claim of seed.claims) {
    for (const support of claim.support) {
      const text = snapshotText.get(support.sourceKey);
      if (text === undefined) { quotes.push({ claimKey: claim.key, sourceKey: support.sourceKey, status: 'unverified_no_snapshot' }); continue; }
      const found = text.includes(normalizeSnapshotText(support.quote));
      quotes.push({ claimKey: claim.key, sourceKey: support.sourceKey, status: found ? 'verified' : 'missing_in_snapshot' });
      if (!found) errors.push(`claim ${claim.key}: quote is not an exact passage of ${support.sourceKey}`);
    }
  }
  return { errors, quotes, sources: sourceReports };
}

export function loadEditorialAssetIds(): Set<string> {
  const scrolls = JSON.parse(readFileSync('content/editorial-scrolls.json', 'utf8')) as Array<{ assetId: string }>;
  return new Set(scrolls.map(s => s.assetId));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const requireSnapshots = process.argv.includes('--require-snapshots');
  const receiptIndex = process.argv.indexOf('--receipt');
  const seed = JSON.parse(readFileSync('content/substrate.json', 'utf8'));
  const report = checkSubstrateSeed(seed, loadEditorialAssetIds(), key => {
    const path = `artifacts/source-snapshots/${key}.txt`;
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  });
  if (requireSnapshots) for (const s of report.sources) if (s.status === 'no_snapshot') report.errors.push(`source ${s.key} has no local snapshot`);
  const counts = {
    verified: report.quotes.filter(q => q.status === 'verified').length,
    unverified: report.quotes.filter(q => q.status === 'unverified_no_snapshot').length,
    missing: report.quotes.filter(q => q.status === 'missing_in_snapshot').length,
  };
  const summary = { checkedAt: new Date().toISOString(), seedVersion: (seed as { version?: string }).version, counts, sources: report.sources, errors: report.errors };
  if (receiptIndex > 0) writeFileSync(process.argv[receiptIndex + 1]!, `${JSON.stringify({ ...summary, quotes: report.quotes }, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = report.errors.length === 0 ? 0 : 1;
}
