/**
 * #131 — the semantic substrate against real PostgreSQL and the real Fastify app: seed loading,
 * proposal decisions and their recorded read sets, the database's own guards, deterministic
 * correction propagation, live continuations, branch opening with lineage, personal suppression,
 * pause, Clear/Reset erasure and export. Every fixture substrate is unique to its test.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { buildApp } from '../apps/api/src/app.ts';
import { pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import { bridgeProposalPayload, type EncounterBranchesResponse } from '../packages/contracts/src/semantic.ts';
import { readSetFromRecord, validateBridgeProposal } from '../packages/core/src/semantic/bridge-validator.ts';
import { loadSubstrateSeed, SubstrateSeedConflict } from '../packages/db/src/semantic/seed.ts';
import { correctSourceSnapshot } from '../packages/db/src/semantic/corrections.ts';
import { submitBridgeProposal } from '../packages/db/src/semantic/proposals.ts';
import { makeSemanticFixture, type SemanticFixture } from './helpers/semantic-fixture.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) {
  throw new Error('Semantic substrate tests require an isolated knowscroll_test_* database');
}

const app = buildApp(randomBytes(32).toString('hex'));
after(async () => { await app.close(); await pool.end(); });
const headers = (token: string) => ({ authorization: `Bearer ${token}` });

async function loaded(): Promise<SemanticFixture & { proposals: Awaited<ReturnType<typeof loadSubstrateSeed>>['proposals'] }> {
  const fixture = await makeSemanticFixture(pool);
  const result = await transaction(client => loadSubstrateSeed(client, fixture.raw));
  assert.equal(result.status, 'loaded');
  return { ...fixture, proposals: result.proposals };
}

async function exposeDirect(token: string, universeId: string, epoch: number, assetId: string): Promise<{ exposureId: string; eventId: string }> {
  const asset = (await pool.query(`SELECT id AS "assetId", revision, kind, title, summary, body, source_title AS "sourceTitle", source_url AS "sourceUrl", truth_state AS "truthState" FROM asset WHERE id=$1`, [assetId])).rows[0];
  const decisionId = randomUUID();
  await pool.query(`INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates,privacy_epoch) VALUES($1,$2,0,'semantic-test-fixture',$3::jsonb,$4)`,
    [decisionId, universeId, JSON.stringify([asset]), epoch]);
  const response = await app.inject({ method: 'POST', url: '/v1/exposures', headers: headers(token), payload: { decisionId, assetId, clientExposureId: randomUUID() } });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

async function branches(token: string, assetId: string): Promise<EncounterBranchesResponse> {
  const response = await app.inject({ url: `/v1/assets/${assetId}/branches`, headers: headers(token) });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

test('the seed loads once, replays as already loaded, and refuses changed content under the same identity', async () => {
  const fixture = await loaded();
  assert.deepEqual(fixture.proposals.map(p => p.result.status), ['admitted', 'admitted', 'rejected']);
  const again = await transaction(client => loadSubstrateSeed(client, fixture.raw));
  assert.equal(again.status, 'already_loaded');

  const changedVersion = { ...fixture.seed, version: `${fixture.seed.version}1`, claims: fixture.seed.claims.map((c, i) => i === 0 ? { ...c, statement: `${c.statement} (edited)` } : c) };
  await assert.rejects(transaction(client => loadSubstrateSeed(client, JSON.stringify(changedVersion))), SubstrateSeedConflict);
  const sameVersionOtherBytes = { ...fixture.seed, families: fixture.seed.families.map(f => ({ ...f, description: `${f.description}.` })) };
  await assert.rejects(transaction(client => loadSubstrateSeed(client, JSON.stringify(sameVersionOtherBytes))), /different content/);
});

test('an admitted bridge carries its evidence; the tempting one is recorded as rejected with named reasons', async () => {
  const fixture = await loaded();
  const [tides, analogy, tempting] = fixture.proposals.map(p => p.result);
  const evidence = (await pool.query('SELECT supports FROM bridge_evidence WHERE bridge_id=$1 ORDER BY supports', [tides!.bridgeId])).rows.map(r => r.supports);
  assert.deepEqual(evidence, ['from', 'mechanism', 'to']);
  assert.ok(analogy!.bridgeId);
  assert.equal(tempting!.bridgeId, null);
  const reasons = tempting!.decision.outcome === 'rejected' ? tempting!.decision.reasons : [];
  for (const expected of ['mechanism_unsupported', 'counterevidence_ignored', 'contradicted_by_substrate']) assert.ok(reasons.includes(expected as never), expected);
  const row = (await pool.query('SELECT status FROM semantic_proposal WHERE id=$1', [tempting!.proposalId])).rows[0];
  assert.equal(row.status, 'rejected');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM bridge WHERE proposal_id=$1', [tempting!.proposalId])).rows[0].n, 0);
});

test('every recorded proposal re-derives its own decision from the read-set slice stored with it', async () => {
  const fixture = await loaded();
  for (const p of fixture.proposals) {
    const row = (await pool.query('SELECT payload, read_set, decision FROM semantic_proposal WHERE id=$1', [p.result.proposalId])).rows[0];
    assert.deepEqual(validateBridgeProposal(bridgeProposalPayload.parse(row.payload), readSetFromRecord(row.read_set)), row.decision);
  }
});

test('an identical proposal from the same proposer replays; a person proposal in another epoch is discarded', async () => {
  const fixture = await loaded();
  const payload = fixture.seed.bridgeProposals[0]!.payload;
  const replay = await transaction(client => submitBridgeProposal(client, { scope: { kind: 'shared' }, proposerKind: 'editorial', proposerRef: `${fixture.seed.version}:${fixture.seed.bridgeProposals[0]!.key}`, payload }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.bridgeId, fixture.proposals[0]!.result.bridgeId);

  const person = await provisionIdentity();
  await assert.rejects(transaction(client => submitBridgeProposal(client, {
    scope: { kind: 'universe', universeId: person.scope.universeId, privacyEpoch: person.scope.privacyEpoch + 1 },
    proposerKind: 'person', proposerRef: 'person-test', payload,
  })), /privacy epoch changed/);
});

test('the database refuses an admitted bridge without evidence, a bridge without an admitted proposal, and edits', async () => {
  const fixture = await loaded();
  const rejectedProposal = fixture.proposals[2]!.result.proposalId;
  const insert = (client: import('pg').PoolClient, proposalId: string) => client.query(
    `INSERT INTO bridge(id,proposal_id,scope_kind,from_concept_id,to_concept_id,relation_type,mechanism,prerequisites,limitations,counterevidence,validator_version)
     SELECT $1,$2,'shared',f.id,t.id,'explains',repeat('m',60),'[{"statement":"x"}]','[{"kind":"scope_limit","statement":"y"}]','{}','test'
     FROM concept f, concept t WHERE f.code=$3 AND t.code=$4`,
    [randomUUID(), proposalId, fixture.codes.ellipse, fixture.codes.seasons],
  );
  await assert.rejects(transaction(client => insert(client, rejectedProposal)), /requires an admitted bridge_candidate proposal/);

  // An admitted proposal whose bridge is written without evidence rows fails at commit.
  const forged = randomUUID();
  await assert.rejects(transaction(async client => {
    await client.query(`INSERT INTO semantic_proposal(id,kind,scope_kind,proposer_kind,proposer_ref,payload,payload_sha256,read_set,status,decision,validator_version)
      VALUES($1,'bridge_candidate','shared','editorial','forged-test','{}',$2,'{}','admitted','{}','test')`, [forged, randomBytes(32).toString('hex')]);
    await insert(client, forged);
  }), /needs currently supported evidence for: from, to, mechanism/);

  const bridgeId = fixture.proposals[0]!.result.bridgeId!;
  await assert.rejects(pool.query(`UPDATE bridge SET mechanism=repeat('z',60) WHERE id=$1`, [bridgeId]), /validated content is immutable/);
  await assert.rejects(pool.query('DELETE FROM bridge WHERE id=$1', [bridgeId]), /Shared bridges are revoked, never deleted/);
  await assert.rejects(pool.query(`UPDATE claim SET statement='changed statement here' WHERE key=$1`, [fixture.seed.claims[0]!.key]), /immutable/);
});

test('correcting a source revokes exactly the bridges whose evidence it carried, and says why', async () => {
  const fixture = await loaded();
  const tidesBridge = fixture.proposals[0]!.result.bridgeId!;
  const analogyBridge = fixture.proposals[1]!.result.bridgeId!;
  const receipt = await transaction(client => correctSourceSnapshot(client, { sourceKey: fixture.sources.physics, action: 'corrected', reason: 'Publisher revised the tides page' }, 'editorial'));

  const lostClaims = receipt.effects.filter(e => e.targetKind === 'claim').length;
  assert.ok(lostClaims >= 3, `physics claims lost support (${lostClaims})`);
  const bridgeEffects = receipt.effects.filter(e => e.targetKind === 'bridge');
  assert.deepEqual(bridgeEffects.map(e => e.targetId), [tidesBridge]);
  assert.ok(bridgeEffects[0]!.reasons.includes('evidence_unsupported'));
  assert.ok(receipt.effects.some(e => e.targetKind === 'concept_relation'), 'the explains relation backed by a physics claim is revoked');

  const statuses = (await pool.query('SELECT id, status, status_reason FROM bridge WHERE id = ANY($1::uuid[])', [[tidesBridge, analogyBridge]])).rows;
  assert.equal(statuses.find(r => r.id === tidesBridge).status, 'revoked');
  assert.equal(statuses.find(r => r.id === tidesBridge).status_reason.sourceKey, fixture.sources.physics);
  assert.equal(statuses.find(r => r.id === analogyBridge).status, 'admitted', 'the stars/biology analogy is untouched');

  await assert.rejects(transaction(client => correctSourceSnapshot(client, { sourceKey: fixture.sources.physics, action: 'revoked', reason: 'second correction attempt' }, 'editorial')), /no current snapshot/);
  // A corrected snapshot is history: it cannot be edited back to current.
  await assert.rejects(pool.query(`UPDATE source_snapshot SET status='current', status_reason=NULL, status_changed_at=NULL WHERE id=$1`, [receipt.snapshotId]), /cannot change again/);
});

test('an encounter lists continuations only along admitted bridges, and says why a list is empty', async () => {
  const fixture = await loaded();
  const reader = await provisionIdentity();
  const fromGravity = await branches(reader.token, fixture.assets.gravity);
  assert.equal(fromGravity.emptyReason, null);
  assert.equal(fromGravity.branches.length, 1);
  const branch = fromGravity.branches[0]!;
  assert.equal(branch.target.assetId, fixture.assets.tides);
  assert.equal(branch.direction, 'forward');
  assert.equal(branch.relationPhrase, 'explains');
  assert.ok(branch.evidence.some(e => e.supports === 'mechanism' && e.sourceTitle === 'Physics fixture'));

  const fromTides = await branches(reader.token, fixture.assets.tides);
  assert.equal(fromTides.branches[0]!.direction, 'reverse');
  assert.equal(fromTides.branches[0]!.relationPhrase, 'is explained by');
  assert.equal(fromTides.branches[0]!.target.assetId, fixture.assets.gravity);

  assert.equal((await branches(reader.token, fixture.assets.body)).branches[0]!.target.assetId, fixture.assets.star, 'a symmetric bridge is walkable from either side');
  assert.equal((await branches(reader.token, fixture.assets.seasons)).emptyReason, 'no_admitted_bridge', 'the rejected ellipse→seasons proposal offers nothing');
  assert.equal((await branches(reader.token, fixture.assets.unannotated)).emptyReason, 'no_semantic_annotation');
  assert.equal((await app.inject({ url: `/v1/assets/${randomUUID()}/branches`, headers: headers(reader.token) })).statusCode, 404);
});

test('opening a branch serves the target through a decision, records a caused branch event, and replays exactly', async () => {
  const fixture = await loaded();
  const reader = await provisionIdentity();
  const origin = await exposeDirect(reader.token, reader.scope.universeId, 0, fixture.assets.gravity);
  const branch = (await branches(reader.token, fixture.assets.gravity)).branches[0]!;
  const body = { clientBranchId: randomUUID(), fromExposureId: origin.exposureId, bridgeId: branch.bridgeId, targetAssetId: branch.target.assetId, expectedPrivacyEpoch: 0 };
  const opened = await app.inject({ method: 'POST', url: '/v1/branches', headers: headers(reader.token), payload: body });
  assert.equal(opened.statusCode, 201, opened.body);
  const result = opened.json();
  assert.equal(result.items[0].assetId, fixture.assets.tides);
  assert.match(result.items[0].reason, /Gravity explains Tides/);
  assert.equal(result.branch.recorded, true);

  const event = (await pool.query(`SELECT l.kind, l.causation_id, l.privacy_epoch FROM branch_open b JOIN ledger l ON l.id=b.event_id WHERE b.id=$1`, [result.branch.branchOpenId])).rows[0];
  assert.deepEqual(event, { kind: 'branch', causation_id: origin.eventId, privacy_epoch: 0 });
  // The target is exposed through the branch decision like any other selection.
  const exposure = await app.inject({ method: 'POST', url: '/v1/exposures', headers: headers(reader.token), payload: { decisionId: result.decisionId, assetId: fixture.assets.tides, clientExposureId: randomUUID() } });
  assert.equal(exposure.statusCode, 201, exposure.body);

  const replay = await app.inject({ method: 'POST', url: '/v1/branches', headers: headers(reader.token), payload: body });
  assert.equal(replay.json().decisionId, result.decisionId);
  const conflict = await app.inject({ method: 'POST', url: '/v1/branches', headers: headers(reader.token), payload: { ...body, targetAssetId: fixture.assets.star } });
  assert.equal(conflict.statusCode, 409);
  const stale = await app.inject({ method: 'POST', url: '/v1/branches', headers: headers(reader.token), payload: { ...body, clientBranchId: randomUUID(), expectedPrivacyEpoch: 1 } });
  assert.equal(stale.statusCode, 409);
  const foreign = await provisionIdentity();
  const notMine = await app.inject({ method: 'POST', url: '/v1/branches', headers: headers(foreign.token), payload: { ...body, clientBranchId: randomUUID() } });
  assert.equal(notMine.statusCode, 422, 'another universe cannot branch from this exposure');
});

test('a branch revoked between listing and opening is refused, not served', async () => {
  const fixture = await loaded();
  const reader = await provisionIdentity();
  const origin = await exposeDirect(reader.token, reader.scope.universeId, 0, fixture.assets.gravity);
  const branch = (await branches(reader.token, fixture.assets.gravity)).branches[0]!;
  await transaction(client => correctSourceSnapshot(client, { sourceKey: fixture.sources.physics, action: 'revoked', reason: 'Source withdrawn by publisher' }, 'operator'));
  const opened = await app.inject({ method: 'POST', url: '/v1/branches', headers: headers(reader.token), payload: {
    clientBranchId: randomUUID(), fromExposureId: origin.exposureId, bridgeId: branch.bridgeId, targetAssetId: branch.target.assetId, expectedPrivacyEpoch: 0 } });
  assert.equal(opened.statusCode, 409);
  assert.equal((await branches(reader.token, fixture.assets.gravity)).emptyReason, 'no_admitted_bridge');
});

test('while recording is paused a branch is served but nothing personal is kept', async () => {
  const fixture = await loaded();
  const reader = await provisionIdentity();
  const origin = await exposeDirect(reader.token, reader.scope.universeId, 0, fixture.assets.body);
  const pause = await app.inject({ method: 'POST', url: '/v1/privacy/pause', headers: headers(reader.token), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } });
  assert.equal(pause.statusCode, 200, pause.body);
  const branch = (await branches(reader.token, fixture.assets.body)).branches[0]!;
  const opened = await app.inject({ method: 'POST', url: '/v1/branches', headers: headers(reader.token), payload: {
    clientBranchId: randomUUID(), fromExposureId: origin.exposureId, bridgeId: branch.bridgeId, targetAssetId: branch.target.assetId, expectedPrivacyEpoch: 0 } });
  assert.equal(opened.statusCode, 201, opened.body);
  assert.equal(opened.json().branch.recorded, false);
  assert.equal(opened.json().branch.branchOpenId, null);
  const counts = (await pool.query(`SELECT (SELECT count(*) FROM branch_open WHERE universe_id=$1)::int AS opens, (SELECT count(*) FROM ledger WHERE universe_id=$1 AND kind='branch')::int AS events`, [reader.scope.universeId])).rows[0];
  assert.deepEqual(counts, { opens: 0, events: 0 });
});

test('"seems wrong" suppresses a connection for this reader only and is not a retraction', async () => {
  const fixture = await loaded();
  const reader = await provisionIdentity();
  const neighbor = await provisionIdentity();
  const branch = (await branches(reader.token, fixture.assets.star)).branches[0]!;
  const body = { clientFeedbackId: randomUUID(), bridgeId: branch.bridgeId, expectedPrivacyEpoch: 0, objection: 'seems_wrong' };
  const feedback = await app.inject({ method: 'POST', url: '/v1/connections/feedback', headers: headers(reader.token), payload: body });
  assert.equal(feedback.statusCode, 201, feedback.body);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/connections/feedback', headers: headers(reader.token), payload: body })).json().feedbackId, feedback.json().feedbackId);
  assert.equal((await branches(reader.token, fixture.assets.star)).emptyReason, 'no_admitted_bridge');
  assert.equal((await branches(neighbor.token, fixture.assets.star)).branches[0]!.bridgeId, branch.bridgeId);
  assert.equal((await pool.query('SELECT status FROM bridge WHERE id=$1', [branch.bridgeId])).rows[0].status, 'admitted');
});

for (const operation of ['clear', 'reset'] as const) {
  test(`${operation} erases this reader's semantic history, exports it beforehand, and keeps shared knowledge`, async () => {
    const fixture = await loaded();
    const reader = await provisionIdentity();
    const origin = await exposeDirect(reader.token, reader.scope.universeId, 0, fixture.assets.gravity);
    const branch = (await branches(reader.token, fixture.assets.gravity)).branches[0]!;
    assert.equal((await app.inject({ method: 'POST', url: '/v1/branches', headers: headers(reader.token), payload: {
      clientBranchId: randomUUID(), fromExposureId: origin.exposureId, bridgeId: branch.bridgeId, targetAssetId: branch.target.assetId, expectedPrivacyEpoch: 0 } })).statusCode, 201);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/connections/feedback', headers: headers(reader.token), payload: {
      clientFeedbackId: randomUUID(), bridgeId: fixture.proposals[1]!.result.bridgeId, expectedPrivacyEpoch: 0, objection: 'not_useful' } })).statusCode, 201);
    const personal = await transaction(async client => {
      await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [reader.scope.universeId]);
      return submitBridgeProposal(client, { scope: { kind: 'universe', universeId: reader.scope.universeId, privacyEpoch: 0 }, proposerKind: 'person', proposerRef: `person-${fixture.tag}`, payload: fixture.seed.bridgeProposals[2]!.payload });
    });
    assert.equal(personal.status, 'rejected');

    const exported = await app.inject({ method: 'POST', url: '/v1/privacy/export', headers: headers(reader.token), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } });
    assert.equal(exported.statusCode, 200, exported.body);
    const rowCounts = exported.json().rowCounts;
    assert.deepEqual([rowCounts.branchOpens, rowCounts.connectionFeedback, rowCounts.semanticProposals], [1, 1, 1]);

    const shared = async () => (await pool.query(`SELECT (SELECT count(*) FROM bridge WHERE universe_id IS NULL)::int AS bridges,
      (SELECT count(*) FROM semantic_proposal WHERE universe_id IS NULL)::int AS proposals, (SELECT count(*) FROM claim)::int AS claims`)).rows[0];
    const sharedBefore = await shared();
    const result = await app.inject({ method: 'POST', url: operation === 'clear' ? '/v1/history/clear' : '/v1/privacy/reset', headers: headers(reader.token),
      payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: operation === 'clear' ? 'clear-scroll-history' : 'reset-personal-universe' } });
    assert.equal(result.statusCode, 200, result.body);
    const left = (await pool.query(`SELECT (SELECT count(*) FROM branch_open WHERE universe_id=$1)::int AS opens,
      (SELECT count(*) FROM connection_feedback WHERE universe_id=$1)::int AS feedback,
      (SELECT count(*) FROM semantic_proposal WHERE universe_id=$1)::int AS proposals,
      (SELECT count(*) FROM ledger WHERE universe_id=$1)::int AS events`, [reader.scope.universeId])).rows[0];
    assert.deepEqual(left, { opens: 0, feedback: 0, proposals: 0, events: 0 });
    assert.deepEqual(await shared(), sharedBefore);
  });
}
