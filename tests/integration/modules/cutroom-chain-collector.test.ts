import { makeCutroomChainCollector } from '@knowscroll/backend/modules/content/nest-providers';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CUTROOM_CHAIN_UPSTREAM_REVISION, type CutroomChainInput } from '@knowscroll/backend/modules/content';

// Real local HTTP transport, entirely authored wire data. No Cutroom/provider/media/paid work.
const secret = 'https://user:DO-NOT-RECORD@example.invalid/artifact?signature=private#credential';
const expected: CutroomChainInput['expected'] = {
  attemptId: 'http-fixture-attempt',
  businessRunId: 'http-fixture-business',
  requestId: `ks-reel-${'d'.repeat(32)}-1`,
  worldId: 'dev',
  scriptSha256: 'd'.repeat(64),
  requestSha256: 'e'.repeat(64),
  contractVersion: 1,
  take: 1,
  ceilingCents: 75,
};
const status = (runId = 'http-original') => ({
  contractVersion: 1,
  runId,
  requestId: expected.requestId,
  state: 'finished',
  lastSeq: 10,
});
const common = (runId = 'http-original', costCents = 34) => ({
  contractVersion: 1,
  runId,
  requestId: expected.requestId,
  costCents,
});
function record(runId = 'http-original') {
  return {
    contractVersion: 1,
    runId,
    pictures: [
      {
        pictureId: 'http-picture',
        shotId: 'shot-0',
        chosen: true,
        observationId: 'http-observation',
        reconciliationId: 'http-reconciliation',
        checks: ['technical', 'text', 'witness', 'reconcile'].map((step) => ({
          gate: '1',
          step,
          outcome: step === 'witness' ? 'accept_with_label' : 'accept',
        })),
      },
    ],
    takes: [
      {
        takeId: 'http-take',
        shotId: 'shot-0',
        number: 1,
        used: true,
        checks: ['2', '3', '4', '5'].map((gate) => ({ gate, outcome: 'accept' })),
      },
    ],
    degradations: [{ shotId: 'shot-0', reason: secret }],
  };
}
const video = (runId = 'http-original', costCents = 34) => ({
  ...common(runId, costCents),
  status: 'completed',
  until: 'video',
  estimateCents: 60,
  stills: [{ pictureId: 'http-picture', shotId: 'shot-0', path: secret }],
  video: { path: secret },
  degradations: record().degradations,
});
function json(res: ServerResponse, value: unknown, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}
let server: Server | undefined;
async function start(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const hits: { method: string; url: string }[] = [];
  server = createServer((req, res) => {
    hits.push({ method: req.method ?? '', url: req.url ?? '' });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture address');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    hits,
    collector: () => {
      const now = Date.now();
      return makeCutroomChainCollector({
        enabled: true,
        origin,
        profile: {
          upstreamRevision: CUTROOM_CHAIN_UPSTREAM_REVISION,
          soleWriterEvidenceSha256: 'f'.repeat(64),
          observedAtMs: now,
          expiresAtMs: now + 30000,
        },
      });
    },
  };
}
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  }
});
function fixture(childCost?: number, childFirst = false) {
  const parent = childCost === undefined ? status() : { ...status(), resumedBy: 'http-child' };
  const child = { ...status('http-child'), resumes: parent.runId };
  const records = new Map<string, unknown>([
    [
      parent.runId,
      childCost === undefined
        ? record()
        : {
            ...record(),
            pictures: record().pictures.map((p) => ({ ...p, chosen: false })),
            takes: record().takes.map((t) => ({ ...t, used: false })),
          },
    ],
  ]);
  if (childCost !== undefined)
    records.set(child.runId, {
      ...record(child.runId),
      pictures: record().pictures.map((p) => ({ ...p, keptFrom: parent.runId })),
      takes: record().takes.map((t) => ({ ...t, keptFrom: parent.runId })),
    });
  const routes = new Map<string, unknown>([
    ['/v1/ready', { contractVersion: 1, ready: true }],
    [`/v1/runs?requestId=${expected.requestId}`, childFirst ? child : parent],
    [`/v1/runs/${parent.runId}`, parent],
    [
      `/v1/runs/${parent.runId}/result`,
      childCost === undefined ? video() : { ...common(), status: 'failed', detail: secret },
    ],
    [`/v1/runs/${parent.runId}/record`, records.get(parent.runId)],
  ]);
  if (childCost !== undefined) {
    routes.set(`/v1/runs/${child.runId}`, child);
    routes.set(`/v1/runs/${child.runId}/result`, video(child.runId, childCost));
    routes.set(`/v1/runs/${child.runId}/record`, records.get(child.runId));
  }
  return {
    routes,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      const value = routes.get(req.url ?? '');
      json(res, value ?? { error: 'not-found' }, value === undefined ? 404 : 200);
    },
  };
}

describe('C2 collector real fake-HTTP protocol (Actions fixture, not Cutroom)', () => {
  it('is inert without explicit resources and collects one full terminal video with no paths or IDs in output', async () => {
    const f = fixture(),
      h = await start(f.handler);
    expect(await makeCutroomChainCollector().collect(expected)).toEqual({ kind: 'unavailable', code: 'disabled' });
    expect(h.hits).toEqual([]);
    const result = await h.collector().collect(expected);
    expect(result).toMatchObject({
      kind: 'observed',
      calls: 5,
      report: { cost: { actualCents: 34 }, video: { kind: 'candidate' } },
    });
    expect(h.hits).toEqual([
      { method: 'GET', url: '/v1/ready' },
      { method: 'GET', url: `/v1/runs?requestId=${expected.requestId}` },
      { method: 'GET', url: '/v1/runs/http-original/result' },
      { method: 'GET', url: '/v1/runs/http-original/record' },
      { method: 'GET', url: '/v1/runs/http-original' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /DO-NOT-RECORD|signature|example.invalid|http-original|http-picture|http-take/,
    );
  });

  it.each([
    { cost: 0, childFirst: false },
    { cost: 20, childFirst: true },
  ])('collects reciprocal $childFirst child chain with distinct own cost $cost', async ({ cost, childFirst }) => {
    const f = fixture(cost, childFirst),
      h = await start(f.handler);
    const result = await h.collector().collect(expected);
    expect(result).toMatchObject({
      kind: 'observed',
      calls: 9,
      report: { kind: 'complete', cost: { actualCents: 34 + cost }, video: { kind: 'candidate' } },
    });
    expect(h.hits).toHaveLength(9);
    expect(
      h.hits
        .slice(-2)
        .map((r) => r.url)
        .sort(),
    ).toEqual(['/v1/runs/http-child', '/v1/runs/http-original']);
    expect(h.hits.every((r) => r.method === 'GET' && !/events|resume|cancel/.test(r.url))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('validates every actual non-video terminal arm without losing its cost or returning arbitrary text', async () => {
    const f = fixture(),
      h = await start(f.handler);
    for (const ending of [
      { status: 'completed', until: 'plan', estimateCents: 0 },
      { status: 'completed', until: 'stills', estimateCents: 50, stills: [], degradations: [] },
      { status: 'refused', reason: 'budget', limit: 'reel', estimateCents: 80, ceilingCents: 75, capCents: 75 },
      { status: 'stopped', reason: 'budget', limit: 'ceiling', estimateCents: 80, ceilingCents: 75, capCents: 75 },
      { status: 'stopped', reason: 'rule', rule: secret, step: secret, detail: secret },
      { status: 'failed', detail: secret },
      { status: 'cancelled' },
    ]) {
      const costCents = 'until' in ending && ending.until === 'plan' ? 0 : 34;
      f.routes.set('/v1/runs/http-original/result', { ...common('http-original', costCents), ...ending });
      const result = await h.collector().collect(expected);
      expect(result).toMatchObject({
        kind: 'observed',
        report: {
          kind: 'complete',
          cost: { actualCents: costCents },
          video: { kind: 'unavailable', code: 'not_video' },
        },
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    f.routes.set('/v1/runs/http-original/result', { ...common(), status: 'failed' });
    expect(await h.collector().collect(expected)).toEqual({ kind: 'unknown', code: 'protocol' });
  });

  it('observes an autochild immediately but waits without polling when its delayed job is running', async () => {
    const f = fixture(20),
      h = await start(f.handler);
    f.routes.set('/v1/runs/http-child', { ...status('http-child'), resumes: 'http-original', state: 'running' });
    expect(await h.collector().collect(expected)).toEqual({ kind: 'pending', code: 'running' });
    expect(h.hits).toHaveLength(3);
  });

  it('requires a fresh unchanged final closure, without automatic refresh after a topology change', async () => {
    const f = fixture(),
      h = await start(f.handler);
    f.routes.set('/v1/runs/http-original', { ...status(), resumedBy: 'new-child' });
    expect(await h.collector().collect(expected)).toEqual({ kind: 'pending', code: 'changing' });
    expect(h.hits).toHaveLength(5);
  });

  it('refuses foreign/oversized topology before issuing encoded arbitrary URLs or ignoring unsupported extra children', async () => {
    const f = fixture(20),
      h = await start(f.handler);
    f.routes.set('/v1/runs/http-child', { ...status('http-child'), resumes: 'http-original', resumedBy: 'grandchild' });
    expect(await h.collector().collect(expected)).toEqual({ kind: 'unknown', code: 'protocol' });
    expect(h.hits).toHaveLength(3);
    expect(h.hits.some((r) => r.url.includes('grandchild'))).toBe(false);
  });

  it('never follows redirects or retries/refunds on unreachable/404/409/500 metadata', async () => {
    let code = 302;
    const h = await start((_req, res) => {
      res.writeHead(code, { 'content-type': 'application/json', location: secret });
      res.end(JSON.stringify({ error: secret }));
    });
    for (code of [302, 404, 409, 500]) {
      const before = h.hits.length,
        result = await h.collector().collect(expected);
      expect(result).toEqual(
        code === 302
          ? { kind: 'unknown', code: 'unreachable' }
          : code === 404
            ? { kind: 'unknown', code: 'not_found' }
            : { kind: 'unknown', code: 'protocol' },
      );
      expect(h.hits.length - before).toBe(1);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it('keeps a canonical result409 pending while refusing non-200 success codes', async () => {
    const f = fixture();
    let code = 409;
    const h = await start((req, res) => {
      if (req.url?.endsWith('/result')) json(res, status(), code);
      else f.handler(req, res);
    });
    expect(await h.collector().collect(expected)).toEqual({ kind: 'pending', code: 'running' });
    expect(h.hits).toHaveLength(3);
    code = 201;
    expect(await h.collector().collect(expected)).toEqual({ kind: 'unknown', code: 'protocol' });
    expect(h.hits).toHaveLength(6);
  });

  it('bounds streamed UTF8 byte intake before full wire validation, then rejects invalid UTF8/depth/nodes safely', async () => {
    let bytes = Buffer.from(JSON.stringify({ detail: 'é'.repeat(132000) }));
    const h = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(bytes.subarray(0, 65536));
      res.end(bytes.subarray(65536));
    });
    expect(await h.collector().collect(expected)).toEqual({ kind: 'unknown', code: 'bounds' });
    bytes = Buffer.from([0xc3, 0x28]);
    expect(await h.collector().collect(expected)).toEqual({ kind: 'unknown', code: 'protocol' });
    bytes = Buffer.from(`${'{"x":'.repeat(14)}0${'}'.repeat(14)}`);
    expect(await h.collector().collect(expected)).toEqual({ kind: 'unknown', code: 'bounds' });
    bytes = Buffer.from(JSON.stringify({ values: Array.from({ length: 12001 }, () => 0) }));
    expect(await h.collector().collect(expected)).toEqual({ kind: 'unknown', code: 'bounds' });
  });

  it.each(['headers', 'body'])(
    'aborts stalled %s after 5s without another request or leaked failure body',
    async (mode) => {
      const h = await start((_req, res) => {
        if (mode === 'body') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{"private":');
        }
      });
      expect(await h.collector().collect(expected)).toEqual({ kind: 'unknown', code: 'deadline' });
      expect(h.hits).toHaveLength(1);
    },
  );
});
