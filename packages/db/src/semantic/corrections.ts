/**
 * #131 — deterministic correction propagation.
 *
 * A source snapshot is marked corrected or revoked. Then, in the same transaction:
 *   claims that lose their last current `supports` quote become unsupported;
 *   substrate relations backed by such a claim are revoked;
 *   every admitted bridge citing an affected claim is re-validated, with the same pure validator
 *   that admitted it, against the post-correction substrate — and revoked if it no longer passes.
 * Each status change is recorded as a correction effect, so "why did this connection disappear"
 * names the source. Nothing is silently restored later: a re-verified source is a new snapshot
 * revision, and a revoked bridge returns only through a new proposal.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { bridgeProposalPayload, sourceCorrectionInput, type SourceCorrectionInput } from '../../../contracts/src/semantic.ts';
import { validateBridgeProposal } from '../../../core/src/semantic/bridge-validator.ts';
import { cancelRequestsForCorrectedMaterial } from '../inventory/supply.ts';
import { loadBridgeReadSet, lockSubstrateExclusive } from './read-set.ts';
import { SemanticInputError } from './proposals.ts';

export class SemanticNotFound extends Error {
  readonly statusCode = 404;
  constructor(message: string) { super(message); this.name = 'SemanticNotFound'; }
}

export type CorrectionEffect = { targetKind: 'claim' | 'bridge' | 'concept_relation'; targetId: string; before: string; after: string; reasons: string[] };
export type CorrectionReceipt = { correctionId: string; sourceKey: string; snapshotId: string; action: 'corrected' | 'revoked'; effects: CorrectionEffect[] };

export async function correctSourceSnapshot(client: pg.PoolClient, raw: unknown, actor: 'editorial' | 'operator'): Promise<CorrectionReceipt> {
  const parsed = sourceCorrectionInput.safeParse(raw);
  if (!parsed.success) throw new SemanticInputError('Invalid source correction');
  const input: SourceCorrectionInput = parsed.data;
  await lockSubstrateExclusive(client);

  const snapshot = (await client.query<{ id: string; url: string }>(
    `SELECT ss.id, s.url FROM source_snapshot ss JOIN semantic_source s ON s.id = ss.source_id WHERE s.key=$1 AND ss.status='current'`,
    [input.sourceKey],
  )).rows[0];
  if (!snapshot) throw new SemanticNotFound(`source ${input.sourceKey} has no current snapshot`);

  const affected = (await client.query<{ id: string; key: string }>(
    `SELECT DISTINCT c.id, c.key FROM claim c JOIN claim_support s ON s.claim_id = c.id
     WHERE s.snapshot_id = $1 AND claim_is_supported(c.id)`,
    [snapshot.id],
  )).rows;

  await client.query(
    `UPDATE source_snapshot SET status=$2, status_reason=$3, status_changed_at=clock_timestamp() WHERE id=$1`,
    [snapshot.id, input.action, input.reason],
  );
  const correctionId = randomUUID();
  await client.query(
    `INSERT INTO semantic_correction(id,target_kind,target_id,action,reason,actor_kind) VALUES($1,'source_snapshot',$2,$3,$4,$5)`,
    [correctionId, snapshot.id, input.action, input.reason, actor],
  );

  // #164 (ADR-0046 §5): shared supply not yet sent from this page is cancelled; nothing private is touched here.
  await cancelRequestsForCorrectedMaterial(client, snapshot.url, input.action);

  const effects: CorrectionEffect[] = [];
  const record = async (effect: CorrectionEffect) => {
    effects.push(effect);
    await client.query(
      `INSERT INTO semantic_correction_effect(correction_id,target_kind,target_id,before_status,after_status,reasons) VALUES($1,$2,$3,$4,$5,$6)`,
      [correctionId, effect.targetKind, effect.targetId, effect.before, effect.after, JSON.stringify(effect.reasons)],
    );
  };

  const lost: string[] = [];
  for (const claim of affected) {
    const still = (await client.query<{ ok: boolean }>('SELECT claim_is_supported($1) AS ok', [claim.id])).rows[0]!.ok;
    if (!still) { lost.push(claim.id); await record({ targetKind: 'claim', targetId: claim.id, before: 'supported', after: 'unsupported', reasons: [`source ${input.sourceKey} ${input.action}`] }); }
  }

  if (lost.length > 0) {
    const relations = (await client.query<{ id: string }>(
      `UPDATE concept_relation SET status='revoked', status_reason=$2 WHERE claim_id = ANY($1::uuid[]) AND status='active' RETURNING id`,
      [lost, `backing claim lost its source support (correction ${correctionId})`],
    )).rows;
    for (const r of relations) await record({ targetKind: 'concept_relation', targetId: r.id, before: 'active', after: 'revoked', reasons: ['backing_claim_unsupported'] });
  }

  // Re-validate every admitted bridge that cites an affected claim, in any role and any scope.
  for (const revoked of await revalidateAdmittedBridges(client, affected.map(c => c.id), { correctionId, sourceKey: input.sourceKey })) {
    // A universe's own bridge is private history: its reason lives on the bridge row (erased with it),
    // never in the shared effect log.
    if (revoked.universeId === null) await record({ targetKind: 'bridge', targetId: revoked.id, before: 'admitted', after: 'revoked', reasons: revoked.reasons });
  }

  return { correctionId, sourceKey: input.sourceKey, snapshotId: snapshot.id, action: input.action, effects };
}

/**
 * Re-run the validator on admitted bridges — those citing `claimIds`, or all of them when null — and
 * revoke those that no longer pass, with the cause recorded on the bridge. Used by corrections and by
 * seed loads (new knowledge, such as a contradiction, can invalidate an existing connection).
 */
export async function revalidateAdmittedBridges(
  client: pg.PoolClient,
  claimIds: readonly string[] | null,
  cause: Record<string, unknown>,
): Promise<{ id: string; universeId: string | null; reasons: string[] }[]> {
  const bridges = (await client.query<{ id: string; universe_id: string | null; payload: unknown }>(
    `SELECT DISTINCT b.id, b.universe_id, p.payload FROM bridge b JOIN semantic_proposal p ON p.id = b.proposal_id
     JOIN bridge_evidence e ON e.bridge_id = b.id
     WHERE b.status = 'admitted' AND ($1::uuid[] IS NULL OR e.claim_id = ANY($1::uuid[]))
     ORDER BY b.id`,
    [claimIds],
  )).rows;
  const revoked: { id: string; universeId: string | null; reasons: string[] }[] = [];
  for (const bridge of bridges) {
    const readSet = await loadBridgeReadSet(client, bridge.universe_id);
    const withoutSelf = { ...readSet, admittedBridges: readSet.admittedBridges.filter(b => b.id !== bridge.id) };
    const decision = validateBridgeProposal(bridgeProposalPayload.parse(bridge.payload), withoutSelf);
    if (decision.outcome === 'admitted') continue;
    await client.query(
      `UPDATE bridge SET status='revoked', status_reason=$2, status_changed_at=clock_timestamp() WHERE id=$1`,
      [bridge.id, JSON.stringify({ ...cause, reasons: decision.reasons, validatorVersion: decision.validatorVersion })],
    );
    revoked.push({ id: bridge.id, universeId: bridge.universe_id, reasons: decision.reasons });
  }
  return revoked;
}
