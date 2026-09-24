/**
 * #131 — assembling the validator's read set from PostgreSQL, and the substrate lock.
 *
 * Lock order (ADR-0031 §7): the universe row lock, when a request holds
 * one, always comes first; the substrate advisory lock second. Writers of shared knowledge
 * (seed loads, shared proposals, corrections) take it exclusively; anything that must see a
 * stable substrate while writing private rows (universe proposals, branch opens, erasure) takes
 * it shared. Corrections never take a universe lock, so the two orders cannot cycle.
 *
 * The v1 substrate is editorial-sized (hundreds of concepts/claims), so a full load per decision
 * is deliberate: it keeps "what the validator saw" trivially equal to "what the database held".
 * A larger substrate needs a bounded neighbourhood query with the same slice semantics.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { BridgeReadSet, ClaimRole, ReadSetBridge, ReadSetClaim, ReadSetConcept, ReadSetRelation } from '../../../core/src/semantic/bridge-validator.ts';

const SUBSTRATE_LOCK = 0x5ea_0131;

export async function lockSubstrateExclusive(client: pg.PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [SUBSTRATE_LOCK]);
}
export async function lockSubstrateShared(client: pg.PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock_shared($1)', [SUBSTRATE_LOCK]);
}

/** Key-sorted JSON so the same payload always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Everything the validator may consult. `universeId` adds that universe's own admitted bridges to
 * the duplicate check; shared bridges are always included. */
export async function loadBridgeReadSet(client: pg.PoolClient, universeId: string | null): Promise<BridgeReadSet> {
  const concepts = (await client.query<{ code: string; name: string; description: string; parent_code: string | null }>(
    `SELECT c.code, c.name, c.description, p.code AS parent_code FROM concept c LEFT JOIN concept p ON p.id = c.parent_id`,
  )).rows.map((r): ReadSetConcept => ({ code: r.code, name: r.name, description: r.description, parentCode: r.parent_code }));

  const claims = (await client.query<{ key: string; supported: boolean; links: { code: string; role: ClaimRole }[] | null }>(
    `SELECT cl.key, claim_is_supported(cl.id) AS supported,
            json_agg(json_build_object('code', co.code, 'role', cc.role) ORDER BY co.code, cc.role)
              FILTER (WHERE co.code IS NOT NULL) AS links
     FROM claim cl LEFT JOIN claim_concept cc ON cc.claim_id = cl.id LEFT JOIN concept co ON co.id = cc.concept_id
     GROUP BY cl.id, cl.key`,
  )).rows.map((r): ReadSetClaim => ({ key: r.key, status: r.supported ? 'supported' : 'unsupported', concepts: r.links ?? [] }));

  const relations = (await client.query<{ from_code: string; to_code: string; kind: string; claim_key: string; active: boolean }>(
    `SELECT f.code AS from_code, t.code AS to_code, r.kind, cl.key AS claim_key, r.status = 'active' AS active
     FROM concept_relation r JOIN concept f ON f.id = r.from_concept_id JOIN concept t ON t.id = r.to_concept_id
     JOIN claim cl ON cl.id = r.claim_id`,
  )).rows.map((r): ReadSetRelation => ({ from: r.from_code, to: r.to_code, kind: r.kind, claimKey: r.claim_key, active: r.active }));

  const admittedBridges = (await client.query<{ id: string; from_code: string; to_code: string; relation_type: string }>(
    `SELECT b.id, f.code AS from_code, t.code AS to_code, b.relation_type
     FROM bridge b JOIN concept f ON f.id = b.from_concept_id JOIN concept t ON t.id = b.to_concept_id
     WHERE b.status = 'admitted' AND (b.universe_id IS NULL OR b.universe_id = $1)`,
    [universeId],
  )).rows.map((r): ReadSetBridge => ({ id: r.id, fromConcept: r.from_code, toConcept: r.to_code, relationType: r.relation_type }));

  return {
    concepts: new Map(concepts.map(c => [c.code, c])),
    claims: new Map(claims.map(c => [c.key, c])),
    relations,
    admittedBridges,
  };
}
