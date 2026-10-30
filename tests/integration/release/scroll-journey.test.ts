import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ScopeChangedHintSchema,
  SOCKET_PATH,
  socketEvents,
  type InteractionEvent,
  type ScopeChangedHint,
} from '@knowscroll/contracts';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { apiClient } from '../support/api-client.js';
import { createEmptyDatabase } from '../support/empty-database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { recordingPerson } from '../support/recording-person.js';
import {
  freePort,
  releaseDirectory,
  startReleaseProcess,
  waitForHttp,
  type ReleaseProcess,
} from '../support/processes.js';

/**
 * The S1.6 thin journey through the deployed release trees: the operator command admits the authored
 * starter Scroll, then HTTP open → document → activate → observation batch (stored) → the worker's
 * projection job commits an evidence revision → a disposable Socket.IO hint → the dev diagnostics read
 * catches up. A retried batch counts nothing twice.
 *
 * Evidence label: CI fixture + real database. People and universes are fixtures; callers are
 * authenticated by the test-only adapter, which the production configuration refuses.
 */
const fixtureAgentMail = { AGENTMAIL_API_KEY: 'fixture-not-a-key', AGENTMAIL_INBOX_ID: 'fixture@agentmail.invalid' };
/** A phrase from the starter's prose and a block ID: neither may ever reach a log (D-017). */
const proseCanary = 'Glance towards the Sun';
const blockCanary = 'intro-look-up';

describe('the thin journey through the built API, worker and operator command', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let handle: DatabaseHandle<Database>;
  let api: ReleaseProcess;
  let worker: ReleaseProcess;
  let baseUrl: string;
  let person: FixturePerson;
  let stranger: FixturePerson;
  let assetId: string;
  const sockets: Socket[] = [];
  const operatorOutput: string[] = [];

  /** The starter as the release tree carries it. */
  const starterFile = () =>
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
    );

  /** Runs the release's operator command with a clean environment; stdout and stderr apart. */
  async function operator(env: Record<string, string>, args: readonly string[]) {
    const child = spawn(process.execPath, [join('dist', 'operator.js'), ...args], {
      cwd: join(releaseDirectory(), 'api'),
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    operatorOutput.push(stdout, stderr);
    return { code, stdout, stderr };
  }

  beforeAll(async () => {
    database = await createEmptyDatabase('release_scroll');
    const migrate = startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' });
    expect(await migrate.exited()).toBe(0);
    handle = createDatabase<Database>(
      { url: database.url, applicationName: 'knowscroll-it-fixtures', poolMax: 2, statementTimeoutMs: 10_000 },
      { onIdleClientError: () => undefined },
    );
    // Actual Identity birth provides current lifecycle provenance; test-bearer remains a labelled CI adapter.
    person = await recordingPerson({ db: handle.db });
    stranger = await seedPerson(handle.db);

    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const shared = { NODE_ENV: 'test', KS_WORLD: 'ci', DATABASE_URL: database.url, KS_SHUTDOWN_GRACE_SECONDS: '10' };
    api = startReleaseProcess('api', 'main', {
      ...shared,
      PORT: String(port),
      ...fixtureAgentMail,
      KS_MAIL_SENDER: 'fixture',
      KS_AUTH_ADAPTER: 'test-bearer',
      KS_SOCKET_AUTH_CACHE_MS: '0',
    });
    worker = startReleaseProcess('worker', 'main', shared);
    await Promise.all([api.waitForEvent('process.started'), worker.waitForEvent('process.started')]);
    await waitForHttp(`${baseUrl}/health`);
  });

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await handle.close();
    await database.drop();
  });

  it('admits the starter with the operator command: created, then unchanged, and refused where operator tools are not allowed', async () => {
    expect(existsSync(starterFile())).toBe(true);
    const env = { KS_WORLD: 'ci', DATABASE_URL: database.url };
    const created = await operator(env, ['content', 'import-editorial', '--file', starterFile()]);
    expect(created.code).toBe(0);
    const result = JSON.parse(created.stdout.trim()) as {
      outcome: string;
      assetId: string;
      revision: number;
      documentSha256: string;
      path: string;
    };
    expect(result).toMatchObject({ outcome: 'created', revision: 1 });
    expect(result.path).toBe(`/scroll/${result.assetId}`);
    expect(result.documentSha256).toMatch(/^[0-9a-f]{64}$/);
    assetId = result.assetId;

    const again = await operator(env, ['content', 'import-editorial', '--file', starterFile()]);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout.trim())).toMatchObject({ outcome: 'unchanged', revision: 1, assetId });

    // Refused before touching the database outside the allow-listed worlds, live included.
    for (const world of ['live', 'production', 'prod']) {
      const refused = await operator({ ...env, KS_WORLD: world }, [
        'content',
        'import-editorial',
        '--file',
        starterFile(),
      ]);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toContain('refused_in_this_world');
    }
    expect((await operator(env, ['content', 'import-editorial', '--file', '/nonexistent/file.json'])).code).toBe(1);
    expect((await operator(env, ['content', 'import-editorial'])).code).toBe(2);
    expect(
      (await operator(env, ['content', 'import-editorial', '--file', starterFile(), '--email', 'a@b.c'])).code,
    ).toBe(2);

    const stored = await handle.db
      .selectFrom('content.asset_revisions')
      .select(['provenance_kind', 'document_sha256'])
      .where('asset_id', '=', assetId)
      .execute();
    expect(stored).toEqual([{ provenance_kind: 'authored_editorial', document_sha256: result.documentSha256 }]);
  });

  it('opens, reads, activates, records and qualifies a reading, with a hint and a catch-up read, and counts a retried batch once', async () => {
    const token = `test.${person.accountId}`;
    const client = apiClient(baseUrl, `Bearer ${token}`, `${person.accountId}:1`);
    const socket = io(baseUrl, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      auth: { token, scope: `${person.accountId}:1` },
      reconnection: false,
    });
    sockets.push(socket);
    const hints: ScopeChangedHint[] = [];
    socket.on(socketEvents.scopeChanged, (hint: unknown) => hints.push(ScopeChangedHintSchema.parse(hint)));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    expect(
      await socket.emitWithAck(socketEvents.subscribeScope, { scope: { kind: 'universe', id: person.universeId } }),
    ).toEqual({ ok: true, revision: 0 });

    const capabilities = {
      documentSchemas: ['scroll-document.v1'],
      blocks: Object.fromEntries(
        ['fallback', 'paragraph', 'subheading', 'list', 'quote', 'callout', 'disclosure'].map((type) => [type, [1]]),
      ),
    };
    const commandId = randomUUID();
    const opened = await client.experience.openExposure({
      commandId,
      target: { kind: 'scroll', assetId },
      origin: { kind: 'direct' },
      capabilities,
    });
    if (opened.status !== undefined) throw new Error('Direct Scroll open returned a Composer outcome');
    expect(opened).toMatchObject({ assetId, assetRevision: 1, kind: 'scroll', replayed: false });
    expect(
      await client.experience.openExposure({
        commandId,
        target: { kind: 'scroll', assetId },
        origin: { kind: 'direct' },
        capabilities,
      }),
    ).toEqual({
      ...opened,
      replayed: true,
    });

    const read = await client.experience.exposureDocument({ exposureId: opened.exposureId });
    expect(read.document.title).toBe('Why the sky is blue');
    if (read.document.schemaVersion !== 'scroll-document.v1') throw new Error('CI expected a v1 document');
    expect(read.degradedEssential).toEqual([]);
    for (const internal of ['claims', 'sources', 'production', 'authored'])
      expect(JSON.stringify(read)).not.toContain(internal);

    // Before activation nothing is accepted; the answer is a typed refusal per event.
    const blocks = read.document.measures.blocks.map((block) => block.blockId);
    const sessionId = randomUUID();
    const base = {
      schemaVersion: 'interaction.v1' as const,
      sessionId,
      exposureId: opened.exposureId,
      assetId,
      assetRevision: opened.assetRevision,
      occurredAt: new Date().toISOString(),
    };
    const early = await client.observations.submit({
      instrumentationVersion: 1,
      events: [
        {
          ...base,
          eventId: randomUUID(),
          deviceSequence: 1,
          kind: 'scroll.active_dwell',
          payload: { activeIntervalsMs: [[0, 500]] },
        },
      ],
    });
    expect(early.results[0]).toMatchObject({ status: 'rejected', reason: 'exposure_not_active' });

    const activated = await client.experience.activateExposure({
      commandId: randomUUID(),
      exposureId: opened.exposureId,
    });
    expect(activated).toMatchObject({ exposureId: opened.exposureId, replayed: false });
    // The reading's honest claims fit the wall time since activation: pretend it began half an hour ago.
    await handle.db
      .updateTable('experience.exposures')
      .set({ activated_at: new Date(Date.now() - 30 * 60_000), opened_at: new Date(Date.now() - 31 * 60_000) })
      .where('id', '=', opened.exposureId)
      .execute();

    const events: InteractionEvent[] = [
      {
        ...base,
        eventId: randomUUID(),
        deviceSequence: 1,
        kind: 'scroll.block_coverage',
        payload: {
          blocks: blocks.map((blockId, index) => ({
            blockId,
            intervalsMs: [[index * 4_000, (index + 1) * 4_000]],
            peakFraction: 1,
          })),
        },
      },
      {
        ...base,
        eventId: randomUUID(),
        deviceSequence: 2,
        kind: 'scroll.active_dwell',
        payload: { activeIntervalsMs: [[0, blocks.length * 4_000]] },
      },
      {
        ...base,
        eventId: randomUUID(),
        deviceSequence: 3,
        kind: 'scroll.block_interaction',
        payload: { blockId: 'violet-eye', kind: 'expanded', atMs: 9_000 },
      },
    ];
    const stored = await client.observations.submit({ instrumentationVersion: 1, events });
    expect(stored).toMatchObject({ accepted: 3, duplicates: 0, rejected: 0 });

    // Qualification and separate latest-state activity project independently; both must catch up.
    await expect
      .poll(async () => (await client.diagnostics.evidence({ exposureId: opened.exposureId })).evidence?.revision, {
        timeout: 30_000,
        interval: 250,
      })
      .toBe(1);
    const readCurrentActivity = () =>
      handle.db
        .selectFrom('evidence.activity_current as current')
        .innerJoin('evidence.activity_revisions as activity', (join) =>
          join
            .onRef('activity.universe_id', '=', 'current.universe_id')
            .onRef('activity.id', '=', 'current.activity_id')
            .onRef('activity.exposure_id', '=', 'current.exposure_id')
            .onRef('activity.privacy_epoch', '=', 'current.privacy_epoch'),
        )
        .select([
          'activity.id',
          'activity.revision',
          'activity.input_vector',
          'activity.input_sha256',
          'activity.channels',
        ])
        .where('current.universe_id', '=', person.universeId)
        .where('current.privacy_epoch', '=', 1)
        .where('current.exposure_id', '=', opened.exposureId)
        .executeTakeFirst();
    // Do not baseline while qualification's required activity job can still legitimately advance
    // the scope revision/hint. Await its actual current vector, not a timing guess or job skip.
    await expect
      .poll(async () => (await readCurrentActivity())?.input_vector, { timeout: 30_000, interval: 250 })
      .toMatchObject({
        qualificationRevision: 1,
        actionRevision: 0,
        navigationRevision: 0,
        recordingGeneration: 1,
        policy: 'recording-credit.v1',
      });
    const activityBefore = await readCurrentActivity();
    expect(activityBefore?.input_vector).toMatchObject({
      qualificationRevision: 1,
      actionRevision: 0,
      navigationRevision: 0,
      recordingGeneration: 1,
      policy: 'recording-credit.v1',
    });
    const diagnostics = await client.diagnostics.evidence({ exposureId: opened.exposureId });
    await expect
      .poll(() => Math.max(...hints.map((hint) => hint.revision)), { timeout: 20_000, interval: 100 })
      .toBe(diagnostics.revision);
    expect(diagnostics).toMatchObject({
      exposureId: opened.exposureId,
      observations: { count: 3 },
      evidence: {
        revision: 1,
        inputWatermark: 3,
        qualification: 'qualified',
        coverage: 1,
        policyVersion: 'scroll-qualification.v0',
      },
    });
    // The hint is above the revision before the evidence commit, and the catch-up read is at it.
    expect(hints.every((hint) => hint.scope.id === person.universeId)).toBe(true);
    expect(Math.max(...hints.map((hint) => hint.revision))).toBe(diagnostics.revision);

    // Fully caught up: retrying the same batch creates no qualification/activity/scope revision or hint.
    const hintsBefore = hints.length;
    const retry = await client.observations.submit({ instrumentationVersion: 1, events });
    expect(retry).toMatchObject({ accepted: 0, duplicates: 3, rejected: 0 });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(hints).toHaveLength(hintsBefore);
    const after = await client.diagnostics.evidence({ exposureId: opened.exposureId });
    expect(after.observations.count).toBe(3);
    expect(after.evidence?.revision).toBe(1);
    expect(after.revision).toBe(diagnostics.revision);
    expect(await readCurrentActivity()).toEqual(activityBefore);
    const rows = await handle.db
      .selectFrom('evidence.observations')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('universe_id', '=', person.universeId)
      .executeTakeFirstOrThrow();
    expect(Number(rows.n)).toBe(3);
  });

  it("answers another person's exposure as an ordinary refusal, and an unknown block per event", async () => {
    const owner = apiClient(baseUrl, `Bearer test.${person.accountId}`, `${person.accountId}:1`);
    const capabilities = {
      documentSchemas: ['scroll-document.v1'],
      blocks: Object.fromEntries(['fallback', 'paragraph', 'subheading'].map((type) => [type, [1]])),
    };
    const opened = await owner.experience.openExposure({
      commandId: randomUUID(),
      target: { kind: 'scroll', assetId },
      origin: { kind: 'direct' },
      capabilities,
    });
    if (opened.status !== undefined) throw new Error('Direct Scroll open returned a Composer outcome');
    /** The status and stable code of a problem answer, over plain `fetch` (the API answers RFC 9457). */
    const refusal = async (method: 'GET' | 'POST', path: string, account: FixturePerson, body?: unknown) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer test.${account.accountId}`,
          'x-ks-scope': `${account.accountId}:1`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      return { status: response.status, code: ((await response.json()) as { code?: string }).code };
    };
    expect(
      await refusal('POST', '/v1/experience/activate', stranger, {
        commandId: randomUUID(),
        exposureId: opened.exposureId,
      }),
    ).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(await refusal('GET', `/v1/experience/exposures/${opened.exposureId}/document`, stranger)).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(
      await refusal('POST', '/v1/experience/open', person, {
        commandId: randomUUID(),
        target: { kind: 'scroll', assetId: randomUUID() },
        origin: { kind: 'direct' },
        capabilities,
      }),
    ).toEqual({ status: 404, code: 'ASSET_NOT_FOUND' });
    await owner.experience.activateExposure({ commandId: randomUUID(), exposureId: opened.exposureId });
    const unknown = await owner.observations.submit({
      instrumentationVersion: 1,
      events: [
        {
          schemaVersion: 'interaction.v1',
          eventId: randomUUID(),
          sessionId: randomUUID(),
          deviceSequence: 1,
          exposureId: opened.exposureId,
          assetId,
          assetRevision: 1,
          occurredAt: new Date().toISOString(),
          kind: 'scroll.block_interaction',
          payload: { blockId: 'no-such-block', kind: 'param-changed', atMs: 10 },
        },
      ],
    });
    expect(unknown.results[0]).toMatchObject({ status: 'rejected', reason: 'block_unknown' });
    // A malformed batch is refused as a whole, with a problem.
    const malformed = await fetch(`${baseUrl}/v1/observations/batch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer test.${person.accountId}`,
        'x-ks-scope': `${person.accountId}:1`,
      },
      body: JSON.stringify({ instrumentationVersion: 1, events: [{ kind: 'scroll.pointer_frame' }] }),
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get('content-type')).toBe('application/problem+json');
  });

  it("never writes the Scroll's prose, a block ID, an exposure or an event ID to any log (D-017)", async () => {
    const output = [api.rawOutput(), worker.rawOutput(), ...operatorOutput].join('\n');
    expect(output).not.toContain(proseCanary);
    expect(output).not.toContain(blockCanary);
    const exposures = await handle.db.selectFrom('experience.exposures').select('id').execute();
    expect(exposures.length).toBeGreaterThan(0);
    for (const exposure of exposures) expect(output).not.toContain(exposure.id);
    const eventIds = await handle.db.selectFrom('evidence.observations').select('event_id').execute();
    for (const row of eventIds) expect(output).not.toContain(row.event_id);
    // The projection was logged by outcome and code, with its personal-linkable ID withheld.
    const projected = worker.records.filter((record) => record.event === 'evidence.reading_projected');
    expect(projected.length).toBeGreaterThan(0);
    for (const record of projected) {
      expect(record['exposureId']).toBeUndefined();
      expect(['applied', 'skipped']).toContain(record['outcome']);
    }
    const ingested = api.records.filter((record) => record.event === 'evidence.observations_ingested');
    expect(ingested.length).toBeGreaterThan(0);
  });

  it('stops cleanly on SIGTERM', async () => {
    expect(await api.stop()).toBe(0);
    expect(await worker.stop()).toBe(0);
  });
});
