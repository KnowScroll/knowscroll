/**
 * #133 — `composer-semantic-v3` against real PostgreSQL and the real Fastify app (ADR-0032): the
 * recorded candidate set and context, "why" read back exactly as decided, the private personal
 * model updated in the transaction that records a voluntary act, the next encounter grounded in
 * that act, journey G correction, the database's own refusal of a self-contradicting decision,
 * pause, and Clear/Reset erasure with export.
 *
 * Assets are global. Each test marks every Scroll that already exists as kept for its own fresh
 * universe (the production gate, recorded as `gate='kept'`) BEFORE minting its own substrate, so
 * the fixture is the whole eligible pool.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { buildApp } from '../apps/api/src/app.ts';
import { pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import type { EncounterFeedbackReceipt, WhyResponseWire } from '../packages/contracts/src/composer.ts';
import { loadSubstrateSeed } from '../packages/db/src/semantic/seed.ts';
import { makeSemanticFixture, type SemanticFixture } from './helpers/semantic-fixture.ts';
import { submitBridgeProposal } from '../packages/db/src/semantic/proposals.ts';
import { loadV3Policy } from '../packages/db/src/composer/semantic.ts';
import { COMPOSER_V3_POLICY } from '../packages/core/src/composer/semantic.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) {
  throw new Error('Composer v3 tests require an isolated knowscroll_test_* database');
}

const app = buildApp(randomBytes(32).toString('hex'));
after(async () => { await app.close(); await pool.end(); });
const headers = (token: string) => ({ authorization: `Bearer ${token}` });
const fixtureAssets = (f: SemanticFixture) => Object.values(f.assets);

type FeedItem = { assetId: string; title: string; reason: string };
type Feed = { decisionId: string; items: FeedItem[]; privacyEpoch: number };
type Reader = { token: string; universeId: string };

async function reader(): Promise<Reader> {
  const identity = await provisionIdentity();
  const existing = (await pool.query<{ id: string }>("SELECT id FROM asset WHERE kind='Scroll'")).rows.map(r => r.id);
  await pool.query('UPDATE accounts SET kept_asset_ids=$2::uuid[] WHERE universe_id=$1', [identity.scope.universeId, existing]);
  return { token: identity.token, universeId: identity.scope.universeId };
}

async function substrate(): Promise<SemanticFixture> {
  const fixture = await makeSemanticFixture(pool);
  assert.equal((await transaction(client => loadSubstrateSeed(client, fixture.raw))).status, 'loaded');
  return fixture;
}

async function feed(r: Reader): Promise<Feed> {
  const response = await app.inject({ url: '/v1/feed?kinds=Scroll', headers: headers(r.token) });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function why(r: Reader, decisionId: string, assetId: string) {
  return app.inject({ url: `/v1/decisions/${decisionId}/why?assetId=${assetId}`, headers: headers(r.token) });
}

async function expose(r: Reader, decisionId: string, assetId: string): Promise<{ exposureId: string; eventId: string }> {
  const response = await app.inject({ method: 'POST', url: '/v1/exposures', headers: headers(r.token), payload: { decisionId, assetId, clientExposureId: randomUUID() } });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

async function keep(r: Reader, exposureId: string, assetId: string): Promise<{ eventId: string }> {
  const response = await app.inject({ method: 'POST', url: '/v1/interactions', headers: headers(r.token), payload: { clientEventId: randomUUID(), exposureId, assetId, kind: 'keep' } });
  assert.equal(response.statusCode, 202, response.body);
  return response.json();
}

/** Expose exactly `assetId` through a recorded single-item decision, so nothing else this reader
 * has seen depends on the universe-salted tie-break of a cold-start slate. */
async function exposeDirect(r: Reader, assetId: string): Promise<{ exposureId: string; eventId: string }> {
  const asset = (await pool.query(`SELECT id AS "assetId", revision, kind, title, summary, body, source_title AS "sourceTitle", source_url AS "sourceUrl", truth_state AS "truthState" FROM asset WHERE id=$1`, [assetId])).rows[0];
  const decisionId = randomUUID();
  await pool.query(`INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates,privacy_epoch) VALUES($1,$2,0,'semantic-test-fixture',$3::jsonb,0)`,
    [decisionId, r.universeId, JSON.stringify([asset])]);
  return expose(r, decisionId, assetId);
}

async function keepDirect(r: Reader, assetId: string): Promise<{ keepEventId: string }> {
  const exposure = await exposeDirect(r, assetId);
  return { keepEventId: (await keep(r, exposure.exposureId, assetId)).eventId };
}

/** Make a substrate minted before this reader existed eligible for them again. */
async function admit(r: Reader, f: SemanticFixture): Promise<void> {
  await pool.query('UPDATE accounts SET kept_asset_ids=ARRAY(SELECT unnest(kept_asset_ids) EXCEPT SELECT unnest($2::uuid[])) WHERE universe_id=$1', [r.universeId, fixtureAssets(f)]);
}

async function feedback(r: Reader, body: { decisionId: string; assetId: string; kind: 'less_like_this' | 'wrong_connection'; clientFeedbackId?: string; expectedPrivacyEpoch?: number }) {
  return app.inject({ method: 'POST', url: '/v1/encounters/feedback', headers: headers(r.token),
    payload: { clientFeedbackId: body.clientFeedbackId ?? randomUUID(), decisionId: body.decisionId, assetId: body.assetId, kind: body.kind, expectedPrivacyEpoch: body.expectedPrivacyEpoch ?? 0 } });
}


test('the registered composer-semantic-v3 row is exactly the policy the code runs', async () => {
  // Term sizes live in the immutable policy row (packages/core/AGENTS.md); a code-only change fails here.
  assert.deepEqual(await transaction(client => loadV3Policy(client)), COMPOSER_V3_POLICY);
});

test('a v3 feed records every candidate it considered, and "why" reads back exactly what was served', async () => {
  const r = await reader();
  const f = await substrate();
  const served = await feed(r);
  assert.ok(served.items.length >= 1 && served.items.length <= 3);
  for (const item of served.items) assert.ok(fixtureAssets(f).includes(item.assetId), 'only the fixture is eligible');

  const decision = (await pool.query('SELECT ranking_version, policy_version FROM decision WHERE id=$1', [served.decisionId])).rows[0];
  assert.equal(decision.ranking_version, 'composer-semantic-v3');
  const context = (await pool.query('SELECT policy_version, exploration_due, quotas FROM decision_context WHERE decision_id=$1', [served.decisionId])).rows[0];
  assert.equal(context.policy_version, 'composer-semantic-v3');

  const ranked = (await pool.query('SELECT asset_id, family, rank FROM decision_candidate WHERE decision_id=$1 AND rank IS NOT NULL ORDER BY rank', [served.decisionId])).rows;
  assert.deepEqual(ranked.map(x => x.asset_id), served.items.map(x => x.assetId), 'ranks follow the served order');
  // Cold start: every served encounter is a first door into this substrate's one domain.
  assert.deepEqual([...new Set(ranked.map(x => x.family))], ['seed']);

  // Every fixture asset was considered; the unannotated one only as honest fallback; the rest of
  // the library is recorded as kept, never silently dropped.
  const considered = (await pool.query('SELECT asset_id, family, gate FROM decision_candidate WHERE decision_id=$1', [served.decisionId])).rows;
  for (const id of fixtureAssets(f)) assert.ok(considered.some(c => c.asset_id === id), `candidate ${id} was recorded`);
  assert.deepEqual(considered.filter(c => c.asset_id === f.assets.unannotated).map(c => c.family), ['fallback']);
  assert.ok(considered.filter(c => !fixtureAssets(f).includes(c.asset_id)).every(c => c.gate === 'kept'));

  for (const item of served.items) {
    const response = await why(r, served.decisionId, item.assetId);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as WhyResponseWire;
    assert.equal(body.reason, item.reason, 'the explanation is the one that was served');
    assert.equal(body.family, 'seed');
    assert.equal(body.policyVersion, 'composer-semantic-v3');
    assert.deepEqual(body.corrections, ['less_like_this']);
    assert.equal(body.evidence[0]?.kind, 'outside');
  }

  // A gated candidate was never served, so it has no "why"; nor does another reader's decision.
  const gated = considered.find(c => c.gate === 'kept')!;
  assert.equal((await why(r, served.decisionId, gated.asset_id)).statusCode, 404);
  assert.equal((await why(await reader(), served.decisionId, served.items[0]!.assetId)).statusCode, 404);
  assert.equal((await app.inject({ url: `/v1/decisions/not-a-uuid/why?assetId=${served.items[0]!.assetId}`, headers: headers(r.token) })).statusCode, 400);
});

test('a trip tells the feed what it already opened: those are gated with a named reason, never served', async () => {
  const r = await reader();
  const f = await substrate();
  const opened = [f.assets.gravity, f.assets.star];
  const response = await app.inject({ url: `/v1/feed?kinds=Scroll&exclude=${opened.join(',')}`, headers: headers(r.token) });
  assert.equal(response.statusCode, 200, response.body);
  const served = response.json() as Feed;
  assert.ok(served.items.every(i => !opened.includes(i.assetId)), 'nothing already opened is served');
  const gates = (await pool.query('SELECT DISTINCT gate FROM decision_candidate WHERE decision_id=$1 AND asset_id = ANY($2::uuid[])', [served.decisionId, opened])).rows.map(x => x.gate);
  assert.deepEqual(gates, ['current_encounter']);
  assert.equal((await app.inject({ url: `/v1/feed?kinds=Scroll&exclude=${opened[0]}&exclude=${opened[1]}`, headers: headers(r.token) })).statusCode, 400, 'a repeated parameter is refused, not a 500');
  for (const bad of ['not-a-uuid', Array.from({ length: 257 }, () => randomUUID()).join(',')]) {
    assert.equal((await app.inject({ url: `/v1/feed?kinds=Scroll&exclude=${bad}`, headers: headers(r.token) })).statusCode, 400);
  }
});

test('a keep updates the private model in the same request, and the next encounter crosses a sourced bridge citing that keep', async () => {
  const r = await reader();
  const f = await substrate();
  const { keepEventId } = await keepDirect(r, f.assets.gravity);

  const account = (await pool.query(
    `SELECT a.episodes, a.voluntary, a.state FROM attention_account a JOIN concept c ON c.id=a.concept_id WHERE a.universe_id=$1 AND c.code=$2`,
    [r.universeId, f.codes.gravity])).rows[0];
  assert.ok(account, 'the keep produced an attention account');
  assert.equal(account.voluntary, 1);
  assert.equal(account.state, 'seen', 'one act never anchors');
  assert.ok(Number((await pool.query('SELECT count(*) FROM attention_transition WHERE universe_id=$1', [r.universeId])).rows[0].count) >= 1);

  const next = await feed(r);
  const head = next.items[0]!;
  assert.equal(head.assetId, f.assets.tides, 'gravity explains tides is the admitted continuation');
  const explained = (await why(r, next.decisionId, head.assetId)).json() as WhyResponseWire;
  assert.equal(explained.family, 'bridge');
  assert.deepEqual(explained.corrections, ['less_like_this', 'wrong_connection']);
  const mark = explained.evidence.find(s => s.kind === 'mark');
  assert.ok(mark && mark.kind === 'mark' && mark.eventId === keepEventId && mark.markKind === 'keep', 'the evidence path names the recorded keep');
  assert.ok(explained.evidence.some(s => s.kind === 'bridge' && s.sentence === 'Gravity explains Tides'));
  assert.match(explained.reason, /^A sourced connection from “.+”: Gravity explains Tides\.$/);
  const bridge = (await pool.query(
    `SELECT dc.bridge_id FROM decision_candidate dc WHERE dc.decision_id=$1 AND dc.asset_id=$2 AND dc.rank=1`, [next.decisionId, head.assetId])).rows[0];
  assert.ok(bridge.bridge_id, 'the served bridge is recorded on the candidate');
});

test('an Ask opens a revisable question that cites it, and the next composition continues from it', async () => {
  const r = await reader();
  const f = await substrate();
  const exposure = await exposeDirect(r, f.assets.gravity);
  const asked = await app.inject({ method: 'POST', url: '/v1/asks', headers: headers(r.token),
    payload: { clientAskId: randomUUID(), exposureId: exposure.exposureId, expectedPrivacyEpoch: 0, question: 'Why does the pull weaken with distance?' } });
  assert.ok(asked.statusCode === 201 || asked.statusCode === 202, asked.body);
  const askEventId = asked.json().eventId as string;

  const hypothesis = (await pool.query(
    `SELECT h.kind, h.status, h.permitted_uses, h.evidence, h.alternatives, h.proposer_kind FROM personal_hypothesis h JOIN concept c ON c.id=h.concept_id
     WHERE h.universe_id=$1 AND c.code=$2`, [r.universeId, f.codes.gravity])).rows;
  const question = hypothesis.find(h => h.kind === 'open_question');
  assert.ok(question, 'the Ask opened a question hypothesis in the same request');
  assert.equal(question.status, 'active');
  assert.equal(question.proposer_kind, 'rule');
  assert.deepEqual(question.permitted_uses, ['composer.continuity'], 'a question may ask for continuity, never shape ranking');
  assert.deepEqual(question.evidence, [{ kind: 'ask', ref: askEventId }]);
  assert.ok(question.alternatives.length >= 1, 'a competing explanation is stated');
  assert.ok(!hypothesis.some(h => h.kind === 'direction'), 'one Ask is not a direction');

  const next = await feed(r);
  const continued = (await pool.query(
    `SELECT dc.gate FROM decision_candidate dc JOIN concept c ON c.id=dc.concept_id
     WHERE dc.decision_id=$1 AND dc.explanation_key='v3_question' AND c.code=$2`, [next.decisionId, f.codes.gravity])).rows;
  assert.ok(continued.length >= 1, 'the composition considered continuing the open question');
});

test('"less like this" suppresses that route for this reader only; retries replay; misuse is refused', async () => {
  const r = await reader();
  const f = await substrate();
  await keepDirect(r, f.assets.gravity);
  const next = await feed(r);
  const head = next.items[0]!;
  assert.equal(head.assetId, f.assets.tides);
  const route = (await pool.query('SELECT bridge_id FROM decision_candidate WHERE decision_id=$1 AND rank=1', [next.decisionId])).rows[0].bridge_id as string;

  const key = randomUUID();
  const first = await feedback(r, { decisionId: next.decisionId, assetId: head.assetId, kind: 'less_like_this', clientFeedbackId: key });
  assert.equal(first.statusCode, 201, first.body);
  const receipt = first.json() as EncounterFeedbackReceipt;
  assert.deepEqual({ family: receipt.suppressed.family, concept: receipt.suppressed.concept, bridgeId: receipt.suppressed.bridgeId },
    { family: 'bridge', concept: f.codes.tides, bridgeId: route });
  const days = (Date.parse(receipt.suppressed.until) - Date.now()) / 86_400_000;
  assert.ok(days > 13.9 && days <= 14, `suppressed for the policy period (${days})`);

  const retry = await feedback(r, { decisionId: next.decisionId, assetId: head.assetId, kind: 'less_like_this', clientFeedbackId: key });
  assert.equal(retry.statusCode, 201);
  assert.equal((retry.json() as EncounterFeedbackReceipt).feedbackId, receipt.feedbackId, 'an exact retry replays the receipt');
  const again = await feedback(r, { decisionId: next.decisionId, assetId: head.assetId, kind: 'less_like_this' });
  assert.equal((again.json() as EncounterFeedbackReceipt).feedbackId, receipt.feedbackId, 'the same correction under a new key is the same act');
  assert.deepEqual(((await why(r, next.decisionId, head.assetId)).json() as WhyResponseWire).corrected, ['less_like_this'], 'why says what was already corrected');
  assert.equal((await feedback(r, { decisionId: next.decisionId, assetId: head.assetId, kind: 'wrong_connection', clientFeedbackId: key })).statusCode, 409);
  assert.equal((await feedback(r, { decisionId: next.decisionId, assetId: head.assetId, kind: 'less_like_this', expectedPrivacyEpoch: 1 })).statusCode, 409);
  assert.equal((await feedback(r, { decisionId: randomUUID(), assetId: head.assetId, kind: 'less_like_this' })).statusCode, 422);

  const after = await feed(r);
  const routes = (await pool.query('SELECT family, bridge_id FROM decision_candidate WHERE decision_id=$1', [after.decisionId])).rows;
  assert.ok(!routes.some(c => c.bridge_id === route), 'the suppressed connection is no longer offered to this reader');
  assert.equal(Number((await pool.query('SELECT count(*) FROM encounter_feedback WHERE universe_id=$1', [r.universeId])).rows[0].count), 1);

  // Another reader who kept the same idea is still offered the connection: nothing shared changed.
  const other = await reader();
  await admit(other, f);
  await keepDirect(other, f.assets.gravity);
  assert.equal((await feed(other)).items[0]!.assetId, f.assets.tides);
  assert.equal((await pool.query('SELECT status FROM bridge WHERE id=$1', [route])).rows[0].status, 'admitted');
});

test('only a connection can be wrong, and an unmapped encounter has no route to correct', async () => {
  const r = await reader();
  const f = await substrate();
  const served = await feed(r);
  const seedItem = served.items[0]!;
  assert.equal((await feedback(r, { decisionId: served.decisionId, assetId: seedItem.assetId, kind: 'wrong_connection' })).statusCode, 422);

  // Keep everything annotated so the unannotated Scroll is served, as fallback.
  const annotated = fixtureAssets(f).filter(id => id !== f.assets.unannotated);
  await pool.query('UPDATE accounts SET kept_asset_ids=kept_asset_ids || $2::uuid[] WHERE universe_id=$1', [r.universeId, annotated]);
  const fallback = await feed(r);
  assert.deepEqual(fallback.items.map(i => i.assetId), [f.assets.unannotated]);
  const explained = (await why(r, fallback.decisionId, f.assets.unannotated)).json() as WhyResponseWire;
  assert.equal(explained.family, 'fallback');
  assert.deepEqual(explained.corrections, []);
  assert.equal((await feedback(r, { decisionId: fallback.decisionId, assetId: f.assets.unannotated, kind: 'less_like_this' })).statusCode, 422);
});

test('the database refuses a v3 decision that contradicts itself', async () => {
  const r = await reader();
  const f = await substrate();
  const assetRow = async (id: string) => (await pool.query(`SELECT id AS "assetId", title FROM asset WHERE id=$1`, [id])).rows[0];
  const items = [await assetRow(f.assets.gravity), await assetRow(f.assets.star)];
  const attempt = async (build: (client: import('pg').PoolClient, decisionId: string) => Promise<void>) => transaction(async client => {
    const decisionId = randomUUID();
    honest ??= decisionId;
    await client.query(`INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates,privacy_epoch,ranking_version) VALUES($1,$2,0,'semantic-retrieval-v3',$3,0,'composer-semantic-v3')`,
      [decisionId, r.universeId, JSON.stringify(items)]);
    await build(client, decisionId);
  });
  const context = (client: import('pg').PoolClient, decisionId: string, quotas: string[] = []) => client.query(
    `INSERT INTO decision_context(decision_id,universe_id,policy_version,seed,composed_at,served_window,quotas,exploration_due) VALUES($1,$2,'composer-semantic-v3','s',clock_timestamp(),'[]',$3,false)`,
    [decisionId, r.universeId, JSON.stringify(quotas)]);
  const withClient = (client: import('pg').PoolClient) => (decisionId: string, assetId: string, extra: { rank: number | null; score: number; gate?: string | null }) => client.query(
    `INSERT INTO decision_candidate(id,decision_id,universe_id,asset_id,family,gate,terms,score,rank,explanation_key,facts,evidence)
     VALUES($1,$2,$3,$4,'seed',$5,'{}',$6,$7,'v3_seed','{}','[]')`, [randomUUID(), decisionId, r.universeId, assetId, extra.gate ?? null, extra.score, extra.rank]);

  let honest: string | undefined;
  // The honest shape commits.
  await attempt(async (client, id) => { await context(client, id); await withClient(client)(id, f.assets.gravity, { rank: 1, score: 2 }); await withClient(client)(id, f.assets.star, { rank: 2, score: 1 }); });
  await assert.rejects(attempt(async (client, id) => { await withClient(client)(id, f.assets.gravity, { rank: 1, score: 2 }); await withClient(client)(id, f.assets.star, { rank: 2, score: 1 }); }),
    /must record its served window and quotas/);
  await assert.rejects(attempt(async (client, id) => { await context(client, id); await withClient(client)(id, f.assets.gravity, { rank: 1, score: 2 }); }),
    /rank exactly the candidates it returned/);
  await assert.rejects(attempt(async (client, id) => { await context(client, id); await withClient(client)(id, f.assets.gravity, { rank: 1, score: 2 }); await withClient(client)(id, f.assets.star, { rank: 3, score: 1 }); }),
    /densely from 1/);
  await assert.rejects(attempt(async (client, id) => { await context(client, id); await withClient(client)(id, f.assets.gravity, { rank: 1, score: 2, gate: 'kept' }); }),
    /decision_candidate_check/);
  await assert.rejects(attempt(async (client, id) => { await context(client, id); await withClient(client)(id, f.assets.gravity, { rank: 1, score: 1 }); await withClient(client)(id, f.assets.star, { rank: 2, score: 2 }); }),
    /must record the quota that chose it/);
  // A quota may put a lower-scoring head first, and says so.
  // …but only a quota that could have chosen that head: the floor for its own family.
  await assert.rejects(attempt(async (client, id) => { await context(client, id, ['exploration_floor:bridge']); await withClient(client)(id, f.assets.gravity, { rank: 1, score: 1 }); await withClient(client)(id, f.assets.star, { rank: 2, score: 2 }); }),
    /must record the quota that chose it/);
  await attempt(async (client, id) => { await context(client, id, ['exploration_floor:seed']); await withClient(client)(id, f.assets.gravity, { rank: 1, score: 1 }); await withClient(client)(id, f.assets.star, { rank: 2, score: 2 }); });
  // A recorded decision stays consistent: editing what it returned or removing its context is refused.
  await assert.rejects(transaction(client => client.query(`UPDATE decision SET candidates='[]' WHERE id=$1`, [honest])), /rank exactly the candidates it returned/);
  await assert.rejects(transaction(client => client.query('DELETE FROM decision_context WHERE decision_id=$1', [honest])), /must record its served window and quotas/);
  await assert.rejects(transaction(client => client.query('UPDATE decision SET ranking_version=NULL WHERE id=$1', [honest])), /ranking version is fixed/);
});

test('while recording is paused the feed is still composed and explained, but the private model does not move', async () => {
  const r = await reader();
  const f = await substrate();
  await keepDirect(r, f.assets.gravity);
  const model = async () => ({
    accounts: (await pool.query('SELECT concept_id, mass, mass_at, episodes, state, computed_at FROM attention_account WHERE universe_id=$1 ORDER BY concept_id', [r.universeId])).rows,
    transitions: Number((await pool.query('SELECT count(*) FROM attention_transition WHERE universe_id=$1', [r.universeId])).rows[0].count),
    hypotheses: (await pool.query('SELECT id, revision, revised_at FROM personal_hypothesis WHERE universe_id=$1 ORDER BY id', [r.universeId])).rows,
  });
  const before = await model();
  assert.equal((await app.inject({ method: 'POST', url: '/v1/privacy/pause', headers: headers(r.token), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } })).statusCode, 200);

  const served = await feed(r);
  assert.equal((await why(r, served.decisionId, served.items[0]!.assetId)).statusCode, 200);
  const refused = await app.inject({ method: 'POST', url: '/v1/exposures', headers: headers(r.token), payload: { decisionId: served.decisionId, assetId: served.items[0]!.assetId, clientExposureId: randomUUID() } });
  assert.notEqual(refused.statusCode, 201, 'no exposure is recorded while paused');
  // A correction is not attention, so it stays available while paused.
  assert.equal((await feedback(r, { decisionId: served.decisionId, assetId: served.items[0]!.assetId, kind: 'less_like_this' })).statusCode, 201);
  // Nothing is recomputed or dated inside the pause; the correction is counted when recording resumes.
  assert.deepEqual(await model(), before);
});

test('Clear succeeds after a v3 decision recorded a candidate reached through the reader\'s own bridge', async () => {
  const r = await reader();
  const f = await makeSemanticFixture(pool, { personal: ['balance_homeostasis'] });
  assert.equal((await transaction(client => loadSubstrateSeed(client, f.raw))).status, 'loaded');
  const own = await transaction(async client => {
    await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [r.universeId]);
    return submitBridgeProposal(client, { scope: { kind: 'universe', universeId: r.universeId, privacyEpoch: 0 }, proposerKind: 'person', proposerRef: 'own-v3', payload: f.personal.balance_homeostasis });
  });
  assert.equal(own.status, 'admitted');
  await keepDirect(r, f.assets.star);
  const next = await feed(r);
  const recorded = (await pool.query('SELECT count(*) FROM decision_candidate WHERE decision_id=$1 AND bridge_id=$2', [next.decisionId, own.bridgeId])).rows[0].count;
  assert.ok(Number(recorded) >= 1, 'the personal bridge shaped a recorded candidate');
  const cleared = await app.inject({ method: 'POST', url: '/v1/history/clear', headers: headers(r.token),
    payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'clear-scroll-history' } });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(Number((await pool.query('SELECT count(*) FROM bridge WHERE id=$1', [own.bridgeId])).rows[0].count), 0);
});

for (const operation of ['clear', 'reset'] as const) {
  test(`${operation} erases the personal model and every v3 record, after export carried them`, async () => {
    const r = await reader();
    const f = await substrate();
    await keepDirect(r, f.assets.gravity);
    const next = await feed(r);
    assert.equal((await feedback(r, { decisionId: next.decisionId, assetId: next.items[0]!.assetId, kind: 'less_like_this' })).statusCode, 201);

    const exported = await app.inject({ method: 'POST', url: '/v1/privacy/export', headers: headers(r.token), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } });
    assert.equal(exported.statusCode, 200, exported.body);
    const body = exported.json();
    assert.ok(body.personalModel.attentionAccounts.length >= 1);
    assert.equal(body.personalModel.encounterFeedback.length, 1);
    assert.equal(body.rowCounts.encounterFeedback, 1);

    const result = await app.inject({ method: 'POST', url: operation === 'clear' ? '/v1/history/clear' : '/v1/privacy/reset', headers: headers(r.token),
      payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: operation === 'clear' ? 'clear-scroll-history' : 'reset-personal-universe' } });
    assert.equal(result.statusCode, 200, result.body);
    for (const table of ['attention_account', 'attention_transition', 'personal_hypothesis', 'encounter_feedback', 'decision_candidate', 'decision_context']) {
      assert.equal(Number((await pool.query(`SELECT count(*) FROM ${table} WHERE universe_id=$1`, [r.universeId])).rows[0].count), 0, `${table} erased`);
    }
    if (operation === 'reset') {
      // Reset also ends every session, the caller's included.
      assert.equal((await app.inject({ url: '/v1/feed?kinds=Scroll', headers: headers(r.token) })).statusCode, 401);
      return;
    }
    // After Clear the next encounter starts cold: nothing the reader did survives to steer it.
    const cold = await feed(r);
    const families = (await pool.query('SELECT DISTINCT family FROM decision_candidate WHERE decision_id=$1 AND rank IS NOT NULL', [cold.decisionId])).rows.map(x => x.family);
    assert.ok(families.every(x => x === 'seed' || x === 'fallback'), `cold start after ${operation}: ${families}`);
  });
}
