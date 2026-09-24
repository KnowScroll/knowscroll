/**
 * #166 — background inquiry triggers beyond place formation (ADR-0042 §5), over the real app, the real
 * personal-model refresh and Cartographer, a real source correction and the worker's inquiry pass, with
 * the labelled fixture transport. Proves: a personal hypothesis about a live place that changes status
 * mails an inquiry in the refresh's own transaction; a source correction that revokes a bridge between
 * two of a consenting reader's live places mails one from the worker, once, and the pair may be asked
 * again; each mail records its typed cause and coalesces as ADR-0038 §3; nothing earlier than consent
 * (or the last resume) is ever mailed; and the schema refuses a cause the rules do not allow.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { buildApp } from '../apps/api/src/app.ts';
import { pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import { mailRevokedConnections } from '../packages/db/src/reasoning-inquiries.ts';
import { correctSourceSnapshot } from '../packages/db/src/semantic/corrections.ts';
import { submitBridgeProposal } from '../packages/db/src/semantic/proposals.ts';
import { runInquiryPass } from '../apps/worker/src/reasoning/inquiry-worker.ts';
import { createFixtureInquiryTransport } from '../apps/worker/src/providers/inquiry-fixture.ts';
import {
  consentingReader, formPlaces, gravitySunPayload, installFixtureInquiryRoute, loadInquiryFixture, newestInquiry, type InquiryFixture, type InquiryReader,
} from './helpers/inquiry-fixture.ts';
import { EDITORIAL, anchorGravity as anchorGravityIn, readFirstOffered, type Identity } from './helpers/reading.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Inquiry tests require a disposable knowscroll_test_* database');

const app = buildApp(randomBytes(32).toString('hex'));
const readAnything = (i: Identity) => readFirstOffered(app, { authorization: `Bearer ${i.token}` });
const anchorGravity = (i?: Identity) => anchorGravityIn(app, i);
const fixture = createFixtureInquiryTransport(() => 'proposal');
const signal = new AbortController().signal;
let f: InquiryFixture;

before(async () => {
  await app.ready();
  await installFixtureInquiryRoute('triggers-test-v1');
});
after(async () => { await app.close(); await pool.end(); });

const pass = () => runInquiryPass({ pool, owner: 'triggers-worker', leaseMs: 60_000, transports: { fixture }, signal });
const mail = async (universeId: string) => (await pool.query(
  `SELECT cause_kind, cause_delta_id, cause_bridge_id, cause_hypothesis_id, cause_hypothesis_revision, inquiry_id FROM inquiry_mail WHERE universe_id=$1 ORDER BY sequence`,
  [universeId])).rows;
const privacy = (r: { headers: { authorization: string } }, action: 'pause' | 'resume') =>
  app.inject({ method: 'POST', url: `/v1/privacy/${action}`, headers: r.headers, payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } });
const setConsent = (headers: { authorization: string }, enabled: boolean) =>
  app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers, payload: { enabled, clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 } });
const gravityHypothesis = async (universeId: string) => (await pool.query(
  `SELECT h.id, h.status, h.revision FROM personal_hypothesis h JOIN concept c ON c.id = h.concept_id WHERE h.universe_id=$1 AND h.kind='direction' AND c.code='physics.gravity'`,
  [universeId])).rows[0];
/** "Less like this" on the reader's kept Gravity encounter: counterevidence that contests the hypothesis about Gravity. */
async function lessLikeGravity(i: Identity) {
  const encounter = (await pool.query(`SELECT e.decision_id AS "decisionId", e.asset_id AS "assetId" FROM exposure e JOIN ledger l ON l.id = e.event_id
    WHERE e.universe_id=$1 AND e.asset_id=$2 ORDER BY l.created_at DESC LIMIT 1`, [i.scope.universeId, EDITORIAL.unseenPull])).rows[0];
  const response = await app.inject({ method: 'POST', url: '/v1/encounters/feedback', headers: { authorization: `Bearer ${i.token}` },
    payload: { clientFeedbackId: randomUUID(), ...encounter, kind: 'less_like_this', expectedPrivacyEpoch: 0 } });
  assert.equal(response.statusCode, 201, response.body);
}

test('a hypothesis about a live place that changes its status mails an inquiry in the refresh\'s own transaction', async () => {
  const i = await provisionIdentity();
  assert.equal((await setConsent({ authorization: `Bearer ${i.token}` }, true)).statusCode, 200);
  await anchorGravity(i);
  const r = { universeId: i.scope.universeId };
  const active = await gravityHypothesis(r.universeId);
  assert.equal(active.status, 'active');
  const formed = await mail(r.universeId);
  assert.ok(formed.length >= 1 && formed.every(m => m.cause_kind === 'place_formed'), 'Gravity became a place: its mail is place_formed');
  assert.ok(!formed.some(m => m.cause_kind === 'hypothesis_changed'), 'the hypothesis appeared before Gravity was a place, and stayed active since');

  await lessLikeGravity(i);
  const contested = await gravityHypothesis(r.universeId);
  assert.equal(contested.status, 'contested');
  const after = await mail(r.universeId);
  const caused = after.filter(m => m.cause_kind === 'hypothesis_changed');
  assert.deepEqual(caused.map(m => [m.cause_hypothesis_id, m.cause_hypothesis_revision, m.cause_delta_id, m.cause_bridge_id]),
    [[contested.id, contested.revision, null, null]]);
  assert.equal(new Set(after.map(m => m.inquiry_id)).size, 1, 'coalesced into the one pending inquiry');

  // Nothing changes state on another read: no further mail.
  await readAnything(i);
  assert.equal((await mail(r.universeId)).length, after.length);
});

test('no backfill: a hypothesis that changed before consent is never mailed, and the schema refuses it', async () => {
  const i = await anchorGravity();
  const headers = { authorization: `Bearer ${i.token}` };
  await lessLikeGravity(i);
  const contested = await gravityHypothesis(i.scope.universeId);
  assert.equal(contested.status, 'contested');
  assert.equal((await setConsent(headers, true)).statusCode, 200);
  await readAnything(i);
  assert.deepEqual(await mail(i.scope.universeId), [], 'consent never turns earlier changes into paid work');
  await assert.rejects(transaction(async client => {
    await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [i.scope.universeId]);
    const pending = randomUUID();
    await client.query(`INSERT INTO background_inquiry(id,universe_id,privacy_epoch,kind,status) VALUES($1,$2,0,'bridge_between_places','pending')`, [pending, i.scope.universeId]);
    await client.query(`INSERT INTO inquiry_mail(id,universe_id,privacy_epoch,kind,inquiry_id,cause_kind,cause_hypothesis_id,cause_hypothesis_revision)
      VALUES($1,$2,0,'bridge_between_places',$3,'hypothesis_changed',$4,$5)`, [randomUUID(), i.scope.universeId, pending, contested.id, contested.revision]);
  }), /hypothesis about a live place revised since consent/);
});

/** A reader whose Gravity and Sun are places and whose own inquiry found the bridge between them. */
async function foundGravitySun(own: InquiryFixture): Promise<InquiryReader & { bridgeId: string }> {
  const r = await consentingReader(app);
  await formPlaces(r.universeId, [own.codes.gravity, own.codes.sun]);
  for (let n = 0; n < 12 && (await newestInquiry(r.universeId))?.status !== 'admitted'; n += 1) await pass();
  const found = await newestInquiry(r.universeId);
  assert.equal(found.status, 'admitted');
  const bridge = (await pool.query('SELECT id FROM bridge WHERE proposal_id=$1', [found.proposal_id])).rows[0];
  return { ...r, bridgeId: bridge.id };
}

test('a correction that revokes a bridge between two live places mails a look again, once, and the pair may be asked again', async () => {
  f = await loadInquiryFixture(pool);
  const r = await foundGravitySun(f);
  // The physics source is withdrawn: Gravity's own claim loses its support and the bridge that cited it is revoked.
  await transaction(client => correctSourceSnapshot(client, { sourceKey: f.sources.physics, action: 'revoked', reason: 'Fixture: this source was withdrawn' }, 'editorial'));
  assert.equal((await pool.query('SELECT status FROM bridge WHERE id=$1', [r.bridgeId])).rows[0].status, 'revoked');
  assert.ok(await mailRevokedConnections(pool) >= 1);
  const caused = (await mail(r.universeId)).filter(m => m.cause_kind === 'bridge_revoked');
  assert.deepEqual(caused.map(m => [m.cause_bridge_id, m.cause_delta_id, m.cause_hypothesis_id]), [[r.bridgeId, null, null]]);
  assert.equal(await mailRevokedConnections(pool), 0, 'once per universe and bridge');

  // Asked and found before the revocation, the pair is offered again from current evidence.
  for (let n = 0; n < 12 && ['pending', 'queued'].includes((await newestInquiry(r.universeId)).status); n += 1) await pass();
  const again = await newestInquiry(r.universeId);
  assert.deepEqual(again.pairs.map((p: { a: { code: string }; b: { code: string } }) => [p.a.code, p.b.code]), [[f.codes.gravity, f.codes.sun]]);
  assert.equal(again.dispatched, 1);
});

test('no backfill: a revocation before consent, or while paused, is never mailed', async () => {
  const own = await loadInquiryFixture(pool);
  // Without consent: the reader's own connection, then its revocation, then consent.
  const quiet = await consentingReader(app);
  assert.equal((await setConsent(quiet.headers, false)).statusCode, 200);
  await formPlaces(quiet.universeId, [own.codes.gravity, own.codes.sun]);
  await transaction(async client => {
    await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [quiet.universeId]);
    await submitBridgeProposal(client, { scope: { kind: 'universe', universeId: quiet.universeId, privacyEpoch: 0 }, proposerKind: 'person', proposerRef: `person-${own.tag}`, payload: gravitySunPayload(own) });
  });
  // Paused: a reader with consent who pauses before the revocation and resumes after it.
  const paused = await foundGravitySun(own);
  assert.equal((await privacy(paused, 'pause')).statusCode, 200);
  await transaction(client => correctSourceSnapshot(client, { sourceKey: own.sources.physics, action: 'revoked', reason: 'Fixture: this source was withdrawn' }, 'editorial'));
  assert.equal((await setConsent(quiet.headers, true)).statusCode, 200);
  assert.equal((await privacy(paused, 'resume')).statusCode, 200);
  await mailRevokedConnections(pool);
  assert.deepEqual((await mail(quiet.universeId)).filter(m => m.cause_kind === 'bridge_revoked'), []);
  assert.deepEqual((await mail(paused.universeId)).filter(m => m.cause_kind === 'bridge_revoked'), []);
  const bridge = (await pool.query(`SELECT id FROM bridge WHERE universe_id=$1`, [quiet.universeId])).rows[0];
  await assert.rejects(transaction(async client => {
    await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [quiet.universeId]);
    const pending = randomUUID();
    await client.query(`INSERT INTO background_inquiry(id,universe_id,privacy_epoch,kind,status) VALUES($1,$2,0,'bridge_between_places','pending')`, [pending, quiet.universeId]);
    await client.query(`INSERT INTO inquiry_mail(id,universe_id,privacy_epoch,kind,inquiry_id,cause_kind,cause_bridge_id) VALUES($1,$2,0,'bridge_between_places',$3,'bridge_revoked',$4)`,
      [randomUUID(), quiet.universeId, pending, bridge.id]);
  }), /bridge between two live places revoked since consent/);
});
