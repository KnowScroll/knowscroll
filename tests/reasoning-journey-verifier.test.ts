import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {verifyReasoningJourney} from '../scripts/reasoning-journey-verifier.ts';
import type {ReasoningJourneyReceipt} from '../scripts/fixtures/reasoning-evidence.ts';

// A recorded fixture runtime anchors these counterexamples. No provider output.
const recorded = JSON.parse(readFileSync(new URL('../docs/journeys/evidence/reasoning-faults/J004-receipt.json', import.meta.url), 'utf8')) as ReasoningJourneyReceipt;
const caseOf = (r: ReasoningJourneyReceipt, name: string) => r.cases.find(c => c.name === name)!;
const snapshot = (r: ReasoningJourneyReceipt, name: string, label: string) => caseOf(r, name).snapshots.find(s => s.label === label)!;

test('J004 verifier accepts recorded separate-process evidence', () => {
  assert.deepEqual(verifyReasoningJourney(recorded), {journey: 'J004', result: 'passed', cases: 13, fixtureRequests: 4});
});
const corruptions: Array<[string, (r: ReasoningJourneyReceipt) => void]> = [
  ['missing required case', r => { r.cases.pop(); }],
  ['no actual worker kill', r => { for (const p of r.processes) if (p.signal === 'SIGKILL') p.signal = 'SIGTERM'; }],
  ['duplicated HTTP request', r => { r.fixture.requests.push(structuredClone(r.fixture.requests[0]!)); }],
  ['unconsumed Permit at HTTP arrival', r => { r.fixture.requests[0]!.committedIntent.permit_state = 'reserved'; }],
  ['wrong dispatch binding', r => { r.fixture.requests[0]!.committedIntent.dispatch_id = 'wrong-dispatch'; }],
  ['missing runtime source hash', r => { r.source.files = r.source.files.filter(f => !f.path.endsWith('/invoke.ts')); }],
  ['unknown remote slot refunded', r => { snapshot(r, 'death_after_http', 'recovered_unknown').accounting[0]!.remote_state = 'released'; }],
  ['cancelled output eligible again', r => { snapshot(r, 'cancel', 'cancel_late_usage').accounting[0]!.output_authority = 'eligible'; }],
  ['nullable usage replaced by zero', r => { snapshot(r, 'receipt_revisions', 'first_usage').receipts[0]!.output_tokens = '0'; }],
  ['duplicate receipt charged again', r => { snapshot(r, 'receipt_revisions', 'duplicate_usage').buckets[0]!.consumed = '1'; }],
  ['cumulative revision charges full total', r => {
    const s = snapshot(r, 'receipt_revisions', 'revised_usage');
    s.adjustments.find(a => a.settlement_id === s.settlements.at(-1)!.id)!.delta = '15';
  }],
  ['overage clamped', r => { snapshot(r, 'receipt_revisions', 'overage_usage').buckets.find(b => b.dimension === 'global_budget')!.consumed = '120'; }],
  ['cleared private context resurrected', r => { snapshot(r, 'clear_late_receipt', 'late_usage_settled').contexts.push({id: 'resurrected'}); }],
  ['old clear erases later reservations', r => { snapshot(r, 'clear_late_receipt', 'old_clear_replay_preserved_later').reservations.pop(); }],
  ['API clear error treated as success', r => {
    (caseOf(r, 'clear_late_receipt').operations.find(o => o.name === 'api_clear')!.result as {status: number}).status = 500;
  }],
  ['partial failed reservation', r => {
    const c = caseOf(r, 'capacity_contention');
    c.snapshots.find(s => s.attempt.length === 0)!.permit.push({id: 'orphan-permit'});
  }],
  ['stale fence did not advance', r => {
    const c = caseOf(r, 'lease_replacement');
    snapshot(r, c.name, 'recovery_fence_stale_a_denied').job[0]!.lease_fence = c.identities.leaseFence;
  }],
  ['cleanup left a database', r => { r.cleanup.databaseAbsent = false; }],
];
for (const [name, mutate] of corruptions) {
  test(`J004 verifier rejects ${name}`, () => {
    const receipt = structuredClone(recorded);
    mutate(receipt);
    assert.throws(() => verifyReasoningJourney(receipt));
  });
}
