/**
 * #131 — the real editorial substrate (content/substrate.json), as `pnpm db:seed` loaded it into
 * this disposable database: its integrity holds without local snapshots (CI), every editorial
 * bridge proposal was decided by the real validator and recorded, and the tempting-but-unsupported
 * fixtures (tests/fixtures/semantic/tempting-bridges.json) are refused for the reasons their
 * authors predicted — against the loaded substrate, not a hand-built read set.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { pool, transaction } from '../packages/db/src/index.ts';
import { bridgeProposalPayload } from '../packages/contracts/src/semantic.ts';
import { validateBridgeProposal } from '../packages/core/src/semantic/bridge-validator.ts';
import { loadBridgeReadSet } from '../packages/db/src/semantic/read-set.ts';
import { checkSubstrateSeed, loadEditorialAssetIds } from '../scripts/substrate/verify-substrate.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) {
  throw new Error('Editorial substrate tests require an isolated knowscroll_test_* database');
}
after(async () => { await pool.end(); });

const seed = JSON.parse(readFileSync('content/substrate.json', 'utf8'));
const tempting = JSON.parse(readFileSync('tests/fixtures/semantic/tempting-bridges.json', 'utf8')) as Array<{ key: string; expectedReasons: string[]; payload: unknown }>;

test('the editorial seed is schema-valid and referentially whole without local snapshots', () => {
  const report = checkSubstrateSeed(seed, loadEditorialAssetIds(), () => null);
  assert.deepEqual(report.errors, []);
  assert.ok(report.quotes.every(q => q.status === 'unverified_no_snapshot'), 'CI proves integrity only; quotes are verified locally with snapshots');
});

test('db:seed loaded the editorial substrate once and decided every editorial proposal', async () => {
  const load = (await pool.query('SELECT counts FROM semantic_seed_load WHERE version=$1', [seed.version])).rows[0];
  assert.ok(load, 'the seed version is recorded');
  const decided = (await pool.query(
    `SELECT proposer_ref, status, decision FROM semantic_proposal WHERE proposer_kind='editorial' AND proposer_ref LIKE $1 ORDER BY proposer_ref`,
    [`${seed.version}:%`],
  )).rows;
  assert.equal(decided.length, seed.bridgeProposals.length);
  for (const row of decided) assert.equal(row.status, 'admitted', `${row.proposer_ref}: ${JSON.stringify(row.decision)}`);
  assert.equal(load.counts.bridgesAdmitted, seed.bridgeProposals.length);
});

test('every tempting-but-unsupported bridge is refused by the validator against the loaded substrate', async () => {
  const readSet = await transaction(client => loadBridgeReadSet(client, null));
  for (const fixture of tempting) {
    const decision = validateBridgeProposal(bridgeProposalPayload.parse(fixture.payload), readSet);
    assert.equal(decision.outcome, 'rejected', fixture.key);
    const reasons = decision.outcome === 'rejected' ? decision.reasons : [];
    for (const expected of fixture.expectedReasons) assert.ok(reasons.includes(expected as never), `${fixture.key}: expected ${expected}, got ${reasons.join(', ')}`);
  }
});

test('every editorial Scroll is annotated with exactly one primary concept', async () => {
  const rows = (await pool.query(
    `SELECT a.id, count(*) FILTER (WHERE ac.role='primary')::int AS primaries
     FROM asset a LEFT JOIN asset_concept ac ON ac.asset_id=a.id
     WHERE a.id = ANY($1::uuid[]) GROUP BY a.id`,
    [[...loadEditorialAssetIds()]],
  )).rows;
  assert.equal(rows.length, loadEditorialAssetIds().size);
  for (const row of rows) assert.equal(row.primaries, 1, row.id);
});
