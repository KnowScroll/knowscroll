import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  CUTROOM_CHAIN_UPSTREAM_REVISION,
  CUTROOM_CHAIN_LIMITS,
  lintCutroomCommission,
  prepareCutroomCommission,
  type CutroomCommissionScript,
  type CutroomChainInput,
  type CutroomChainStatusSnapshot,
  type CutroomChainResultSnapshot,
  type CutroomChainRecordSnapshot,
} from './commission-contracts.js';
import { validatePinnedCutroomChain as validate } from './commission-chain.js';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
/** Authored fixture metadata only; no owner approval, provider call, media or engine run. */
function prepared() {
  const excerpt = 'An explicitly fictional object.';
  const script: CutroomCommissionScript = {
    policyVersion: 'cutroom-commission.v1',
    scriptVersion: 'fictional.v1',
    title: 'Fictional chain fixture',
    evidence: {
      version: 'cutroom-public-evidence.v1',
      reviewRef: 'fixture-not-reviewed',
      sources: [
        {
          id: 'source',
          url: 'https://example.invalid/fiction',
          retrievedAt: '2026-10-21T00:00:00.000Z',
          excerpt,
          excerptSha256: hash(excerpt),
        },
      ],
    },
    claims: [
      {
        id: 'claim',
        role: 'main',
        statement: excerpt,
        support: [{ sourceId: 'source', excerptSha256: hash(excerpt) }],
      },
    ],
    narration: Array.from({ length: 6 }, (_, i) => ({
      text: `The fictional object appears in scene ${i}.`,
      claimIds: ['claim'],
    })),
    criteria: {
      mustShow: [{ id: 'show', text: 'A fictional object', type: 'presence', claimId: 'claim' }],
      mustNotShow: [],
      depictionPolicyVersion: 'fixture.v1',
    },
    style: { id: 'fictional', version: 1, text: 'An authored test illustration' },
  };
  const lint = lintCutroomCommission(script);
  if (lint.kind !== 'valid') throw new Error('Authored fixture lint failed');
  const p = prepareCutroomCommission(
    script,
    { ref: 'fixture-NOT-human-approval', scriptSha256: lint.scriptSha256 },
    { take: 1, worldId: 'dev', ceilingCents: 75 },
  );
  if (p.kind !== 'prepared') throw new Error('Authored compiler fixture failed');
  return p;
}
type Run = {
  status: CutroomChainStatusSnapshot;
  result: CutroomChainResultSnapshot;
  record: CutroomChainRecordSnapshot;
  closing: CutroomChainStatusSnapshot;
};
function run(runId = 'fictional-original', costCents = 34): Run {
  const status: CutroomChainStatusSnapshot = {
    contractVersion: 1,
    runId,
    requestId: prepared().requestId,
    state: 'finished',
    lastSeq: 5,
  };
  const record: CutroomChainRecordSnapshot = {
    contractVersion: 1,
    runId,
    pictures: [
      {
        pictureId: 'fictional-picture',
        shotId: 'shot-0',
        chosen: true,
        observationId: 'picture-observation',
        reconciliationId: 'picture-reconciliation',
        checks: [
          { gate: '1', step: 'technical', outcome: 'accept' },
          { gate: '1', step: 'text', outcome: 'accept' },
          { gate: '1', step: 'witness', outcome: 'accept_with_label' },
          { gate: '1', step: 'reconcile', outcome: 'accept' },
        ],
      },
    ],
    // The second take is deliberately unpictured, as in the retained real single-run imports.
    takes: [0, 1].map((shot) => ({
      takeId: `fictional-take-${shot}`,
      shotId: `shot-${shot}`,
      number: 1,
      used: true,
      observationId: `take-observation-${shot}`,
      reconciliationId: `take-reconciliation-${shot}`,
      checks: (['2', '3', '4', '5'] as const).map((gate) => ({
        gate,
        outcome: gate === '2' ? 'accept_with_label' : 'accept',
      })),
    })),
    degradations: [],
  };
  return {
    status,
    closing: structuredClone(status),
    record,
    result: {
      contractVersion: 1,
      runId,
      requestId: status.requestId,
      costCents,
      status: 'completed',
      until: 'video',
      stills: [{ pictureId: 'fictional-picture', shotId: 'shot-0' }],
      degradations: [],
    },
  };
}
function encode(r: Run): CutroomChainInput['runs'][number] {
  return {
    statusUtf8: JSON.stringify(r.status),
    closingStatusUtf8: JSON.stringify(r.closing),
    resultUtf8: JSON.stringify(r.result),
    recordUtf8: JSON.stringify(r.record),
    openedAtMs: 900,
    resultAtMs: 920,
    recordAtMs: 930,
    closedAtMs: 950,
  };
}
function input(runs = [run()]): CutroomChainInput {
  const p = prepared();
  return {
    upstreamRevision: CUTROOM_CHAIN_UPSTREAM_REVISION,
    validationTimeMs: 1000,
    expected: {
      attemptId: 'fixture-attempt',
      businessRunId: 'fixture-business',
      requestId: p.requestId,
      worldId: 'dev',
      scriptSha256: p.scriptSha256,
      requestSha256: p.requestSha256,
      contractVersion: 1,
      take: 1,
      ceilingCents: 75,
    },
    runs: runs.map(encode),
  };
}
function chain(childCost = 20) {
  const original = run(),
    child = run('fictional-child', childCost);
  original.status.resumedBy = child.status.runId;
  original.closing.resumedBy = child.status.runId;
  original.result = {
    contractVersion: 1,
    runId: original.status.runId,
    requestId: original.status.requestId,
    costCents: 34,
    status: 'failed',
  };
  original.record.pictures.forEach((p) => {
    p.chosen = false;
  });
  original.record.takes.forEach((t) => {
    t.used = false;
  });
  child.status.resumes = original.status.runId;
  child.closing.resumes = original.status.runId;
  child.record.pictures.forEach((p) => {
    p.keptFrom = original.status.runId;
  });
  child.record.takes.forEach((t) => {
    t.keptFrom = original.status.runId;
  });
  return { original, child };
}
function videoResult(r: Run) {
  if (r.result.status !== 'completed' || r.result.until === 'plan') throw new Error('Fixture video result');
  return r.result;
}
describe('pure pinned Cutroom chain (authored projections; no real engine, billing or approval)', () => {
  it('binds actual A compiler identity and preserves unpictured takes/engine labels without exposing raw identities or request bytes', () => {
    const v = input(),
      result = validate(v);
    expect(result).toMatchObject({
      kind: 'complete',
      cost: { kind: 'complete_engine_reported', actualCents: 34, overCeiling: false },
      video: { kind: 'candidate' },
    });
    if (result.kind !== 'complete' || result.video.kind !== 'candidate') throw new Error('Fixture refused');
    expect(result.video.labels).toHaveLength(3);
    expect(result.video.labels.every((l) => l.outcome === 'accept_with_label')).toBe(true);
    expect(result.attestation).toBe('engine-attested-not-independent; cost-not-provider-invoice');
    for (const value of [
      v.expected.requestId,
      v.expected.attemptId,
      'fictional-original',
      'fictional-picture',
      prepared().requestUtf8,
    ])
      expect(JSON.stringify(result)).not.toContain(value);
  });
  it.each([0, 20])(
    'sums distinct own-run costs once across a child costing %i; copied pieces are not charged again',
    (cost) => {
      const { original, child } = chain(cost),
        a = validate(input([original, child])),
        b = validate(input([child, original]));
      expect(a).toEqual(b);
      expect(a).toMatchObject({ kind: 'complete', cost: { actualCents: 34 + cost }, video: { kind: 'candidate' } });
      if (a.kind !== 'complete') throw new Error('Fixture refused');
      expect(a.runs.map((r) => r.ownCostCents)).toEqual([34, cost]);
    },
  );
  it.each(['refused', 'stopped', 'failed', 'cancelled'] as const)(
    'reports complete %s accounting separately from unusable video',
    (status) => {
      const r = run();
      r.result = { contractVersion: 1, runId: r.status.runId, requestId: r.status.requestId, costCents: 12, status };
      r.record.pictures = [];
      r.record.takes = [];
      expect(validate(input([r]))).toMatchObject({
        kind: 'complete',
        cost: { actualCents: 12 },
        video: { kind: 'unavailable', code: 'not_video' },
      });
    },
  );
  it.each(['plan', 'stills'] as const)('never presents completed %s as a video', (until) => {
    const r = run();
    r.result =
      until === 'plan'
        ? {
            contractVersion: 1,
            runId: r.status.runId,
            requestId: r.status.requestId,
            costCents: 0,
            status: 'completed',
            until,
          }
        : { ...videoResult(r), until };
    expect(validate(input([r]))).toMatchObject({ kind: 'complete', video: { kind: 'unavailable', code: 'not_video' } });
  });
  it('uses canonical parsed projection hashes, not property order or raw serialized text', () => {
    const a = input(),
      b = structuredClone(a);
    const status = run().status;
    b.runs[0]!.statusUtf8 = JSON.stringify(Object.fromEntries(Object.entries(status).reverse()), null, 2);
    expect(validate(a)).toEqual(validate(b));
  });
  it.each(['foreign-request', 'wrong-result-run', 'wrong-record-run', 'running-opening', 'changed-closing'])(
    'holds %s instead of inferring completeness',
    (kind) => {
      const r = run();
      if (kind === 'foreign-request') r.result.requestId = 'foreign-request';
      if (kind === 'wrong-result-run') r.result.runId = 'foreign-run';
      if (kind === 'wrong-record-run') r.record.runId = 'foreign-run';
      if (kind === 'running-opening') r.status.state = 'running';
      if (kind === 'changed-closing') r.closing.lastSeq++;
      expect(validate(input([r]))).toEqual({ kind: 'held', code: 'incomplete' });
    },
  );
  it.each(['stale', 'future', 'record-after-close', 'result-before-open'])(
    'holds %s observation times using only explicit inputs',
    (kind) => {
      const v = input(),
        o = v.runs[0]!;
      if (kind === 'stale') v.validationTimeMs = o.openedAtMs + 30001;
      if (kind === 'future') o.closedAtMs = v.validationTimeMs + 1;
      if (kind === 'record-after-close') o.recordAtMs = o.closedAtMs + 1;
      if (kind === 'result-before-open') o.resultAtMs = o.openedAtMs - 1;
      expect(validate(v)).toEqual({ kind: 'held', code: 'incomplete' });
    },
  );
  it.each(['missing-child', 'foreign-parent', 'cycle', 'fork', 'duplicate'])('holds %s topology', (kind) => {
    const { original, child } = chain();
    let runs = [original, child];
    if (kind === 'missing-child') runs = [original];
    if (kind === 'foreign-parent') child.status.resumes = child.closing.resumes = 'foreign-parent';
    if (kind === 'cycle') original.status.resumes = original.closing.resumes = child.status.runId;
    if (kind === 'fork') child.status.resumedBy = child.closing.resumedBy = 'third-run';
    if (kind === 'duplicate') runs = [original, structuredClone(original)];
    expect(validate(input(runs))).toEqual({ kind: 'held', code: 'chain' });
  });
  it('refuses unsupported profile, unbound original request ID, a third run and caller-resume topology', () => {
    expect(validate({ ...input(), upstreamRevision: 'unreviewed' })).toEqual({ kind: 'held', code: 'profile' });
    const v = input();
    v.expected.requestId = 'foreign';
    expect(validate(v)).toEqual({ kind: 'held', code: 'identity' });
    expect(validate(input([run(), run('second'), run('third')]))).toEqual({ kind: 'held', code: 'bounds' });
    const { original, child } = chain();
    original.result.status = 'stopped';
    expect(validate(input([original, child]))).toEqual({ kind: 'held', code: 'profile' });
  });
  it.each([
    'unmarked-reuse',
    'unknown-parent',
    'changed-check',
    'changed-number',
    'changed-shot',
    'changed-observation',
    'missing-parent-piece',
  ])('rejects %s copied ancestry across ALL pieces', (kind) => {
    const { original, child } = chain();
    const t = child.record.takes[1]!;
    if (kind === 'unmarked-reuse') delete t.keptFrom;
    if (kind === 'unknown-parent') t.keptFrom = 'other-parent';
    if (kind === 'changed-check') t.checks[0]!.outcome = 'accept';
    if (kind === 'changed-number') t.number++;
    if (kind === 'changed-shot') t.shotId = 'shot-8';
    if (kind === 'changed-observation') t.observationId = 'wrong-observation';
    if (kind === 'missing-parent-piece') original.record.takes.pop();
    expect(validate(input([original, child]))).toEqual({ kind: 'held', code: 'record' });
  });
  it('rejects original keptFrom, duplicate pieces and duplicate gate checks', () => {
    const r = run();
    r.record.pictures[0]!.keptFrom = 'unknown';
    expect(validate(input([r]))).toEqual({ kind: 'held', code: 'record' });
    delete r.record.pictures[0]!.keptFrom;
    r.record.takes.push(structuredClone(r.record.takes[0]!));
    expect(validate(input([r]))).toEqual({ kind: 'held', code: 'record' });
    r.record.takes.pop();
    r.record.takes[0]!.checks.push(structuredClone(r.record.takes[0]!.checks[0]!));
    expect(validate(input([r]))).toEqual({ kind: 'held', code: 'record' });
  });
  it.each(['missing-picture-gate', 'missing-take-gate', 'failed-picture', 'failed-unpictured'])(
    'keeps known costs while refusing %s video eligibility',
    (kind) => {
      const r = run();
      if (kind === 'missing-picture-gate') r.record.pictures[0]!.checks.pop();
      if (kind === 'missing-take-gate') r.record.takes[1]!.checks.pop();
      if (kind === 'failed-picture') r.record.pictures[0]!.checks[0]!.outcome = 'fail';
      if (kind === 'failed-unpictured') r.record.takes[1]!.checks[0]!.outcome = 'fail';
      expect(validate(input([r]))).toMatchObject({
        kind: 'complete',
        cost: { actualCents: 34 },
        video: { kind: 'unavailable', code: 'gates' },
      });
    },
  );
  it('retains unused failures and actual matching degraded shot coverage without demanding a picture on every used take', () => {
    const r = run();
    r.record.takes[0]!.used = false;
    r.record.takes.push({
      takeId: 'unused-failed',
      shotId: 'shot-9',
      number: 1,
      used: false,
      checks: [{ gate: '2', outcome: 'fail' }],
    });
    r.record.degradations.push({ shotId: 'shot-0', reasonSha256: hash('fixture hold') });
    videoResult(r).degradations = structuredClone(r.record.degradations);
    expect(validate(input([r]))).toMatchObject({ kind: 'complete', video: { kind: 'candidate' } });
  });
  it.each(['duplicate-still', 'wrong-still', 'missing-still', 'degradation-mismatch', 'duplicate-used-shot'])(
    'keeps known cost but refuses %s media metadata',
    (kind) => {
      const r = run(),
        result = videoResult(r);
      if (kind === 'duplicate-still') result.stills.push(structuredClone(result.stills[0]!));
      if (kind === 'wrong-still') result.stills[0]!.pictureId = 'wrong-picture';
      if (kind === 'missing-still') result.stills = [];
      if (kind === 'degradation-mismatch') r.record.degradations.push({ shotId: 'shot-0', reasonSha256: hash('hold') });
      if (kind === 'duplicate-used-shot') r.record.takes[1]!.shotId = r.record.takes[0]!.shotId;
      expect(validate(input([r]))).toMatchObject({
        kind: 'complete',
        cost: { actualCents: 34 },
        video: { kind: 'unavailable', code: 'record' },
      });
    },
  );
  it('reports overage without clamping or a second allowance and holds unsafe sums/fractional costs', () => {
    expect(validate(input([run('overage', 80)]))).toMatchObject({
      kind: 'complete',
      cost: { actualCents: 80, overCeiling: true },
    });
    const { original, child } = chain(1);
    original.result.costCents = Number.MAX_SAFE_INTEGER;
    expect(validate(input([original, child]))).toEqual({ kind: 'held', code: 'cost' });
    expect(validate(input([run('fraction', 0.5)]))).toEqual({ kind: 'held', code: 'incomplete' });
    expect(validate(input([run('negative', -1)]))).toEqual({ kind: 'held', code: 'incomplete' });
  });
  it('bounds UTF8 BEFORE JSON parsing and depth/node/element traversal before hashing; missing record remains incomplete', () => {
    const v = input();
    v.runs[0]!.recordUtf8 = 'é'.repeat(CUTROOM_CHAIN_LIMITS.documentBytes / 2 + 1);
    expect(validate(v)).toEqual({ kind: 'held', code: 'bounds' });
    v.runs[0]!.recordUtf8 = '{"deep":' + '['.repeat(100) + '0' + ']'.repeat(100) + '}';
    expect(validate(v).kind).toBe('held');
    v.runs[0]!.recordUtf8 = JSON.stringify({ extra: Array.from({ length: 12001 }, () => 0) });
    expect(validate(v).kind).toBe('held');
    const r = run();
    r.record.pictures = Array.from({ length: 1001 }, (_, i) => ({
      pictureId: `p${i}`,
      shotId: 'shot-0',
      chosen: false,
      checks: [],
    }));
    expect(validate(input([r])).kind).toBe('held');
    v.runs[0]!.recordUtf8 = 'null';
    expect(validate(v)).toEqual({ kind: 'held', code: 'incomplete' });
    v.runs[0]!.recordUtf8 = 'not-json';
    expect(validate(v)).toEqual({ kind: 'held', code: 'incomplete' });
  });
  it('never returns URL/provider canaries, even when an accepted opaque metadata ID contains one', () => {
    const canary = 'fixture_PROVIDER_CREDENTIAL_CANARY',
      r = run(canary),
      v = input([r]);
    v.expected.attemptId = canary;
    const out = validate(v);
    expect(out.kind).toBe('complete');
    expect(JSON.stringify(out)).not.toContain(canary);
    const url = 'https://example.invalid/file?token=fixture_SECRET_CANARY';
    v.runs[0]!.resultUtf8 = JSON.stringify({ ...r.result, detail: url });
    expect(JSON.stringify(validate(v))).not.toContain('fixture_SECRET_CANARY');
    expect(validate(v).kind).toBe('held');
    v.runs[0]!.resultUtf8 = JSON.stringify({ ...r.result, video: { path: url } });
    expect(validate(v).kind).toBe('held');
  });
  it('checks authored raw examples against REAL immutable v1 schemas, then accepts ONLY the sanitized projections', async () => {
    const load = async (file: string) =>
      (await import(new URL(`../adapters/cutroom/wire-v1/${file}.ts`, import.meta.url).href)) as Record<
        string,
        z.ZodType
      >;
    const { RunStatus, RunResult } = await load('responses'),
      { RunRecord } = await load('record'),
      { SubmitRequest } = await load('request');
    const r = run(),
      p = prepared(),
      result = videoResult(r);
    expect(SubmitRequest!.safeParse(JSON.parse(p.requestUtf8)).success).toBe(true);
    expect(RunStatus!.safeParse(r.status).success).toBe(true);
    expect(RunRecord!.safeParse(r.record).success).toBe(true);
    const raw = {
      ...result,
      estimateCents: 1,
      stills: result.stills.map((s) => ({ ...s, path: '/fictional/artifact.jpg' })),
      video: { path: '/fictional/render.mp4' },
    };
    expect(RunResult!.safeParse(raw).success).toBe(true);
    const v = input([r]);
    v.runs[0]!.resultUtf8 = JSON.stringify(raw);
    expect(validate(v).kind).toBe('held');
    expect(validate(input([r])).kind).toBe('complete');
  });
});
