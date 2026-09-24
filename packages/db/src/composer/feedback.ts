/**
 * #133/#131 — a reader corrects the system without authoring it (journey G, ADR-0032 §5).
 *
 * "Less like this" suppresses the recorded causal route (family + concept) for this universe for a
 * bounded time and becomes counterevidence for any hypothesis about that concept. "Wrong
 * connection" on a bridge candidate also records ADR-0031's personal suppression of that bridge.
 * Neither retracts shared knowledge. The caller holds the universe lock.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ENCOUNTER_SUPPRESSION_DAYS, encounterFeedbackInput, type EncounterFeedbackReceipt } from '../../../contracts/src/composer.ts';
import type { AuthScope } from '../identity.ts';
import { SemanticConflict, SemanticUnprocessable } from '../semantic/branches.ts';
import { SemanticInputError } from '../semantic/proposals.ts';
import { refreshPersonalModel } from '../semantic/personal-model.ts';

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();

export async function recordEncounterFeedback(client: pg.PoolClient, scope: AuthScope, raw: unknown): Promise<EncounterFeedbackReceipt> {
  const parsed = encounterFeedbackInput.safeParse(raw);
  if (!parsed.success) throw new SemanticInputError('Invalid encounter feedback');
  const input = parsed.data;
  if (input.expectedPrivacyEpoch !== scope.privacyEpoch) throw new SemanticConflict('Feedback privacy epoch is stale');

  const receiptOf = (r: Row): EncounterFeedbackReceipt => ({
    feedbackId: String(r.id), kind: r.kind as EncounterFeedbackReceipt['kind'],
    suppressed: { family: String(r.family), concept: r.code === null ? null : String(r.code), bridgeId: r.bridge_id === null ? null : String(r.bridge_id), until: iso(r.suppress_until) },
  });
  const old = (await client.query<Row>(
    `SELECT f.id, f.kind, f.family, f.bridge_id, f.suppress_until, f.decision_id, f.asset_id, c.code
     FROM encounter_feedback f LEFT JOIN concept c ON c.id = f.concept_id WHERE f.universe_id = $1 AND f.client_key = $2`,
    [scope.universeId, input.clientFeedbackId],
  )).rows[0];
  if (old) {
    if (old.decision_id !== input.decisionId || old.asset_id !== input.assetId || old.kind !== input.kind) throw new SemanticConflict('Feedback key reused with different content');
    return receiptOf(old);
  }

  // The route is what was recorded when this encounter was served — never re-derived now.
  const served = (await client.query<Row>(
    `SELECT dc.family, dc.concept_id, dc.bridge_id FROM decision_candidate dc JOIN decision d ON d.id = dc.decision_id
     WHERE d.id = $1 AND d.universe_id = $2 AND dc.asset_id = $3 AND dc.rank IS NOT NULL AND d.privacy_epoch = $4`,
    [input.decisionId, scope.universeId, input.assetId, scope.privacyEpoch],
  )).rows[0];
  if (!served) throw new SemanticUnprocessable('This encounter was not served by a recorded decision');
  if (served.family === 'fallback') throw new SemanticUnprocessable('An unmapped encounter has no route to correct');
  if (input.kind === 'wrong_connection' && served.bridge_id === null) throw new SemanticUnprocessable('Only a connection can be wrong');

  const id = randomUUID();
  const inserted = (await client.query<Row>(
    `INSERT INTO encounter_feedback(id,universe_id,privacy_epoch,client_key,decision_id,asset_id,kind,family,concept_id,bridge_id,suppress_until)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp() + ($11 * interval '1 day'))
     RETURNING id, kind, family, bridge_id, suppress_until, (SELECT code FROM concept WHERE id = $9) AS code`,
    [id, scope.universeId, scope.privacyEpoch, input.clientFeedbackId, input.decisionId, input.assetId, input.kind, served.family,
      // A bridge route is suppressed either way: "less like this" on a connection means that route.
      served.concept_id, served.bridge_id, ENCOUNTER_SUPPRESSION_DAYS],
  )).rows[0]!;
  if (input.kind === 'wrong_connection') {
    await client.query(
      `INSERT INTO connection_feedback(id,universe_id,privacy_epoch,client_key,bridge_id,objection) VALUES($1,$2,$3,$4,$5,'seems_wrong')
       ON CONFLICT (universe_id, client_key) DO NOTHING`,
      [randomUUID(), scope.universeId, scope.privacyEpoch, input.clientFeedbackId, served.bridge_id],
    );
  }
  await refreshPersonalModel(client, scope.universeId);
  return receiptOf(inserted);
}
