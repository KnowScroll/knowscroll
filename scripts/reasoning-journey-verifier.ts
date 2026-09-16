import assert from 'node:assert/strict';
import type {CaseEvidence, ReasoningJourneyReceipt, Snapshot, SqlRow} from './fixtures/reasoning-evidence.ts';

// Deliberately independent of the runner's case list and assertions.
const requiredCases = ['death_before_intent', 'death_after_intent', 'death_after_http', 'lost_commit_ack',
  'lease_replacement', 'cancel_before_dispatch', 'deadline_before_dispatch', 'cancel', 'deadline', 'clear_late_receipt', 'receipt_revisions',
  'capacity_contention', 'blocked_universe'];
const finiteTime = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const count = (value: unknown) => {
  assert.ok(typeof value === 'string' || typeof value === 'number', 'SQL count must be explicit');
  assert.match(String(value), /^\d+$/);
  return BigInt(value);
};
function snapshot(c: CaseEvidence, label: string): Snapshot {
  const found = c.snapshots.filter(s => s.label === label);
  assert.equal(found.length, 1, `${c.name}: missing/duplicate snapshot ${label}`);
  return found[0]!;
}
function accounting(c: CaseEvidence, s: Snapshot): SqlRow {
  const rows = s.accounting.filter(r => r.attempt_id === c.identities.attemptId);
  assert.equal(rows.length, 1, `${c.name}: missing original accounting identity`);
  const a = rows[0]!;
  assert.equal(a.universe_id, c.identities.universeId);
  assert.equal(a.privacy_epoch, c.identities.privacyEpoch);
  assert.equal(a.request_id, c.identities.requestId);
  return a;
}
function unknownHeld(c: CaseEvidence, s: Snapshot) {
  const a = accounting(c, s);
  assert.equal(a.state, 'unknown');
  assert.equal(a.output_authority, 'withdrawn');
  assert.equal(a.remote_state, 'held');
  assert.equal(a.liability_state, 'held');
  assert.equal(a.all_duties_closed_at, null);
  assert.equal(a.dispatch_id, c.identities.dispatchId);
  assert.equal(s.receipts.length, 0, 'unknown must not fabricate receipt usage');
  assert.equal(s.settlements.length, 0);
  assert.equal(s.reservations.length, 6);
  assert.ok(s.reservations.every(r => r.state === 'held'));
  assert.ok(s.buckets.every(b => count(b.reserved) > 0n && count(b.consumed) === 0n));
  assert.ok(s.permit.some(p => p.attempt_id === a.attempt_id && p.state === 'consumed' && p.dispatch_id === a.dispatch_id));
}
function settled(c: CaseEvidence, s: Snapshot, total: bigint) {
  const a = accounting(c, s);
  assert.equal(a.state, 'responded');
  assert.equal(a.output_authority, 'withdrawn');
  assert.equal(a.liability_state, 'settled');
  assert.equal(a.remote_state, 'released');
  assert.ok(finiteTime(a.all_duties_closed_at));
  assert.equal(s.buckets.length, 6);
  for (const b of s.buckets) {
    assert.equal(count(b.reserved), 0n);
    assert.equal(count(b.consumed), b.dimension === 'remote_concurrency' ? 0n : total);
  }
}
function noPrivateState(s: Snapshot) {
  for (const rows of [s.job, s.step, s.attempt, s.contexts]) assert.equal(rows.length, 0, 'private graph resurrected');
}
function denied(c: CaseEvidence, name?: string) {
  assert.ok(c.operations.some(o => (!name || o.name === name) && typeof denial(o) === 'string'),
    `${c.name}: refusal observation missing`);
}
function denial(o: CaseEvidence['operations'][number]): unknown {
  return o.denial ?? (o.result && typeof o.result === 'object' && 'denial' in o.result ? o.result.denial : undefined);
}

/** Verify observed state relationships, never trust a case's claimed success. */
export function verifyReasoningJourney(value: unknown) {
  const r = value as ReasoningJourneyReceipt;
  assert.equal(r.version, 1); assert.equal(r.journey, 'J004'); assert.equal(r.result, 'passed');
  assert.equal(r.error, undefined);
  assert.match(r.source.revision, /^[a-f0-9]{40}$/);
  assert.ok(typeof r.source.dirty === 'boolean');
  const requiredSources = ['packages/db/src/reasoning-admission.ts', 'packages/db/src/reasoning-reconciliation.ts',
    'apps/worker/src/reasoning/invoke.ts', 'scripts/run-isolated-reasoning-journey.ts'];
  for (const path of requiredSources) assert.ok(r.source.files.some(f => f.path === path && /^[a-f0-9]{64}$/.test(f.sha256)), path);
  assert.equal(new Set(r.source.files.map(f => f.path)).size, r.source.files.length);
  assert.match(r.database.name, /^knowscroll_j004_[a-f0-9]+$/);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(r.database.host));
  assert.ok(Number.isInteger(r.database.port) && r.database.port > 0);
  assert.equal(r.cleanup.databaseAbsent, true); assert.equal(r.cleanup.processesExited, true);
  assert.ok(finiteTime(r.cleanup.checkedAt));
  const fixtureUrl = new URL(r.fixture.baseUrl);
  assert.equal(fixtureUrl.protocol, 'http:'); assert.equal(fixtureUrl.hostname, '127.0.0.1');
  assert.ok(r.processes.length >= 4, 'separate API, fixture and replacement workers required');
  assert.equal(new Set(r.processes.map(p => p.pid)).size, r.processes.length);
  assert.ok(r.processes.some(p => p.role === 'api'));
  assert.ok(r.processes.some(p => p.role === 'fixture'));
  const workerPids = new Set(r.processes.filter(p => p.role.startsWith('worker')).map(p => p.pid));
  assert.ok(workerPids.size >= 2);
  for (const p of r.processes) {
    assert.ok(Number.isInteger(p.pid) && p.pid > 1); assert.equal(p.pgid, p.pid);
    assert.ok(finiteTime(p.startedAt) && finiteTime(p.exitedAt));
    assert.ok(p.exitCode !== null || p.signal !== null, 'child exit must be observed');
    assert.ok(Date.parse(p.exitedAt!) <= Date.parse(r.cleanup.checkedAt));
  }
  assert.deepEqual(r.cases.map(c => c.name).sort(), [...requiredCases].sort());
  assert.equal(new Set(r.cases.map(c => c.caseId)).size, r.cases.length);
  const get = (name: string) => r.cases.find(c => c.name === name)!;
  for (const c of r.cases) {
    assert.ok(c.actorPids.length > 0 && c.actorPids.every(pid => workerPids.has(pid)));
    assert.ok(c.barriers.length > 0, `${c.name}: process barriers missing`);
    assert.ok(c.barriers.every(b => finiteTime(b.at) && r.processes.some(p => p.pid === b.pid)));
    assert.ok(c.snapshots.length > 0 && c.snapshots.every(s => finiteTime(s.at)));
    const requests = r.fixture.requests.filter(q => q.caseId === c.caseId);
    assert.equal(c.fixtureCountAfter - c.fixtureCountBefore, requests.length, `${c.name}: fixture count mismatch`);
    assert.ok(requests.length <= 1, `${c.name}: replayed HTTP request`);
    for (const q of requests) {
      assert.equal(q.attemptId, c.identities.attemptId);
      assert.equal(q.requestId, c.identities.requestId); assert.equal(q.dispatchId, c.identities.dispatchId);
      assert.equal(q.bodyHash, c.identities.requestHash);
      assert.equal(q.pid, r.processes.find(p => p.role === 'fixture')!.pid);
      const a = q.committedIntent;
      assert.equal(a.attempt_id, q.attemptId); assert.equal(a.request_id, q.requestId); assert.equal(a.dispatch_id, q.dispatchId);
      assert.equal(a.state, 'dispatch_committed', 'fixture must observe committed intent before response');
      assert.ok(finiteTime(a.dispatch_committed_at) && Date.parse(String(a.dispatch_committed_at)) <= Date.parse(q.observedAt));
    }
    // Every retained receipt/settlement must resolve back to the original accounting identity.
    for (const s of c.snapshots) {
      for (const e of s.receipts) {
        const a = s.accounting.find(a => a.attempt_id === e.attempt_id); assert.ok(a);
        for (const key of ['universe_id', 'privacy_epoch', 'request_id', 'dispatch_id', 'route_id', 'route_profile_version']) assert.equal(e[key], a[key]);
        for (const key of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_micro_usd']) {
          assert.ok(e[key] === null || count(e[key]) >= 0n, 'nullable usage must be explicit');
        }
      }
      for (const settlement of s.settlements) {
        assert.ok(s.receipts.some(e => e.id === settlement.receipt_id && e.attempt_id === settlement.attempt_id && e.fingerprint === settlement.receipt_fingerprint));
      }
      for (const adjustment of s.adjustments) {
        assert.ok(s.settlements.some(e => e.id === adjustment.settlement_id && e.attempt_id === adjustment.attempt_id));
        assert.ok(s.reservations.some(e => e.bucket_id === adjustment.bucket_id && e.attempt_id === adjustment.attempt_id));
      }
    }
  }
  assert.ok(r.fixture.requests.every(q => r.cases.some(c => c.caseId === q.caseId)), 'unattributed HTTP request');
  for (const name of ['death_before_intent', 'death_after_intent', 'death_after_http']) {
    const c = get(name);
    assert.ok(c.actorPids.some(pid => r.processes.some(p => p.pid === pid && p.signal === 'SIGKILL')), `${name}: no actual killed worker`);
    assert.ok(c.actorPids.length >= 2, 'recovery must use another worker');
  }
  for (const name of ['death_before_intent', 'death_after_intent', 'lost_commit_ack', 'lease_replacement', 'cancel_before_dispatch', 'deadline_before_dispatch', 'receipt_revisions', 'capacity_contention', 'blocked_universe']) {
    assert.equal(r.fixture.requests.filter(q => q.caseId === get(name).caseId).length, 0, name);
  }
  for (const name of ['death_after_http', 'cancel', 'deadline', 'clear_late_receipt']) {
    assert.equal(r.fixture.requests.filter(q => q.caseId === get(name).caseId).length, 1, name);
  }
  for (const [name, label] of [['death_before_intent', 'recovered_not_sent'], ['cancel_before_dispatch', 'cancel_not_sent'], ['deadline_before_dispatch', 'deadline_not_sent']]) {
    const c = get(name!), s = snapshot(c, label!), a = accounting(c, s);
    assert.equal(a.state, 'not_sent'); assert.equal(a.dispatch_id, null); assert.equal(a.output_authority, 'withdrawn');
    assert.equal(a.remote_state, 'released'); assert.equal(a.liability_state, 'settled');
    assert.ok(s.buckets.length === 6 && s.buckets.every(b => count(b.reserved) === 0n && count(b.consumed) === 0n));
    assert.equal(s.reservations.length, 6); assert.ok(s.reservations.every(r => r.state === 'released'));
  }
  unknownHeld(get('death_after_intent'), snapshot(get('death_after_intent'), 'unknown_no_request'));
  unknownHeld(get('death_after_http'), snapshot(get('death_after_http'), 'recovered_unknown'));
  settled(get('death_after_http'), snapshot(get('death_after_http'), 'late_usage_settled'), 10n);
  for (const name of ['death_after_intent', 'death_after_http', 'lost_commit_ack', 'lease_replacement']) denied(get(name));
  {
    const c = get('lost_commit_ack'), s = snapshot(c, 'intent_without_transport_grant'), a = accounting(c, s);
    assert.ok(['unknown', 'dispatch_committed'].includes(String(a.state)));
    assert.equal(a.dispatch_id, c.identities.dispatchId); assert.equal(a.remote_state, 'held'); assert.equal(a.liability_state, 'held');
    assert.ok(c.operations.some(o => denial(o) === 'fixture_lost_commit_ack'));
    assert.ok(c.actorPids.length >= 2, 'lost-ack replacement must be another worker');
    assert.ok(s.permit.some(p => p.state === 'consumed' && p.dispatch_id === a.dispatch_id));
  }
  unknownHeld(get('cancel'), snapshot(get('cancel'), 'cancel_unknown'));
  unknownHeld(get('deadline'), snapshot(get('deadline'), 'deadline_unknown'));
  {
    const c = get('lease_replacement'), s = snapshot(c, 'recovery_fence_stale_a_denied');
    assert.ok(c.actorPids.length >= 2, 'replacement must run in a distinct worker');
    const job = s.job.find(j => j.id === c.identities.jobId); assert.ok(job);
    assert.ok(count(job.lease_fence) > count(c.identities.leaseFence), 'replacement fence did not advance');
    assert.equal(accounting(c, s).dispatch_id, null, 'stale A dispatched');
  }
  {
    const c = get('clear_late_receipt'), cleared = snapshot(c, 'cleared_response_paused');
    noPrivateState(cleared);
    assert.ok(count(cleared.universe[0]!.privacy_epoch) > count(c.identities.privacyEpoch));
    assert.equal(accounting(c, cleared).output_authority, 'withdrawn');
    const late = snapshot(c, 'late_usage_settled');
    noPrivateState(late); settled(c, late, 10n);
    const before = snapshot(c, 'later_activity_before_clear_replay'), after = snapshot(c, 'old_clear_replay_preserved_later');
    assert.ok(before.job.length > 0 && before.reservations.length > 0, 'later activity was never created');
    const {label: _l, at: _t, ...beforeRows} = before;
    const {label: _l2, at: _t2, ...afterRows} = after;
    assert.deepEqual(afterRows, beforeRows, 'old clear replay changed later state');
  }
  {
    const c = get('receipt_revisions'), first = snapshot(c, 'first_usage'), duplicate = snapshot(c, 'duplicate_usage');
    assert.equal(accounting(c, first).remote_state, 'held');
    assert.equal(accounting(c, first).liability_state, 'held');
    assert.equal(first.receipts.length, 1); assert.equal(first.settlements.length, 1);
    assert.equal(first.receipts[0]!.output_tokens, null);
    for (const key of ['accounting', 'reservations', 'buckets', 'receipts', 'settlements', 'adjustments'] as const) {
      assert.deepEqual(duplicate[key], first[key], `exact receipt replay changed ${key}`);
    }
    const terminal = snapshot(c, 'terminal_unknown_usage'), a = accounting(c, terminal);
    assert.equal(a.remote_state, 'released'); assert.equal(a.liability_state, 'held');
    assert.equal(a.all_duties_closed_at, null, 'unknown financial liability started retention clock');
    assert.ok(terminal.buckets.some(b => b.dimension === 'remote_concurrency' && count(b.reserved) === 0n));
    assert.ok(terminal.buckets.filter(b => b.dimension !== 'remote_concurrency').every(b => count(b.reserved) > 0n));
    const cumulative = snapshot(c, 'cumulative_usage');
    assert.equal(accounting(c, cumulative).liability_state, 'settled');
    assert.equal(cumulative.settlements.length, 3);
    assert.ok(cumulative.buckets.every(b => count(b.reserved) === 0n
      && count(b.consumed) === (b.dimension === 'remote_concurrency' ? 0n : 12n)));
    const revised = snapshot(c, 'revised_usage'), overage = snapshot(c, 'overage_usage');
    for (const [s, total] of [[revised, 15n], [overage, 205n]] as const) {
      assert.ok(s.buckets.every(b => count(b.reserved) === 0n
        && count(b.consumed) === (b.dimension === 'remote_concurrency' ? 0n : total)));
    }
    assert.equal(revised.settlements.length, 4); assert.equal(overage.settlements.length, 5);
    const revisedId = revised.settlements.at(-1)!.id, overageId = overage.settlements.at(-1)!.id;
    for (const [s, id, delta] of [[revised, revisedId, 3n], [overage, overageId, 190n]] as const) {
      const changes = s.adjustments.filter(a => a.settlement_id === id);
      assert.equal(changes.length, 5); assert.ok(changes.every(a => count(a.delta) === delta));
    }
    assert.ok(overage.buckets.filter(b => b.dimension !== 'remote_concurrency').every(b => b.paused === true));
    const conflict = snapshot(c, 'conflicting_usage');
    for (const key of ['accounting', 'reservations', 'buckets', 'receipts', 'settlements', 'adjustments'] as const) {
      assert.deepEqual(conflict[key], overage[key], `same-ID conflict rewrote ${key}`);
    }
    denied(c, 'conflict');
    const frozen = snapshot(c, 'decreasing_usage_frozen');
    assert.equal(accounting(c, frozen).review_required, true);
    assert.equal(accounting(c, frozen).all_duties_closed_at, null);
    assert.equal(frozen.receipts.length, overage.receipts.length + 1, 'conflicting new evidence should remain inspectable');
    assert.equal(frozen.settlements.length, overage.settlements.length + 1, 'review evidence needs its own revision');
    assert.deepEqual(frozen.settlements.slice(0, -1), overage.settlements, 'decreasing evidence rewrote prior revisions');
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_micro_usd']) {
      assert.equal(frozen.settlements.at(-1)![key], overage.settlements.at(-1)![key], 'decreasing evidence changed accepted usage');
    }
    assert.deepEqual(frozen.adjustments, overage.adjustments, 'decreasing evidence refunded accepted usage');
    assert.ok(frozen.buckets.every(b => b.paused === true));
  }
  {
    const c = get('capacity_contention');
    const contenders = [snapshot(c, 'one_capacity_winner'), snapshot(c, 'second_capacity_contender')];
    assert.equal(contenders.reduce((n, s) => n + s.attempt.length, 0), 1);
    assert.equal(contenders.reduce((n, s) => n + s.accounting.length, 0), 1);
    assert.equal(contenders.reduce((n, s) => n + s.permit.length, 0), 1);
    assert.equal(contenders.reduce((n, s) => n + s.reservations.length, 0), 6);
    const loser = contenders.find(s => s.attempt.length === 0)!;
    assert.equal(loser.accounting.length, 0); assert.equal(loser.permit.length, 0); assert.equal(loser.reservations.length, 0);
    assert.ok(loser.buckets.filter(b => ['owner_budget', 'job_budget'].includes(String(b.dimension))).every(b => count(b.reserved) === 0n));
    for (const s of contenders) assert.ok(s.buckets.every(b => count(b.reserved) + count(b.consumed) <= count(b.capacity)));
    const outcomes = c.operations.find(o => o.name === 'concurrent_reserve')?.result;
    assert.ok(Array.isArray(outcomes) && outcomes.length === 2);
    assert.equal(outcomes.filter(o => o.denial === 'insufficient_capacity').length, 1);
  }
  {
    const c = get('blocked_universe'), s = snapshot(c, 'other_universe_progress');
    const job = s.job.find(j => j.id === c.identities.jobId); assert.ok(job);
    assert.equal(job.status, 'running'); assert.ok(count(job.lease_fence) > 0n);
    const claim = c.operations.find(o => o.name === 'claim')?.result as Record<string, unknown>;
    assert.equal(claim.jobId, c.identities.jobId); assert.notEqual(claim.universeId, c.identities.blockedUniverseId);
  }
  return {journey: 'J004' as const, result: 'passed' as const, cases: r.cases.length, fixtureRequests: r.fixture.requests.length};
}
