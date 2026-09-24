/**
 * #131/#134 — the first personal consumer of the substrate: live continuations for one encounter.
 *
 * `listEncounterBranches` offers a continuation only along an admitted, non-suppressed bridge that
 * touches what this encounter is about, to an editorial Scroll about the other side. There is no
 * fallback to unrelated inventory: an empty list says why it is empty.
 *
 * `openBranch` is an explicit request (target 08 §8): it bypasses ranking, re-checks the chosen
 * branch against the current substrate under the locks, serves the target through an ordinary
 * `decision` so its exposure is admitted like any selection, and — unless recording is paused —
 * records a `branch` Ledger event caused by the exposure it started from. That event is the
 * voluntary-act evidence later Accounts/Cartographer work reads; it proves nothing about belief.
 */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { ScrollAsset } from '../../../contracts/src/index.ts';
import {
  SYMMETRIC_BRIDGE_TYPES,
  branchOpenInput,
  connectionFeedbackInput,
  type BranchOpenResponse,
  type BridgeRelationType,
  type ConnectionFeedbackReceipt,
  type EncounterBranchesResponse,
  type EncounterBranchWire,
} from '../../../contracts/src/semantic.ts';
import { isWithin } from '../../../core/src/semantic/bridge-validator.ts';
import { recheckScope, type AuthScope } from '../identity.ts';
import { lockSubstrateShared } from './read-set.ts';
import { SemanticInputError } from './proposals.ts';
import { SemanticNotFound } from './corrections.ts';

export const BRANCH_POLICY_VERSION = 'branch-bridge-v1';
const MAX_BRANCHES = 4;
const RELATION_ORDER: BridgeRelationType[] = ['explains', 'prerequisite_for', 'applies_to', 'compares_mechanism', 'analogous_in'];

export class SemanticConflict extends Error {
  readonly statusCode = 409;
  constructor(message: string) { super(message); this.name = 'SemanticConflict'; }
}
export class SemanticUnprocessable extends Error {
  readonly statusCode = 422;
  constructor(message: string) { super(message); this.name = 'SemanticUnprocessable'; }
}

const PHRASES: Record<BridgeRelationType, { forward: string; reverse: string }> = {
  explains: { forward: 'explains', reverse: 'is explained by' },
  prerequisite_for: { forward: 'comes before understanding', reverse: 'builds on' },
  applies_to: { forward: 'applies to', reverse: 'is an application of' },
  compares_mechanism: { forward: 'works like', reverse: 'works like' },
  analogous_in: { forward: 'is like', reverse: 'is like' },
};

function stableUuid(text: string): string {
  const b = createHash('sha256').update(`knowscroll-branch:${text}`).digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

type BridgeRow = {
  id: string; relation_type: BridgeRelationType; mechanism: string; limitations: EncounterBranchWire['limitations'];
  prerequisites: { statement: string }[]; from_code: string; from_name: string; to_code: string; to_name: string;
};
type TargetRow = { asset_id: string; revision: number; kind: 'Scroll' | 'Reel'; title: string; summary: string; source_title: string; editorial_order: number; code: string; role: string; claim_keys: string[]; seen: boolean };

async function conceptTree(client: pg.PoolClient) {
  const rows = (await client.query<{ code: string; parent_code: string | null }>(
    'SELECT c.code, p.code AS parent_code FROM concept c LEFT JOIN concept p ON p.id = c.parent_id',
  )).rows;
  return { concepts: new Map(rows.map(r => [r.code, { code: r.code, name: '', description: '', parentCode: r.parent_code }])) };
}

/** `pin` checks one exact (bridge, target) pair for validity instead of ranking: an opened branch
 * must still be a valid continuation, not still be among the top-ranked ones. */
export async function listEncounterBranches(
  client: pg.PoolClient, scope: AuthScope, assetId: string, pin?: { bridgeId: string; targetAssetId: string },
): Promise<EncounterBranchesResponse> {
  const asset = (await client.query<{ id: string; revision: number }>('SELECT id, revision FROM asset WHERE id=$1', [assetId])).rows[0];
  if (!asset) throw new SemanticNotFound('Encounter not found');
  const base = { assetId, revision: asset.revision, privacyEpoch: scope.privacyEpoch };

  const own = (await client.query<{ code: string; role: string }>(
    `SELECT co.code, ac.role FROM asset_concept ac JOIN concept co ON co.id = ac.concept_id WHERE ac.asset_id = $1 AND ac.role IN ('primary','secondary')`,
    [assetId],
  )).rows;
  if (own.length === 0) return { ...base, branches: [], emptyReason: 'no_semantic_annotation' };

  const tree = await conceptTree(client);
  // A bridge applies to this encounter only when the encounter is about that side or a narrower
  // part of it. A broader concept (a Scroll that merely involves the Sun) does not make a bridge
  // about one specific aspect (the Sun's energy output) a continuation of it — that was the
  // tenuous leap the first emulator journey surfaced.
  const touches = (side: string) => own.some(o => isWithin(tree, o.code, side));
  const bridges = (await client.query<BridgeRow>(
    `SELECT b.id, b.relation_type, b.mechanism, b.limitations, b.prerequisites,
            f.code AS from_code, f.name AS from_name, t.code AS to_code, t.name AS to_name
     FROM bridge b JOIN concept f ON f.id = b.from_concept_id JOIN concept t ON t.id = b.to_concept_id
     WHERE b.status = 'admitted' AND (b.universe_id IS NULL OR b.universe_id = $1)
       AND NOT EXISTS (SELECT 1 FROM connection_feedback cf WHERE cf.universe_id = $1 AND cf.bridge_id = b.id)
     ORDER BY b.id`,
    [scope.universeId],
  )).rows;

  const travels: { bridge: BridgeRow; direction: 'forward' | 'reverse'; destination: string }[] = [];
  for (const bridge of bridges) {
    if (pin && bridge.id !== pin.bridgeId) continue;
    const symmetric = SYMMETRIC_BRIDGE_TYPES.includes(bridge.relation_type);
    if (touches(bridge.from_code)) travels.push({ bridge, direction: 'forward', destination: bridge.to_code });
    else if (touches(bridge.to_code)) travels.push({ bridge, direction: symmetric ? 'forward' : 'reverse', destination: bridge.from_code });
  }
  if (travels.length === 0) return { ...base, branches: [], emptyReason: 'no_admitted_bridge' };

  const targets = (await client.query<TargetRow>(
    `SELECT a.id AS asset_id, a.revision, a.kind, a.title, a.summary, a.source_title, a.editorial_order, co.code, ac.role,
            COALESCE((SELECT array_agg(cl.key ORDER BY cl.key) FROM asset_claim x JOIN claim cl ON cl.id = x.claim_id WHERE x.asset_id = a.id), '{}') AS claim_keys,
            EXISTS (SELECT 1 FROM exposure e WHERE e.universe_id = $2 AND e.asset_id = a.id) AS seen
     FROM asset a JOIN asset_concept ac ON ac.asset_id = a.id JOIN concept co ON co.id = ac.concept_id
     WHERE a.kind = 'Scroll' AND a.id <> $1 AND ac.role IN ('primary','secondary')`,
    [assetId, scope.universeId],
  )).rows;

  const branches: EncounterBranchWire[] = [];
  for (const travel of travels) {
    const evidence = (await client.query<{ key: string; statement: string; supports: EncounterBranchWire['evidence'][number]['supports']; source_title: string; source_url: string }>(
      `SELECT DISTINCT ON (cl.key, e.supports) cl.key, cl.statement, e.supports, s.title AS source_title, s.url AS source_url
       FROM bridge_evidence e JOIN claim cl ON cl.id = e.claim_id
       JOIN claim_support cs ON cs.claim_id = cl.id AND cs.support_kind = 'supports'
       JOIN source_snapshot ss ON ss.id = cs.snapshot_id AND ss.status = 'current'
       JOIN semantic_source s ON s.id = ss.source_id
       WHERE e.bridge_id = $1 ORDER BY cl.key, e.supports, s.key`,
      [travel.bridge.id],
    )).rows;
    // Everything about orientation follows from one fact: is the reader heading to the bridge's
    // `to` side (forward, or a symmetric bridge read from its from side) or back to its `from` side.
    const toward = travel.destination === travel.bridge.to_code;
    const destinationSide = toward ? 'to' : 'from';
    const citedForDestination = new Set(evidence.filter(e => e.supports === destinationSide || e.supports === 'mechanism').map(e => e.key));
    const candidates = targets.filter(t => isWithin(tree, t.code, travel.destination) && (!pin || t.asset_id === pin.targetAssetId));
    if (candidates.length === 0) continue;
    const rank = (t: TargetRow) => [
      t.claim_keys.some(k => citedForDestination.has(k)) ? 0 : 1,
      t.role === 'primary' ? 0 : 1,
      t.seen ? 1 : 0,
      t.editorial_order,
    ];
    candidates.sort((a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i]! - y[i]!; return a.asset_id.localeCompare(b.asset_id); });
    const target = candidates[0]!;
    const [fromCode, fromName, toCode, toName] = toward
      ? [travel.bridge.from_code, travel.bridge.from_name, travel.bridge.to_code, travel.bridge.to_name]
      : [travel.bridge.to_code, travel.bridge.to_name, travel.bridge.from_code, travel.bridge.from_name];
    branches.push({
      branchId: stableUuid(`${travel.bridge.id}:${target.asset_id}:${travel.direction}`),
      bridgeId: travel.bridge.id,
      relationType: travel.bridge.relation_type,
      direction: travel.direction,
      relationPhrase: PHRASES[travel.bridge.relation_type][travel.direction],
      fromConcept: { code: fromCode, name: fromName },
      toConcept: { code: toCode, name: toName },
      mechanism: travel.bridge.mechanism,
      limitations: travel.bridge.limitations,
      prerequisites: travel.bridge.prerequisites.map(p => p.statement),
      evidence: evidence.map(e => ({ claimKey: e.key, statement: e.statement, supports: e.supports, sourceTitle: e.source_title, sourceUrl: e.source_url })),
      target: { assetId: target.asset_id, revision: target.revision, kind: target.kind, title: target.title, summary: target.summary, sourceTitle: target.source_title },
      seen: target.seen,
    });
  }
  if (branches.length === 0) return { ...base, branches: [], emptyReason: 'no_eligible_target' };
  branches.sort((a, b) => Number(a.seen) - Number(b.seen)
    || RELATION_ORDER.indexOf(a.relationType) - RELATION_ORDER.indexOf(b.relationType)
    || a.bridgeId.localeCompare(b.bridgeId));
  return { ...base, branches: branches.slice(0, MAX_BRANCHES), emptyReason: null };
}

function reasonFor(branch: EncounterBranchWire): string {
  return `A connection you chose: ${branch.fromConcept.name} ${branch.relationPhrase} ${branch.toConcept.name}.`;
}

/** The caller holds the universe lock (authenticateAndLock). */
export async function openBranch(client: pg.PoolClient, scope: AuthScope, raw: unknown): Promise<BranchOpenResponse> {
  const parsed = branchOpenInput.safeParse(raw);
  if (!parsed.success) throw new SemanticInputError('Invalid branch request');
  const input = parsed.data;
  if (input.expectedPrivacyEpoch !== scope.privacyEpoch) throw new SemanticConflict('Branch privacy epoch is stale');

  const accountRow = (await client.query<{ revision: number }>('SELECT revision FROM accounts WHERE universe_id=$1', [scope.universeId])).rows[0];
  if (!accountRow) throw new Error('Universe accounts state is missing');

  const replay = (await client.query(
    `SELECT b.id, b.from_exposure_id, b.bridge_id, b.target_asset_id, b.decision_id, d.candidates, d.account_revision, br.relation_type, l.payload->>'direction' AS direction
     FROM branch_open b JOIN decision d ON d.id = b.decision_id JOIN bridge br ON br.id = b.bridge_id JOIN ledger l ON l.id = b.event_id
     WHERE b.universe_id=$1 AND b.client_key=$2`,
    [scope.universeId, input.clientBranchId],
  )).rows[0];
  if (replay) {
    if (replay.from_exposure_id !== input.fromExposureId || replay.bridge_id !== input.bridgeId || replay.target_asset_id !== input.targetAssetId) {
      throw new SemanticConflict('Branch key reused with different content');
    }
    return {
      decisionId: replay.decision_id, universeId: scope.universeId, accountRevision: replay.account_revision, privacyEpoch: scope.privacyEpoch,
      items: replay.candidates,
      branch: { branchOpenId: replay.id, recorded: true, bridgeId: replay.bridge_id, relationType: replay.relation_type, direction: replay.direction },
    };
  }

  const origin = (await client.query<{ asset_id: string; event_id: string; privacy_epoch: number }>(
    'SELECT e.asset_id, e.event_id, l.privacy_epoch FROM exposure e JOIN ledger l ON l.id = e.event_id WHERE e.id=$1 AND e.universe_id=$2',
    [input.fromExposureId, scope.universeId],
  )).rows[0];
  if (!origin) throw new SemanticUnprocessable('A matching exposure is required');
  if (origin.privacy_epoch !== scope.privacyEpoch) throw new SemanticConflict('Exposure belongs to an older privacy epoch');

  // Recheck against the substrate as it is now: the bridge may have been revoked, suppressed or
  // superseded since the list was shown.
  await lockSubstrateShared(client);
  // The shared lock can wait behind a seed load or a correction; the session may expire meanwhile.
  if (await recheckScope(client, scope) === 'stale_epoch') throw new SemanticConflict('Branch privacy epoch is stale');
  const current = await listEncounterBranches(client, scope, origin.asset_id, { bridgeId: input.bridgeId, targetAssetId: input.targetAssetId });
  const branch = current.branches.find(b => b.bridgeId === input.bridgeId && b.target.assetId === input.targetAssetId);
  if (!branch) throw new SemanticConflict('This continuation is no longer available');

  const target = (await client.query<ScrollAsset>(
    `SELECT id AS "assetId", revision, kind, title, summary, body, source_title AS "sourceTitle", source_url AS "sourceUrl", truth_state AS "truthState"
     FROM asset WHERE id=$1`,
    [input.targetAssetId],
  )).rows[0]!;
  const items = [{ ...target, reason: reasonFor(branch) }];

  // While recording is paused nothing is kept — not the choice, not a decision naming it. The
  // continuation is served for reading only; its exposure and Keep are refused by the pause anyway.
  const paused = (await client.query<{ paused: boolean }>('SELECT recording_paused_at IS NOT NULL AS paused FROM universe WHERE id=$1', [scope.universeId])).rows[0]!.paused;
  if (paused) {
    return {
      decisionId: null, universeId: scope.universeId, accountRevision: accountRow.revision, privacyEpoch: scope.privacyEpoch, items,
      branch: { branchOpenId: null, recorded: false, bridgeId: input.bridgeId, relationType: branch.relationType, direction: branch.direction },
    };
  }
  const decisionId = randomUUID();
  await client.query(
    'INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates,privacy_epoch) VALUES($1,$2,$3,$4,$5,$6)',
    [decisionId, scope.universeId, accountRow.revision, BRANCH_POLICY_VERSION, JSON.stringify(items), scope.privacyEpoch],
  );
  const branchOpenId = randomUUID();
  const eventId = randomUUID();
  await client.query(
    'INSERT INTO ledger(id,universe_id,kind,client_key,causation_id,payload,privacy_epoch) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [eventId, scope.universeId, 'branch', input.clientBranchId, origin.event_id,
      JSON.stringify({ branchOpenId, fromExposureId: input.fromExposureId, bridgeId: input.bridgeId, targetAssetId: input.targetAssetId, decisionId, direction: branch.direction }),
      scope.privacyEpoch],
  );
  await client.query(
    `INSERT INTO branch_open(id,universe_id,privacy_epoch,client_key,event_id,from_exposure_id,bridge_id,decision_id,target_asset_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [branchOpenId, scope.universeId, scope.privacyEpoch, input.clientBranchId, eventId, input.fromExposureId, input.bridgeId, decisionId, input.targetAssetId],
  );
  return {
    decisionId, universeId: scope.universeId, accountRevision: accountRow.revision, privacyEpoch: scope.privacyEpoch, items,
    branch: { branchOpenId, recorded: true, bridgeId: input.bridgeId, relationType: branch.relationType, direction: branch.direction },
  };
}
/** A personal objection. Allowed while recording is paused: it is a correction control, not
 * attention evidence. It suppresses the connection for this universe only. */
export async function recordConnectionFeedback(client: pg.PoolClient, scope: AuthScope, raw: unknown): Promise<ConnectionFeedbackReceipt> {
  const parsed = connectionFeedbackInput.safeParse(raw);
  if (!parsed.success) throw new SemanticInputError('Invalid connection feedback');
  const input = parsed.data;
  if (input.expectedPrivacyEpoch !== scope.privacyEpoch) throw new SemanticConflict('Feedback privacy epoch is stale');
  const old = (await client.query('SELECT id, bridge_id, objection FROM connection_feedback WHERE universe_id=$1 AND client_key=$2', [scope.universeId, input.clientFeedbackId])).rows[0];
  if (old) {
    if (old.bridge_id !== input.bridgeId || old.objection !== input.objection) throw new SemanticConflict('Feedback key reused with different content');
    return { feedbackId: old.id, bridgeId: old.bridge_id, objection: old.objection, suppressed: true };
  }
  const visible = (await client.query('SELECT 1 FROM bridge WHERE id=$1 AND (universe_id IS NULL OR universe_id=$2)', [input.bridgeId, scope.universeId])).rowCount;
  if (!visible) throw new SemanticUnprocessable('Unknown connection');
  const feedbackId = randomUUID();
  await client.query(
    'INSERT INTO connection_feedback(id,universe_id,privacy_epoch,client_key,bridge_id,objection) VALUES($1,$2,$3,$4,$5,$6)',
    [feedbackId, scope.universeId, scope.privacyEpoch, input.clientFeedbackId, input.bridgeId, input.objection],
  );
  return { feedbackId, bridgeId: input.bridgeId, objection: input.objection, suppressed: true };
}

/** Clear/Reset (ADR-0010/0030): this universe's semantic history, before exposures and decisions
 * are erased. Shared knowledge is untouched. Takes the substrate lock shared so a concurrent
 * correction cannot interleave with the deletion of rows it might update. */
export async function eraseSemanticHistory(client: pg.PoolClient, universeId: string): Promise<void> {
  await lockSubstrateShared(client);
  await client.query('DELETE FROM branch_open WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM connection_feedback WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM bridge WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM semantic_proposal WHERE universe_id=$1', [universeId]);
}

export async function exportSemanticHistory(client: pg.PoolClient, universeId: string) {
  const q = async (sql: string) => (await client.query(sql, [universeId])).rows;
  return {
    branchOpens: await q('SELECT id,privacy_epoch,from_exposure_id,bridge_id,decision_id,target_asset_id,created_at FROM branch_open WHERE universe_id=$1 ORDER BY created_at'),
    connectionFeedback: await q('SELECT id,privacy_epoch,bridge_id,objection,created_at FROM connection_feedback WHERE universe_id=$1 ORDER BY created_at'),
    proposals: await q('SELECT id,kind,privacy_epoch,proposer_kind,payload,status,decision,decided_at FROM semantic_proposal WHERE universe_id=$1 ORDER BY decided_at'),
    bridges: await q('SELECT id,proposal_id,relation_type,mechanism,status,admitted_at FROM bridge WHERE universe_id=$1 ORDER BY admitted_at'),
  };
}
