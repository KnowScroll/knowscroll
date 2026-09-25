/**
 * #132 — the Android `inquiry` journey's premise, on the editorial substrate (`pnpm db:seed`) and
 * without a device (`scripts/android-semantic-journey.py` KS_SEMANTIC_JOURNEY=inquiry;
 * `scripts/inquiries/seed-journey.ts`): The Sun is placed from a supplied account BEFORE consent and
 * mails nothing; Gravity is placed AFTER consent and its place_formed mails one inquiry; the labelled
 * fixture transport's proposal for (The Sun, Gravity) is admitted by bridge-validator-v1, the list
 * says `found`, and the new personal bridge is a live continuation where Gravity is read. If this
 * fails, the emulator journey cannot pass. No provider is called.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { buildApp } from '../apps/api/src/app.ts';
import type { EncounterBranchesResponse } from '../packages/contracts/src/semantic.ts';
import { inquiriesResponse } from '../packages/contracts/src/inquiries.ts';
import { pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import { answerFairnessPolicy } from '../packages/db/src/reasoning-answers.ts';
import { createReasoningFairness } from '../packages/db/src/reasoning-fairness.ts';
import { inquiryAuthority, installBackgroundInquiryRoute } from '../packages/db/src/reasoning-inquiries.ts';
import { runInquiryPass } from '../apps/worker/src/reasoning/inquiry-worker.ts';
import { createFixtureInquiryTransport } from '../apps/worker/src/providers/inquiry-fixture.ts';
import { formPlaces } from './helpers/inquiry-fixture.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Inquiry tests require a disposable knowscroll_test_* database');

const app = buildApp(randomBytes(32).toString('hex'));
const POLICY = `inquiry-journey-editorial-${randomBytes(4).toString('hex')}`;
const calls = { count: 0 };
const fixture = createFixtureInquiryTransport(() => 'proposal', calls);

before(async () => {
  await createReasoningFairness(pool, inquiryAuthority()).installPolicy(answerFairnessPolicy(POLICY, { maxInputTokens: 16384, maxOutputTokens: 2048 }));
  // The journey route's shape (scripts/inquiries/seed-journey.ts), with no coalescing delay here.
  await transaction(client => installBackgroundInquiryRoute(client, { policyVersion: POLICY, routeId: 'fixture-inquiries', routeProfileVersion: 'fixture-v1',
    transport: 'fixture', model: 'fixture-model', maxInputTokens: 16384, maxOutputTokens: 2048, requestCap: 4, tokenBudget: 1_000_000,
    ownerCapacity: 1_000_000, jobCapacity: 100_000, coalescingDelaySeconds: 0, jobTtlSeconds: 600, remoteSlots: 1 }));
});
after(async () => { await app.close(); await pool.end(); });

test('The Sun supplied before consent and Gravity formed after it: one inquiry, found, and a continuation where Gravity is read', async () => {
  const { token, scope } = await provisionIdentity();
  const universeId = scope.universeId;
  const headers = { authorization: `Bearer ${token}` };
  const count = async (sql: string, params: unknown[] = [universeId]) => Number((await pool.query(sql, params)).rows[0].count);

  await formPlaces(universeId, ['astro.sun']);
  assert.equal(await count('SELECT count(*) FROM inquiry_mail WHERE universe_id=$1'), 0, 'no consent yet: the supplied place mails nothing');

  const consent = await app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers,
    payload: { enabled: true, dailyLimit: 3, clientRequestId: randomUUID(), expectedPrivacyEpoch: scope.privacyEpoch } });
  assert.equal(consent.statusCode, 200, consent.body);

  await formPlaces(universeId, ['physics.gravity'], ['astro.sun']);
  const mail = (await pool.query<{ kind: string; code: string }>(
    `SELECT d.kind, c.code FROM inquiry_mail m JOIN atlas_delta d ON d.id = m.cause_delta_id JOIN atlas_place p ON p.id = d.place_id
     JOIN concept c ON c.id = p.anchor_concept_id WHERE m.universe_id=$1`, [universeId])).rows;
  assert.deepEqual(mail, [{ kind: 'place_formed', code: 'physics.gravity' }], 'Gravity\'s formation is the one cause');

  for (let i = 0; i < 12; i += 1) {
    if (!(await count(`SELECT count(*) FROM background_inquiry WHERE universe_id=$1 AND status IN ('pending','queued')`))) break;
    await runInquiryPass({ pool, owner: 'inquiry-journey-test', leaseMs: 60_000, transports: { fixture }, signal: new AbortController().signal });
  }
  const listed = inquiriesResponse.parse((await app.inject({ url: '/v1/inquiries', headers })).json());
  const inquiry = listed.inquiries[0]!;
  assert.equal(listed.inquiries.length, 1);
  assert.equal(inquiry.status, 'found', JSON.stringify(inquiry.reasons));
  assert.deepEqual(inquiry.pairs, [{ a: { code: 'astro.sun', name: 'The Sun' }, b: { code: 'physics.gravity', name: 'Gravity' } }]);
  assert.equal(inquiry.found!.fromConcept.code, 'astro.sun');
  assert.equal(listed.consent.usedToday, 1);

  const proposal = (await pool.query<{ proposer_kind: string; scope_kind: string; status: string }>(
    `SELECT p.proposer_kind, p.scope_kind, p.status FROM background_inquiry i JOIN semantic_proposal p ON p.id = i.proposal_id WHERE i.id=$1`, [inquiry.inquiryId])).rows[0];
  assert.deepEqual(proposal, { proposer_kind: 'model', scope_kind: 'universe', status: 'admitted' });

  const pull = (await pool.query<{ id: string }>(`SELECT id FROM asset WHERE title LIKE 'The pull you can''t see%'`)).rows[0]!.id;
  const served = await app.inject({ url: `/v1/assets/${pull}/branches`, headers });
  assert.equal(served.statusCode, 200, served.body);
  const branches = served.json() as EncounterBranchesResponse;
  const continuation = branches.branches.find(b => b.bridgeId === inquiry.found!.bridgeId);
  assert.ok(continuation, 'the admitted bridge is a live continuation where Gravity is read');
  assert.equal(continuation.mechanism, inquiry.found!.sentence);
  assert.equal(continuation.toConcept.code, 'astro.sun');
});
