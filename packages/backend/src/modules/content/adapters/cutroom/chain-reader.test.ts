import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMarkedTransaction } from '../../../../infrastructure/postgres/transaction-marker.js';
import { makeCutroomChainCollector } from './chain-reader.js';
import {
  CUTROOM_CHAIN_UPSTREAM_REVISION,
  type CutroomChainInput,
  type CutroomChainCollectorSettings,
} from '../../production/commission-contracts.js';

// Authored HTTP wire fixtures only. No installation, owner approval, provider or money evidence.
const canary = 'https://user:private-key@example.invalid/video?signature=DO-NOT-RECORD#credential';
const expected: CutroomChainInput['expected'] = {
  attemptId: 'fictional-attempt',
  businessRunId: 'fictional-business',
  requestId: `ks-reel-${'a'.repeat(32)}-1`,
  worldId: 'dev',
  scriptSha256: 'a'.repeat(64),
  requestSha256: 'b'.repeat(64),
  contractVersion: 1,
  take: 1,
  ceilingCents: 75,
};
const settings = (): CutroomChainCollectorSettings => ({
  enabled: true,
  origin: 'http://127.0.0.1:9876',
  profile: {
    upstreamRevision: CUTROOM_CHAIN_UPSTREAM_REVISION,
    soleWriterEvidenceSha256: 'c'.repeat(64),
    observedAtMs: 1000,
    expiresAtMs: 31000,
  },
  now: () => 1000,
});
const status = (runId = 'fictional-original') => ({
  contractVersion: 1,
  runId,
  requestId: expected.requestId,
  state: 'finished',
  lastSeq: 8,
});
const record = (runId = 'fictional-original') => ({
  contractVersion: 1,
  runId,
  pictures: [
    {
      pictureId: 'fictional-picture',
      shotId: 'shot-0',
      chosen: true,
      checks: ['technical', 'text', 'witness', 'reconcile'].map((step) => ({
        gate: '1',
        step,
        outcome: step === 'witness' ? 'accept_with_label' : 'accept',
      })),
    },
  ],
  takes: [
    {
      takeId: 'fictional-take',
      shotId: 'shot-0',
      number: 1,
      used: true,
      checks: ['2', '3', '4', '5'].map((gate) => ({ gate, outcome: 'accept' })),
    },
  ],
  degradations: [{ shotId: 'shot-0', reason: canary }],
});
const common = (runId = 'fictional-original', costCents = 34) => ({
  contractVersion: 1,
  runId,
  requestId: expected.requestId,
  costCents,
});
const video = (runId = 'fictional-original', costCents = 34) => ({
  ...common(runId, costCents),
  status: 'completed',
  until: 'video',
  estimateCents: 50,
  stills: [{ pictureId: 'fictional-picture', shotId: 'shot-0', path: canary }],
  video: { path: canary },
  degradations: record(runId).degradations,
});
const response = (value: unknown, code = 200) =>
  new Response(JSON.stringify(value), { status: code, headers: { 'content-type': 'application/json' } });
function replies(values: unknown[]) {
  const mock = vi.fn(() => Promise.resolve(response(values.shift())));
  vi.stubGlobal('fetch', mock);
  return mock;
}
function single(result: unknown = video(), rec: unknown = record(), closing: unknown = status()) {
  return replies([{ contractVersion: 1, ready: true }, status(), result, rec, closing]);
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('GET-only bounded Cutroom collector (authored wire fixtures)', () => {
  it('collects full canonical wire, privately projects paths/details, and preserves labelled engine accounting', async () => {
    const mock = single();
    const result = await makeCutroomChainCollector(settings()).collect(expected);
    expect(result).toMatchObject({
      kind: 'observed',
      calls: 5,
      observedAtMs: 1000,
      report: { kind: 'complete', cost: { actualCents: 34 }, video: { kind: 'candidate', labels: [{ gate: '1' }] } },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private-key|signature|credential|example.invalid|fictional-original|fictional-picture|fictional-take/,
    );
    expect(mock.mock.calls).toHaveLength(5);
  });

  it.each([
    { status: 'completed', until: 'plan', estimateCents: 0 },
    { status: 'completed', until: 'stills', estimateCents: 40, stills: [], degradations: [] },
    { status: 'refused', reason: 'budget', limit: 'reel', estimateCents: 80, ceilingCents: 75, capCents: 75 },
    { status: 'stopped', reason: 'budget', limit: 'ceiling', estimateCents: 80, ceilingCents: 75, capCents: 75 },
    { status: 'stopped', reason: 'rule', rule: canary, step: canary, detail: canary },
    { status: 'failed', detail: canary },
    { status: 'cancelled' },
  ])('keeps own liability for terminal $status/$until without requiring video', async (ending) => {
    const costCents = 'until' in ending && ending.until === 'plan' ? 0 : 34;
    single({ ...common('fictional-original', costCents), ...ending });
    const result = await makeCutroomChainCollector(settings()).collect(expected);
    expect(result).toMatchObject({
      kind: 'observed',
      report: { kind: 'complete', cost: { actualCents: costCents }, video: { kind: 'unavailable', code: 'not_video' } },
    });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it('does not coerce an invalid full terminal arm into a valid sanitized projection', async () => {
    const bad = video();
    single({ ...bad, estimateCents: '50' });
    expect(await makeCutroomChainCollector(settings()).collect(expected)).toEqual({
      kind: 'unknown',
      code: 'protocol',
    });
  });

  it.each([0, 20])(
    'follows a newest-child lookup and closes both runs after all records (child cost %s)',
    async (cost) => {
      const parent = { ...status(), resumedBy: 'fictional-child' };
      const child = { ...status('fictional-child'), resumes: parent.runId };
      const childRecord = record(child.runId);
      const childCopied = {
        ...childRecord,
        pictures: childRecord.pictures.map((p) => ({ ...p, keptFrom: parent.runId })),
        takes: childRecord.takes.map((p) => ({ ...p, keptFrom: parent.runId })),
      };
      const mock = replies([
        { contractVersion: 1, ready: true },
        child,
        parent,
        video(child.runId, cost),
        childCopied,
        { ...common(), status: 'failed', detail: canary },
        record(),
        child,
        parent,
      ]);
      const result = await makeCutroomChainCollector(settings()).collect(expected);
      expect(result).toMatchObject({ kind: 'observed', calls: 9, report: { cost: { actualCents: 34 + cost } } });
      expect(mock.mock.calls).toHaveLength(9);
    },
  );

  it('retains safe overage while ancestry laundering and failed selected gates do not become publication permission', async () => {
    single(video('fictional-original', 80));
    expect(await makeCutroomChainCollector(settings()).collect(expected)).toMatchObject({
      kind: 'observed',
      report: { cost: { actualCents: 80, overCeiling: true } },
    });
    const bad = record();
    bad.takes[0]!.checks[0]!.outcome = 'fail';
    single(video(), bad);
    expect(await makeCutroomChainCollector(settings()).collect(expected)).toMatchObject({
      kind: 'observed',
      report: { cost: { actualCents: 34 }, video: { kind: 'unavailable', code: 'gates' } },
    });
    single(video(), { ...record(), pictures: [{ ...record().pictures[0], keptFrom: 'unknown-ancestor' }] });
    expect(await makeCutroomChainCollector(settings()).collect(expected)).toMatchObject({
      kind: 'observed',
      report: { kind: 'held', code: 'record' },
    });
  });

  it('does not accept a foreign result or record as accounting evidence', async () => {
    for (const [result, rec] of [
      [{ ...video(), requestId: 'foreign-request' }, record()],
      [{ ...video(), runId: 'foreign-run' }, record()],
      [video(), { ...record(), runId: 'foreign-record' }],
    ]) {
      single(result, rec);
      expect(await makeCutroomChainCollector(settings()).collect(expected)).toMatchObject({
        kind: 'observed',
        report: { kind: 'held', code: 'incomplete' },
      });
    }
  });

  it.each(['', '{"contractVersion":', '{"x":1}{"x":2}'])(
    'refuses malformed or multiple JSON values without echo',
    async (body) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(new Response(body, { headers: { 'content-type': 'application/json' } }))),
      );
      expect(await makeCutroomChainCollector(settings()).collect(expected)).toEqual({
        kind: 'unknown',
        code: 'protocol',
      });
    },
  );

  it('uses current closing sequence/topology and never refreshes or loops after a child appears', async () => {
    const mock = single(video(), record(), { ...status(), resumedBy: 'late-child', lastSeq: 9 });
    expect(await makeCutroomChainCollector(settings()).collect(expected)).toEqual({
      kind: 'pending',
      code: 'changing',
    });
    expect(mock).toHaveBeenCalledTimes(5);
  });

  it('holds malformed/forked/foreign topology and unknown identities without following arbitrary paths', async () => {
    for (const first of [
      { ...status(), resumes: 'a', resumedBy: 'b' },
      { ...status(), resumedBy: status().runId },
      { ...status(), requestId: 'foreign' },
      { ...status(), resumedBy: canary },
    ]) {
      const mock = replies([{ contractVersion: 1, ready: true }, first]);
      expect(await makeCutroomChainCollector(settings()).collect(expected)).toEqual({
        kind: 'unknown',
        code: 'protocol',
      });
      expect(mock).toHaveBeenCalledTimes(2);
    }
    const mock = replies([
      { contractVersion: 1, ready: true },
      { ...status(), resumedBy: 'child' },
      { ...status('child'), resumes: 'foreign-parent' },
    ]);
    expect(await makeCutroomChainCollector(settings()).collect(expected)).toEqual({
      kind: 'unknown',
      code: 'protocol',
    });
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('refuses missing/disabled/unsupported/stale profile, untrusted origin and bad expected identity before IO', async () => {
    const mock = replies([]);
    expect(await makeCutroomChainCollector().collect(expected)).toEqual({ kind: 'unavailable', code: 'disabled' });
    for (const origin of [
      'https://127.0.0.1',
      'http://localhost',
      'http://example.invalid',
      'http://127.0.0.1/x',
      'http://user:pass@127.0.0.1',
      'http://127.0.0.1/?x=1',
    ])
      expect(await makeCutroomChainCollector({ ...settings(), origin }).collect(expected)).toEqual({
        kind: 'unavailable',
        code: 'profile',
      });
    for (const profile of [
      undefined,
      { ...settings().profile!, upstreamRevision: 'unknown' },
      { ...settings().profile!, expiresAtMs: 1000 },
      { ...settings().profile!, observedAtMs: 1001 },
      { ...settings().profile!, soleWriterEvidenceSha256: canary },
    ])
      expect(await makeCutroomChainCollector({ ...settings(), profile }).collect(expected)).toEqual({
        kind: 'unavailable',
        code: 'profile',
      });
    expect(await makeCutroomChainCollector(settings()).collect({ ...expected, requestId: 'wrong' })).toEqual({
      kind: 'unavailable',
      code: 'identity',
    });
    expect(mock).not.toHaveBeenCalled();
  });

  it('captures settings once and checks transaction provenance before the first GET', async () => {
    const config = settings(),
      collector = makeCutroomChainCollector(config);
    Object.assign(config.profile!, { upstreamRevision: 'mutated' });
    single();
    expect(await collector.collect(expected)).toMatchObject({ kind: 'observed' });
    const mock = replies([]);
    expect(await runMarkedTransaction('authored-fixture', () => collector.collect(expected))).toEqual({
      kind: 'unknown',
      code: 'protocol',
    });
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([404, 409, 500])('returns finite status for HTTP%s and never records its secret body', async (code) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response({ detail: canary }, code))),
    );
    const result = await makeCutroomChainCollector(settings()).collect(expected);
    expect(result).toEqual({ kind: 'unknown', code: code === 404 ? 'not_found' : 'protocol' });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it('accepts 409 only on result/record and requires exact 200 for successful GET replies', async () => {
    const queue = [response({ contractVersion: 1, ready: true }), response(status()), response(status(), 409)];
    const mock = vi.fn(() => Promise.resolve(queue.shift()!));
    vi.stubGlobal('fetch', mock);
    expect(await makeCutroomChainCollector(settings()).collect(expected)).toEqual({ kind: 'pending', code: 'running' });
    expect(mock).toHaveBeenCalledTimes(3);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response({ contractVersion: 1, ready: true }, 201))),
    );
    expect(await makeCutroomChainCollector(settings()).collect(expected)).toEqual({
      kind: 'unknown',
      code: 'protocol',
    });
  });

  it('treats not-ready/running as pending work without result or POST calls', async () => {
    const notReady = vi.fn(() => Promise.resolve(response({ contractVersion: 1, ready: false }, 503)));
    vi.stubGlobal('fetch', notReady);
    expect(await makeCutroomChainCollector(settings()).collect(expected)).toEqual({
      kind: 'unavailable',
      code: 'not_ready',
    });
    expect(notReady).toHaveBeenCalledTimes(1);
    const running = replies([
      { contractVersion: 1, ready: true },
      { ...status(), state: 'running' },
    ]);
    expect(await makeCutroomChainCollector(settings()).collect(expected)).toEqual({ kind: 'pending', code: 'running' });
    expect(running).toHaveBeenCalledTimes(2);
  });

  it('accepts canonical 503/false only and refuses contradictory readiness status/body pairs', async () => {
    for (const [code, ready] of [
      [503, true],
      [200, false],
    ] as const) {
      const mock = vi.fn(() => Promise.resolve(response({ contractVersion: 1, ready }, code)));
      vi.stubGlobal('fetch', mock);
      expect(await makeCutroomChainCollector(settings()).collect(expected)).toEqual({
        kind: 'unknown',
        code: 'protocol',
      });
      expect(mock).toHaveBeenCalledTimes(1);
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response({ contractVersion: 1, ready: false, detail: canary }, 503))),
    );
    expect(await makeCutroomChainCollector(settings()).collect(expected)).toEqual({
      kind: 'unknown',
      code: 'protocol',
    });
  });

  it('refuses byte, UTF8, raw depth/node and count overflows before accepting recursive wire data', async () => {
    const bodies = [
      new Response(JSON.stringify({ detail: 'é'.repeat(132000) }), { headers: { 'content-type': 'application/json' } }),
      new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } }),
      response({ nested: Array.from({ length: 12001 }, () => 0) }),
      new Response(`${'{"x":'.repeat(14)}0${'}'.repeat(14)}`, { headers: { 'content-type': 'application/json' } }),
    ];
    for (const [index, body] of bodies.entries()) {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(body)),
      );
      expect(await makeCutroomChainCollector(settings()).collect(expected)).toEqual({
        kind: 'unknown',
        code: index === 1 ? 'protocol' : 'bounds',
      });
    }
    single(video(), {
      ...record(),
      pictures: Array.from({ length: 1001 }, () => ({ pictureId: 'x', shotId: 'shot-0', chosen: false, checks: [] })),
    });
    expect(await makeCutroomChainCollector(settings()).collect(expected)).toMatchObject({ kind: 'unknown' });
  });

  it('refuses expiry after an HTTP wait and clock reversal without producing an observed report', async () => {
    for (const next of [31000, 999]) {
      let now = 1000;
      const mock = vi.fn(() => {
        now = next;
        return Promise.resolve(response({ contractVersion: 1, ready: true }));
      });
      vi.stubGlobal('fetch', mock);
      expect(await makeCutroomChainCollector({ ...settings(), now: () => now }).collect(expected)).toEqual({
        kind: 'unknown',
        code: 'deadline',
      });
      expect(mock).toHaveBeenCalledTimes(1);
    }
  });

  it('bounds a stalled body even when cancellation itself never acknowledges', async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"private":"'));
      },
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        return new Promise<void>(() => undefined);
      },
    });
    const mock = vi.fn(() =>
      Promise.resolve(new Response(stream, { headers: { 'content-type': 'application/json' } })),
    );
    vi.stubGlobal('fetch', mock);
    const promise = makeCutroomChainCollector(settings()).collect(expected);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await promise).toEqual({ kind: 'unknown', code: 'deadline' });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('never accepts a late response even when a transport ignores its abort signal', async () => {
    vi.useFakeTimers();
    const mock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(response({ contractVersion: 1, ready: true })), 6000);
        }),
    );
    vi.stubGlobal('fetch', mock);
    const promise = makeCutroomChainCollector(settings()).collect(expected);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await promise).toEqual({ kind: 'unknown', code: 'deadline' });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('aborts a stalled call after the fixed 5s deadline without retry', async () => {
    vi.useFakeTimers();
    const mock = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error(canary)), { once: true });
        }),
    );
    vi.stubGlobal('fetch', mock);
    const promise = makeCutroomChainCollector(settings()).collect(expected);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await promise).toEqual({ kind: 'unknown', code: 'deadline' });
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
