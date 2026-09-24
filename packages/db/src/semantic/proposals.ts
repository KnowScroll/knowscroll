/**
 * #131 — deciding a bridge proposal. One transaction: take the locks, assemble the read set,
 * run the pure validator, record the proposal with the exact read-set slice it was judged on,
 * and — only when admitted — create the bridge and its evidence rows. The database's own
 * commit-time guard (migration 0026) refuses an admitted bridge without current evidence even if
 * this module were wrong.
 *
 * Every proposer uses this path: editorial seeds, deterministic rules, model output (#132, which
 * must name its reasoning attempt as `proposerRef`) and a person acting in their own universe.
 * Provider text never reaches the database except through a payload that parsed and was decided.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { bridgeProposalPayload, type BridgeDecision, type BridgeProposalPayload, type ProposerKind } from '../../../contracts/src/semantic.ts';
import { sliceReadSet, validateBridgeProposal } from '../../../core/src/semantic/bridge-validator.ts';
import { canonicalJson, loadBridgeReadSet, lockSubstrateExclusive, lockSubstrateShared, sha256 } from './read-set.ts';

export type SemanticScope = { kind: 'shared' } | { kind: 'universe'; universeId: string; privacyEpoch: number };

export class SemanticInputError extends Error {
  readonly statusCode = 400;
  constructor(message: string) { super(message); this.name = 'SemanticInputError'; }
}
export class SemanticStaleEpoch extends Error {
  readonly statusCode = 409;
  constructor() { super('The universe privacy epoch changed; this proposal is discarded'); this.name = 'SemanticStaleEpoch'; }
}

export type ProposalResult = {
  proposalId: string;
  status: 'admitted' | 'rejected';
  decision: BridgeDecision;
  bridgeId: string | null;
  /** True when an identical proposal from the same proposer was already decided. */
  replayed: boolean;
};

/** A universe-scoped caller must already hold the universe lock (authenticateAndLock). */
async function lockForScope(client: pg.PoolClient, scope: SemanticScope): Promise<void> {
  if (scope.kind === 'shared') { await lockSubstrateExclusive(client); return; }
  const row = (await client.query<{ privacy_epoch: number }>('SELECT privacy_epoch FROM universe WHERE id=$1', [scope.universeId])).rows[0];
  if (!row || row.privacy_epoch !== scope.privacyEpoch) throw new SemanticStaleEpoch();
  await lockSubstrateShared(client);
}

export async function submitBridgeProposal(
  client: pg.PoolClient,
  input: { scope: SemanticScope; proposerKind: ProposerKind; proposerRef: string; payload: unknown },
): Promise<ProposalResult> {
  const parsed = bridgeProposalPayload.safeParse(input.payload);
  if (!parsed.success) throw new SemanticInputError(`Invalid bridge proposal: ${parsed.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  const payload: BridgeProposalPayload = parsed.data;
  const payloadSha = sha256(canonicalJson(payload));

  await lockForScope(client, input.scope);
  const universeId = input.scope.kind === 'universe' ? input.scope.universeId : null;
  // Replay identity is per scope: another universe's identical proposal is not this one.
  const existing = (await client.query(
    `SELECT id, status, decision, (SELECT id FROM bridge WHERE proposal_id = p.id) AS bridge_id
     FROM semantic_proposal p WHERE proposer_kind=$1 AND proposer_ref=$2 AND payload_sha256=$3 AND universe_id IS NOT DISTINCT FROM $4`,
    [input.proposerKind, input.proposerRef, payloadSha, universeId],
  )).rows[0];
  if (existing) return { proposalId: existing.id, status: existing.status, decision: existing.decision, bridgeId: existing.bridge_id, replayed: true };

  const privacyEpoch = input.scope.kind === 'universe' ? input.scope.privacyEpoch : null;
  const readSet = await loadBridgeReadSet(client, universeId);
  const decision = validateBridgeProposal(payload, readSet);
  const slice = sliceReadSet(payload, readSet);

  const proposalId = randomUUID();
  await client.query(
    `INSERT INTO semantic_proposal(id,kind,scope_kind,universe_id,privacy_epoch,proposer_kind,proposer_ref,payload,payload_sha256,read_set,status,decision,validator_version)
     VALUES($1,'bridge_candidate',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [proposalId, input.scope.kind, universeId, privacyEpoch, input.proposerKind, input.proposerRef,
      JSON.stringify(payload), payloadSha, JSON.stringify(slice), decision.outcome, JSON.stringify(decision), decision.validatorVersion],
  );
  if (decision.outcome !== 'admitted') return { proposalId, status: 'rejected', decision, bridgeId: null, replayed: false };

  const bridgeId = randomUUID();
  await client.query(
    `INSERT INTO bridge(id,proposal_id,scope_kind,universe_id,privacy_epoch,from_concept_id,to_concept_id,relation_type,mechanism,prerequisites,limitations,counterevidence,validator_version)
     SELECT $1,$2,$3,$4,$5,f.id,t.id,$8,$9,$10,$11,$12,$13 FROM concept f, concept t WHERE f.code=$6 AND t.code=$7`,
    [bridgeId, proposalId, input.scope.kind, universeId, privacyEpoch, payload.fromConcept, payload.toConcept, payload.relationType,
      payload.mechanism, JSON.stringify(payload.prerequisites), JSON.stringify(payload.limitations), JSON.stringify(payload.counterevidence), decision.validatorVersion],
  );
  for (const ref of payload.evidence) {
    await client.query(
      `INSERT INTO bridge_evidence(bridge_id,claim_id,supports) SELECT $1, id, $3 FROM claim WHERE key=$2 ON CONFLICT DO NOTHING`,
      [bridgeId, ref.claimKey, ref.supports],
    );
  }
  return { proposalId, status: 'admitted', decision, bridgeId, replayed: false };
}
