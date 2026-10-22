/** Actions-only installed API + normal worker + disposable PG. No authored owner ports/provider calls. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ClearExplorationAcceptanceSchema,
  ClearExplorationStatusSchema,
  RecordingObservationBatchResponseSchema,
  RecordingPolicyAcceptanceSchema,
  RecordingPolicyReadSchema,
  RecordingProblemSchema,
  type RecordingObservationBatchRequest,
  type SetRecordingPolicy,
} from '@knowscroll/contracts';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { createEmptyDatabase } from '../support/empty-database.js';
import {
  freePort,
  releaseDirectory,
  startReleaseProcess,
  waitForHttp,
  type ReleaseProcess,
} from '../support/processes.js';

const policyPath = '/v1/privacy/recording';
const batchPath = '/v1/observations/recording-batch';
const canary = 'PRIVATE-RECORDING-HTTP-CANARY';
type Person = { accountId: string; universeId: string; privacyEpoch: number; cookie: string };

describe('recording policy and v2 intake through the installed graph', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let handle: DatabaseHandle<Database>, api: ReleaseProcess, worker: ReleaseProcess, origin: string, assetId: string;
  const secrets = new Set<string>(),
    operatorDiagnostics: string[] = [];
  const headers = (p: Person, epoch = p.privacyEpoch) => ({
    cookie: p.cookie,
    origin,
    'x-ks-scope': `${p.accountId}:${epoch}`,
  });
  const post = (path: string, body: unknown, h: Record<string, string> = {}) =>
    fetch(origin + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...h },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  async function operator(args: readonly string[]) {
    const child = spawn(process.execPath, ['dist/operator.js', ...args], {
      cwd: join(releaseDirectory(), 'api'),
      env: {
        PATH: process.env['PATH'] ?? '',
        KS_WORLD: 'ci',
        DATABASE_URL: database.url,
        KS_PUBLIC_ORIGIN: origin,
        KS_ALLOW_OPERATOR_SIGN_IN: '1',
        KS_OPERATOR_SIGN_IN_PATTERN: '*@recording.test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    expect(await new Promise<number | null>((resolve) => child.once('exit', resolve))).toBe(0);
    operatorDiagnostics.push(stderr);
    return stdout.trim();
  }
  async function born(): Promise<Person> {
    const link = await operator(['issue-sign-in', '--email', `${randomUUID()}@recording.test`]);
    secrets.add(link);
    const url = new URL(link),
      token = url.hash.replace(/^#token=/, '');
    secrets.add(token);
    const response = await post('/auth/redeem', { token, commandId: randomUUID(), client: 'web' }, { origin });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { account: Omit<Person, 'cookie'> };
    const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
    if (!cookie) throw new Error('CI actual sign-in missing cookie');
    secrets.add(cookie);
    secrets.add(cookie.slice(cookie.indexOf('=') + 1));
    expect(
      await handle.db
        .selectFrom('identity.recording_lifecycle_witnesses')
        .select(['origin_kind', 'privacy_epoch'])
        .where('universe_id', '=', body.account.universeId)
        .execute(),
    ).toEqual([{ origin_kind: 'birth', privacy_epoch: 1 }]);
    return { ...body.account, cookie };
  }
  async function read(p: Person, commandId?: string) {
    const input = {
      version: 'recording-policy.v1',
      readId: randomUUID(),
      target: commandId === undefined ? { kind: 'current' } : { kind: 'command', commandId },
    };
    const response = await post(policyPath + '/read', input, headers(p));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const snapshot = RecordingPolicyReadSchema.parse(await response.json());
    expect(snapshot).toMatchObject({
      readId: input.readId,
      target: input.target,
      scope: { accountId: p.accountId, privacyEpoch: p.privacyEpoch },
    });
    return snapshot;
  }
  const command = (p: Person, generation: number, on: boolean): SetRecordingPolicy => ({
    version: 'recording-policy.v1',
    commandId: randomUUID(),
    expectedPrivacyEpoch: p.privacyEpoch,
    expectedRecordingGeneration: generation,
    on,
  });
  async function set(p: Person, input: SetRecordingPolicy) {
    const response = await post(policyPath + '/set', input, headers(p));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    return RecordingPolicyAcceptanceSchema.parse(await response.json());
  }
  async function refusal(response: Response, code: string) {
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = RecordingProblemSchema.parse(await response.json());
    expect(body.code).toBe(code);
    expect(response.status).toBe(body.status);
    expect(JSON.stringify(body)).not.toContain(canary);
  }
  async function activated(p: Person, generation: number) {
    const opened = await post(
      '/v1/experience/open',
      {
        commandId: randomUUID(),
        target: { kind: 'scroll', assetId },
        capabilities: {
          documentSchemas: ['scroll-document.v1'],
          blocks: Object.fromEntries(
            ['fallback', 'paragraph', 'subheading', 'list', 'quote', 'callout', 'disclosure'].map((t) => [t, [1]]),
          ),
        },
      },
      headers(p),
    );
    expect(opened.status).toBe(200);
    const exposure = (await opened.json()) as { exposureId: string; assetRevision: number };
    const input = { commandId: randomUUID(), exposureId: exposure.exposureId, recordingGeneration: generation };
    const response = await post('/v1/experience/activate', input, headers(p));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      commandId: input.commandId,
      exposureId: exposure.exposureId,
      replayed: false,
    });
    expect(
      await handle.db
        .selectFrom('evidence.recording_sessions')
        .select(['session_id', 'recording_generation'])
        .where('universe_id', '=', p.universeId)
        .where('exposure_id', '=', exposure.exposureId)
        .execute(),
    ).toEqual([{ session_id: input.commandId, recording_generation: generation }]);
    const body: RecordingObservationBatchRequest = {
      version: 'observation-batch.v2',
      recordingGeneration: generation,
      instrumentationVersion: 1,
      events: [
        {
          schemaVersion: 'interaction.v1',
          eventId: randomUUID(),
          sessionId: input.commandId,
          exposureId: exposure.exposureId,
          assetId,
          assetRevision: exposure.assetRevision,
          deviceSequence: 1,
          occurredAt: new Date().toISOString(),
          kind: 'scroll.active_dwell',
          payload: { activeIntervalsMs: [[0, 1]] },
        },
      ],
    };
    return { exposure, body };
  }
  async function batch(p: Person, body: RecordingObservationBatchRequest) {
    const response = await post(batchPath, body, headers(p));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const result = RecordingObservationBatchResponseSchema.parse(await response.json());
    expect(result).toMatchObject({
      recordingGeneration: body.recordingGeneration,
      scope: { accountId: p.accountId, privacyEpoch: p.privacyEpoch },
    });
    if (result.result === 'processed')
      expect(result.results.map((r) => r.eventId)).toEqual(body.events.map((e) => e.eventId));
    return result;
  }
  const observations = (p: Person) =>
    handle.db
      .selectFrom('evidence.observations')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .orderBy('id')
      .execute();

  beforeAll(async () => {
    database = await createEmptyDatabase('recording_http');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    handle = createDatabase<Database>(
      { url: database.url, applicationName: 'ci-recording-http', poolMax: 5, statementTimeoutMs: 15000 },
      { onIdleClientError: () => undefined },
    );
    origin = `http://127.0.0.1:${await freePort()}`;
    const imported = JSON.parse(
      await operator([
        'content',
        'import-editorial',
        '--file',
        join(
          releaseDirectory(),
          'api',
          'node_modules',
          '@knowscroll',
          'backend',
          'dist',
          'modules',
          'content',
          'starter',
          'why-the-sky-is-blue.editorial-scroll.json',
        ),
      ]),
    ) as { outcome: string; assetId: string };
    expect(imported.outcome).toBe('created');
    assetId = imported.assetId;
    const shared = {
      NODE_ENV: 'test',
      KS_WORLD: 'ci',
      DATABASE_URL: database.url,
      KS_REASONING_PROVIDER: 'none',
      KS_SHUTDOWN_GRACE_SECONDS: '10',
    };
    api = startReleaseProcess('api', 'main', {
      ...shared,
      PORT: new URL(origin).port,
      KS_PUBLIC_ORIGIN: origin,
      KS_AUTH_ADAPTER: 'session',
      KS_MAIL_SENDER: 'fixture',
      AGENTMAIL_API_KEY: 'fixture-not-a-key',
      AGENTMAIL_INBOX_ID: 'fixture@agentmail.invalid',
      KS_BODY_LIMIT_BYTES: '4096',
      KS_SCOPE_LOCK_TIMEOUT_MS: '5000',
    });
    worker = startReleaseProcess('worker', 'main', shared);
    await Promise.all([api.waitForEvent('process.started'), worker.waitForEvent('process.started')]);
    await waitForHttp(origin + '/health');
  });
  afterAll(async () => {
    try {
      if (worker) expect(await worker.stop()).toBe(0);
      if (api) expect(await api.stop()).toBe(0);
      for (const output of [api?.rawOutput(), worker?.rawOutput(), ...operatorDiagnostics]) {
        if (output === undefined) continue;
        for (const secret of secrets) expect(output).not.toContain(secret);
        expect(output).not.toContain(canary);
      }
      for (const process of [api, worker])
        if (process) expect(process.records.filter((r) => r.event === 'http.unexpected_error')).toEqual([]);
    } finally {
      await handle?.close();
      await database?.drop();
    }
  });
  it('keeps every mounted preparse/auth family private without granting a scope exemption', async () => {
    const p = await born();
    const readBody = { version: 'recording-policy.v1', readId: randomUUID(), target: { kind: 'current' } };
    for (const [route, input] of [
      [policyPath + '/read', readBody],
      [policyPath + '/set', command(p, 1, false)],
      [batchPath, { version: 'observation-batch.v2', recordingGeneration: 1, instrumentationVersion: 1, events: [] }],
    ] as const) {
      await refusal(await post(route, input), 'UNAUTHENTICATED');
      await refusal(
        await post(route, input, { ...headers(p), origin: 'https://foreign.invalid' }),
        'ORIGIN_NOT_ALLOWED',
      );
      await refusal(await post(route, input, headers(p, 2)), 'SCOPE_MISMATCH');
      await refusal(
        await fetch(origin + route, {
          method: 'POST',
          headers: { ...headers(p), 'content-type': 'application/json' },
          body: `{"${canary}":`,
        }),
        'INVALID_REQUEST',
      );
      await refusal(
        await fetch(origin + route, {
          method: 'POST',
          headers: { ...headers(p), 'content-type': 'text/plain' },
          body: canary,
        }),
        'UNSUPPORTED_MEDIA_TYPE',
      );
      await refusal(await post(route, { [canary]: 'x'.repeat(5000) }, headers(p)), 'PAYLOAD_TOO_LARGE');
      await refusal(await post(route, { ...input, [canary]: canary }, headers(p)), 'INVALID_REQUEST');
    }
    expect((await read(p)).policy).toEqual({ on: true, generation: 1 });
    expect(await observations(p)).toEqual([]);
  });
  it('stores genuine activated v2 intake once, refuses paused/stale batches, and separates historical ACK from current permission', async () => {
    const p = await born(),
      initial = await read(p),
      first = await activated(p, 1);
    expect(initial.policy).toEqual({ on: true, generation: 1 });
    expect(await batch(p, first.body)).toMatchObject({ result: 'processed', accepted: 1, duplicates: 0, rejected: 0 });
    expect(await batch(p, first.body)).toMatchObject({ result: 'processed', accepted: 0, duplicates: 1, rejected: 0 });
    const stored = await observations(p);
    expect(stored).toHaveLength(1);
    const pause = command(p, 1, false),
      paused = await set(p, pause);
    expect(paused).toMatchObject({
      replayed: false,
      receipt: { changed: true, fromGeneration: 1, toGeneration: 2, on: false },
    });
    expect(await batch(p, first.body)).toMatchObject({
      result: 'not_recorded',
      reason: 'recording_paused',
      currentGeneration: 2,
    });
    expect(await batch(p, { ...first.body, recordingGeneration: 2 })).toMatchObject({
      result: 'not_recorded',
      reason: 'recording_paused',
      currentGeneration: 2,
    });
    const save = await post(
      '/v1/actions',
      { commandId: randomUUID(), kind: 'save', target: { assetId, assetRevision: 1 }, recordingGeneration: 2 },
      headers(p),
    );
    expect(save.status).toBe(200);
    expect(
      await handle.db
        .selectFrom('experience.saved_items')
        .select('asset_id')
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toEqual([{ asset_id: assetId }]);
    expect(await observations(p)).toEqual(stored);
    const resume = command(p, 2, true);
    expect(await set(p, resume)).toMatchObject({ receipt: { changed: true, toGeneration: 3, on: true } });
    expect(await set(p, pause)).toEqual({ ...paused, replayed: true });
    expect(await read(p, pause.commandId)).toMatchObject({
      status: 'recorded',
      policy: { on: true, generation: 3 },
      receipt: paused.receipt,
    });
    expect((await read(p)).policy).toEqual({ on: true, generation: 3 });
    await refusal(await post(policyPath + '/set', command(p, 1, false), headers(p)), 'RECORDING_POLICY_STALE');
    expect(await batch(p, first.body)).toMatchObject({
      result: 'not_recorded',
      reason: 'recording_generation_stale',
      currentGeneration: 3,
    });
    const { instrumentationVersion, events } = first.body;
    const legacy = await post('/v1/observations/batch', { instrumentationVersion, events }, headers(p));
    expect(legacy.status).toBe(409);
    expect(((await legacy.json()) as { code: string }).code).toBe('RECORDING_GENERATION_REQUIRED');
    const fresh = await activated(p, 3);
    expect(await batch(p, fresh.body)).toMatchObject({ result: 'processed', accepted: 1, duplicates: 0, rejected: 0 });
    expect(await observations(p)).toHaveLength(2);
    expect(
      await batch(p, {
        ...fresh.body,
        events: [{ ...fresh.body.events[0]!, eventId: randomUUID(), sessionId: randomUUID() }],
      }),
    ).toMatchObject({
      result: 'processed',
      accepted: 0,
      rejected: 1,
      results: [{ status: 'rejected', reason: 'lineage_mismatch' }],
    });
    expect(await observations(p)).toHaveLength(2);
  });
  it('normal worker seals current Clear readiness without resetting generation or replaying an old toggle', async () => {
    const p = await born(),
      pause = command(p, 1, false);
    const old = await set(p, pause);
    await set(p, command(p, 2, true));
    const commandId = randomUUID();
    const clear = await post(
      '/v1/privacy/clear-exploration',
      {
        version: 'clear-exploration.v1',
        commandId,
        expectedPrivacyEpoch: 1,
        confirmation: 'clear-exploration-preserve-keep-and-social',
      },
      headers(p),
    );
    expect(clear.status).toBe(202);
    expect(ClearExplorationAcceptanceSchema.parse(await clear.json())).toMatchObject({
      commandId,
      fromEpoch: 1,
      toEpoch: 2,
    });
    const after = { ...p, privacyEpoch: 2 };
    await expect
      .poll(
        async () => {
          const response = await post(
            '/v1/privacy/clear-exploration/status',
            { version: 'clear-exploration.v1', target: { kind: 'command', commandId } },
            headers(after),
          );
          expect(response.status).toBe(200);
          return ClearExplorationStatusSchema.parse(await response.json()).status;
        },
        { timeout: 20000 },
      )
      .toBe('completed_live');
    const operation = await handle.db
      .selectFrom('identity.clear_operations')
      .select(['id', 'from_epoch', 'to_epoch'])
      .where('account_id', '=', p.accountId)
      .where('scope_id', '=', p.universeId)
      .where('command_id', '=', commandId)
      .executeTakeFirstOrThrow();
    expect(operation).toMatchObject({ from_epoch: 1, to_epoch: 2 });
    expect(operation.id).not.toBe(commandId);
    expect(
      await handle.db
        .selectFrom('identity.recording_lifecycle_witnesses')
        .select(['origin_kind', 'privacy_epoch', 'clear_operation_id'])
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toEqual([{ origin_kind: 'clear_core', privacy_epoch: 2, clear_operation_id: operation.id }]);
    expect((await read(after)).policy).toEqual({ on: true, generation: 3 });
    expect(await set(after, pause)).toEqual({ ...old, replayed: true });
    expect((await read(after, pause.commandId)).policy).toEqual({ on: true, generation: 3 });
    const fresh = await activated(after, 3);
    expect(await batch(after, fresh.body)).toMatchObject({ result: 'processed', accepted: 1 });
  });
});
