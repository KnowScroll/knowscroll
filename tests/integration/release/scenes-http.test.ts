import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEVELOPMENT_SESSION_COOKIE_NAME,
  SceneDescriptorSchema,
  SceneChunkSchema,
  SceneManifestSchema,
  SceneManifestReadSchema,
  SceneChunkReadSchema,
  type SceneClientCapabilities,
  type SceneChunkReference,
} from '@knowscroll/contracts';
import {
  createDatabase,
  makeWithPersonalScope,
  transactionOf,
  advanceScopeRevision,
  type Database,
  type DatabaseHandle,
} from '@knowscroll/backend/infrastructure/postgres';
import { projectSceneQueue } from '@knowscroll/backend/modules/scenes';
import { deadLetterQueueName } from '@knowscroll/backend/infrastructure/jobs';
import { apiClient } from '../support/api-client.js';
import { createEmptyDatabase } from '../support/empty-database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { freePort, startReleaseProcess, waitForHttp, type ReleaseProcess } from '../support/processes.js';

const capabilities: SceneClientCapabilities = {
  version: 'scene-client.v1',
  descriptors: ['scene-descriptor.v1'],
  chunks: ['scene-chunk.v1'],
  manifests: ['scene-manifest.v1'],
  generators: ['silhouette.v1'],
  families: ['terraced.v1', 'ridged.v1', 'archipelago.v1'],
  detail: 'full',
  reducedMotion: false,
};
const query = { selection: { kind: 'universe' as const }, capabilities };
const manifestPath = '/v1/universe/scenes/manifest/read',
  chunkPath = '/v1/universe/scenes/chunks/read';
interface Person extends FixturePerson {
  readonly native: string;
  readonly web: string;
  readonly nativeSessionId: string;
}
/** Installed Nest and disposable PostgreSQL only. Scene/Geography and session rows below are
 * labelled authored transport fixtures, never personal formation, runtime bootstrap or provider evidence. */
describe('own Scene HTTP boundary in the installed release', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>,
    handle: DatabaseHandle<Database>,
    api: ReleaseProcess,
    origin: string;
  let startupPerson: Person, startupBefore: Record<string, string>;
  const secrets = new Set<string>(),
    privateCanary = 'CI Scene private support must never reach diagnostics',
    labelCanary = 'CI Scene transport label';
  const scope = () => makeWithPersonalScope(handle.db, { lockTimeoutMs: 5000 });
  const nativeHeaders = (p: Person, epoch = 1) => ({
    authorization: `Bearer ${p.native}`,
    'x-ks-scope': `${p.accountId}:${epoch}`,
  });
  const webHeaders = (p: Person, epoch = 1) => ({
    cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=${p.web}`,
    origin,
    'x-ks-scope': `${p.accountId}:${epoch}`,
  });
  const post = (path: string, body: unknown, headers: Record<string, string>) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  async function person(): Promise<Person> {
    const p = await seedPerson(handle.db);
    await handle.db
      .insertInto('identity.email_addresses')
      .values({ account_id: p.accountId, address: `scene-${randomUUID()}@http-fixture.test` })
      .execute();
    const tokens = {
      native: `kss_${randomBytes(32).toString('base64url')}`,
      web: `kss_${randomBytes(32).toString('base64url')}`,
    };
    const nativeSessionId = randomUUID();
    for (const client of ['native', 'web'] as const) {
      secrets.add(tokens[client]);
      await handle.db
        .insertInto('identity.sessions')
        .values({
          id: client === 'native' ? nativeSessionId : randomUUID(),
          account_id: p.accountId,
          client,
          token_hash: createHash('sha256').update(tokens[client]).digest('hex'),
          expires_at: new Date(Date.now() + 86400000),
        })
        .execute();
    }
    return { ...p, ...tokens, nativeSessionId };
  }
  async function problem(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    const body: unknown = await response.json();
    expect(body).toMatchObject({ status, code });
    return body;
  }
  async function read(p: Person, input = query, headers: Record<string, string> = nativeHeaders(p)) {
    const response = await post(manifestPath, input, headers);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    return SceneManifestReadSchema.parse(await response.json());
  }
  async function piece(
    p: Person,
    reference: SceneChunkReference,
    selection: (typeof query)['selection'] | { kind: 'system'; systemId: string } = query.selection,
    caps = capabilities,
  ) {
    const response = await post(chunkPath, { selection, capabilities: caps, reference }, nativeHeaders(p));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    return SceneChunkReadSchema.parse(await response.json());
  }
  async function digest(p: Person) {
    const result: Record<string, string> = {};
    for (const table of [
      'scenes.state',
      'scenes.objects',
      'scenes.looks',
      'scenes.chunks',
      'scenes.manifests',
      'geography.state',
      'geography.objects',
      'geography.relations',
      'geography.deltas',
      'geography.runs',
      'receipts.personal_commands',
      'evidence.observations',
      'experience.exposures',
      'reasoning.external_attempts',
      'reasoning.business_runs',
    ]) {
      const rows = await sql<{
        value: string;
      }>`select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),'[]'::jsonb)::text as value from ${sql.table(table)} r where universe_id=${p.universeId}::uuid`.execute(
        handle.db,
      );
      result[table] = createHash('sha256').update(rows.rows[0]!.value).digest('hex');
    }
    const jobs = await sql<{
      value: string;
    }>`select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]'::jsonb)::text as value from pgboss.job r where data->>'universeId'=${p.universeId}`.execute(
      handle.db,
    );
    result['jobs'] = createHash('sha256').update(jobs.rows[0]!.value).digest('hex');
    const root = await handle.db
      .selectFrom('identity.universes')
      .select(['revision', 'privacy_epoch', 'status'])
      .where('id', '=', p.universeId)
      .executeTakeFirstOrThrow();
    result['root'] = JSON.stringify(root);
    return result;
  }
  async function populated() {
    const p = await person(),
      system = randomUUID(),
      otherSystem = randomUUID(),
      star = randomUUID(),
      seasons = randomUUID(),
      tides = randomUUID(),
      transition = randomUUID(),
      routeId = randomUUID();
    const objectChunk = randomUUID(),
      otherChunk = randomUUID(),
      routeChunk = randomUUID();
    const places = [
      {
        id: system,
        kind: 'system' as const,
        conceptId: 'earth',
        parentKey: 'universe',
        truthStatus: 'factual' as const,
      },
      {
        id: star,
        kind: 'star' as const,
        conceptId: 'earth',
        parentKey: 'system:earth:factual',
        truthStatus: 'factual' as const,
      },
      {
        id: seasons,
        kind: 'planet' as const,
        conceptId: 'earth.seasons',
        parentKey: 'system:earth:factual',
        truthStatus: 'factual' as const,
      },
      {
        id: tides,
        kind: 'planet' as const,
        conceptId: 'earth.tides',
        parentKey: 'system:earth:factual',
        truthStatus: 'factual' as const,
      },
      {
        id: otherSystem,
        kind: 'system' as const,
        conceptId: 'earth',
        parentKey: 'universe',
        truthStatus: 'hypothetical' as const,
      },
    ].map((o) => ({
      ...o,
      key: `${o.kind}:${o.conceptId}:${o.truthStatus}`,
      labels: [labelCanary],
      label: labelCanary,
      objectRevision: 1,
      originTransitionId: transition,
      activity: { availability: 'available' as const, state: 'active' as const },
    }));
    const descriptors = places.map((o, i) =>
      SceneDescriptorSchema.parse({
        schemaVersion: 'scene-descriptor.v1',
        generatorVersion: 'silhouette.v1',
        objectId: o.id,
        parentId: o.kind === 'system' ? p.universeId : system,
        kind: o.kind,
        originTransitionId: transition,
        label: o.label,
        truthStatus: o.truthStatus,
        activity: o.activity,
        family: o.id === tides ? 'archipelago.v1' : 'terraced.v1',
        seed: createHash('sha256').update(o.id).digest('hex').slice(0, 32),
        palette: 'ochre',
        material: 'solid',
        atmosphere: { density: 0.1 },
        detail: { roughness: 0.2 },
        anchor: { x: i * 300, y: 0, layer: i },
        target: { kind: o.kind, objectId: o.id },
      }),
    );
    const revisions = {
      geographyRevision: 1,
      structureRevision: 1,
      activityRevision: 0,
      sceneRevision: 1,
      personalRevision: 1,
    };
    const chunks = [
      {
        systemId: system,
        chunk: SceneChunkSchema.parse({
          schemaVersion: 'scene-chunk.v1',
          chunkId: objectChunk,
          revisions,
          objects: descriptors.filter((o) => o.objectId !== otherSystem),
          routes: [],
        }),
      },
      {
        systemId: otherSystem,
        chunk: SceneChunkSchema.parse({
          schemaVersion: 'scene-chunk.v1',
          chunkId: otherChunk,
          revisions,
          objects: descriptors.filter((o) => o.objectId === otherSystem),
          routes: [],
        }),
      },
      {
        systemId: system,
        chunk: SceneChunkSchema.parse({
          schemaVersion: 'scene-chunk.v1',
          chunkId: routeChunk,
          revisions,
          objects: [],
          routes: [
            {
              id: routeId,
              fromObjectId: seasons,
              toObjectId: tides,
              originTransitionId: transition,
              truthStatus: 'factual',
            },
          ],
        }),
      },
    ];
    const manifest = SceneManifestSchema.parse({
      schemaVersion: 'scene-manifest.v1',
      revisions,
      chunks: chunks.map((c) => ({
        chunkId: c.chunk.chunkId,
        sceneRevision: 1,
        objectIds: c.chunk.objects.map((o) => o.objectId),
      })),
    });
    await scope()(p.authority, async (s) => {
      const tx = transactionOf(s);
      expect(await advanceScopeRevision(s)).toBe(1);
      await tx
        .insertInto('geography.state')
        .values({ universe_id: p.universeId, privacy_epoch: 1, revision: 1, structure_revision: 1 })
        .execute();
      for (const o of places)
        await tx
          .insertInto('geography.objects')
          .values({
            universe_id: p.universeId,
            privacy_epoch: 1,
            id: o.id,
            semantic_key: o.key,
            payload: o,
            support_refs: JSON.stringify([privateCanary]),
          })
          .execute();
      const relation = {
        id: routeId,
        fromKey: 'planet:earth.seasons:factual',
        toKey: 'planet:earth.tides:factual',
        truthStatus: 'factual',
        relationRevision: 1,
        originTransitionId: transition,
        status: 'current',
      };
      await tx
        .insertInto('geography.relations')
        .values({
          universe_id: p.universeId,
          privacy_epoch: 1,
          id: routeId,
          semantic_key: 'CI transport route',
          kind: 'route',
          payload: relation,
          support_refs: JSON.stringify([privateCanary]),
        })
        .execute();
      for (const c of chunks)
        await tx
          .insertInto('scenes.chunks')
          .values({
            universe_id: p.universeId,
            privacy_epoch: 1,
            chunk_id: c.chunk.chunkId,
            scene_revision: 1,
            system_id: c.systemId,
            payload: JSON.stringify(c.chunk),
          })
          .execute();
      for (const [slot, d] of descriptors.entries()) {
        const stored = {
          descriptor: d,
          systemId: d.objectId === otherSystem ? otherSystem : system,
          chunkId: d.objectId === otherSystem ? otherChunk : objectChunk,
          slot,
        };
        await tx
          .insertInto('scenes.objects')
          .values({
            universe_id: p.universeId,
            privacy_epoch: 1,
            object_id: d.objectId,
            system_id: stored.systemId,
            chunk_id: stored.chunkId,
            slot,
            payload: JSON.stringify(stored),
          })
          .execute();
      }
      await tx
        .insertInto('scenes.manifests')
        .values({ universe_id: p.universeId, privacy_epoch: 1, scene_revision: 1, payload: JSON.stringify(manifest) })
        .execute();
      await tx
        .insertInto('scenes.state')
        .values({
          universe_id: p.universeId,
          privacy_epoch: 1,
          policy_version: 'canonical-lattice.v1',
          world_seed: 'a'.repeat(64),
          scene_revision: 1,
          payload: JSON.stringify({
            policyVersion: 'canonical-lattice.v1',
            routeChunks: [{ routeId, systemId: system, chunkId: routeChunk }],
            manifest,
          }),
        })
        .execute();
    });
    const reference = (chunkId = objectChunk, manifestSceneRevision = 1): SceneChunkReference => ({
      universeId: p.universeId,
      privacyEpoch: 1,
      manifestSceneRevision,
      chunkId,
      chunkSceneRevision: 1,
    });
    return { ...p, system, otherSystem, objectChunk, otherChunk, routeChunk, descriptors, manifest, reference };
  }
  async function newerGeography(p: Person) {
    await scope()(p.authority, async (s) => {
      await transactionOf(s)
        .updateTable('geography.state')
        .set({ revision: 2, structure_revision: 2 })
        .where('universe_id', '=', p.universeId)
        .execute();
      expect(await advanceScopeRevision(s)).toBe(2);
    });
  }
  async function pending(p: Person, state: 'created' | 'retry' | 'active' | 'failed' = 'created', dead = false) {
    await sql`insert into pgboss.job(name,state,data) values(${dead ? deadLetterQueueName(projectSceneQueue.name) : projectSceneQueue.name},${state}::pgboss.job_state,${JSON.stringify({ v: 1, universeId: p.universeId, privacyEpoch: 1, transitionId: randomUUID(), geography: { revision: 2, structureRevision: 2, activityRevision: 0 }, personalRevision: 2 })}::jsonb)`.execute(
      handle.db,
    );
  }
  beforeAll(async () => {
    database = await createEmptyDatabase('release_scenes');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    handle = createDatabase<Database>(
      { url: database.url, applicationName: 'scene-http-fixture', poolMax: 4, statementTimeoutMs: 15000 },
      { onIdleClientError: () => undefined },
    );
    startupPerson = await person();
    startupBefore = await digest(startupPerson);
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    api = startReleaseProcess('api', 'main', {
      NODE_ENV: 'test',
      KS_WORLD: 'ci',
      DATABASE_URL: database.url,
      PORT: String(port),
      KS_PUBLIC_ORIGIN: origin,
      KS_AUTH_ADAPTER: 'session',
      KS_MAIL_SENDER: 'fixture',
      AGENTMAIL_API_KEY: 'fixture-not-a-key',
      AGENTMAIL_INBOX_ID: 'fixture@agentmail.invalid',
      KS_BODY_LIMIT_BYTES: '4096',
      KS_SCOPE_LOCK_TIMEOUT_MS: '5000',
      KS_SHUTDOWN_GRACE_SECONDS: '10',
    });
    await api.waitForEvent('process.started');
    await waitForHttp(`${origin}/health`);
  });
  afterAll(async () => {
    try {
      if (api) {
        expect(await api.stop()).toBe(0);
        expect(api.records.filter((r) => r.event === 'http.unexpected_error')).toEqual([]);
        const output = api.rawOutput();
        for (const secret of secrets) expect(output).not.toContain(secret);
        expect(output).not.toContain(privateCanary);
        expect(output).not.toContain(labelCanary);
      }
    } finally {
      try {
        if (handle) await handle.close();
      } finally {
        if (database) await database.drop();
      }
    }
  });
  it('starts inert and serves empty genuine native/web sessions without any Scene, root, job or evidence effect', async () => {
    const p = startupPerson,
      before = startupBefore;
    expect(await digest(p)).toEqual(before);
    for (let i = 0; i < 3; i++) {
      for (const headers of [nativeHeaders(p), webHeaders(p)]) {
        const response = await read(p, query, headers);
        expect(response).toMatchObject({
          status: 'empty',
          sceneRevision: 0,
          scope: { universeId: p.universeId, privacyEpoch: 1, personalWatermark: 0 },
          manifest: { chunks: [] },
        });
        expect(response).not.toHaveProperty('pendingProjection');
      }
    }
    expect(await digest(p)).toEqual(before);
  });
  it('serves actual stored manifest→exact chunk through the typed client, preserving identity/detail/motion and private cache policy', async () => {
    const p = await populated(),
      before = await digest(p),
      client = apiClient(origin, `Bearer ${p.native}`, `${p.accountId}:1`);
    const manifest = await client.scenes.manifest(query);
    expect(manifest).toMatchObject({ status: 'ready', sceneRevision: 1, manifest: p.manifest });
    for (const caps of [capabilities, { ...capabilities, detail: 'low' as const, reducedMotion: true }]) {
      const result = await client.scenes.chunk({ ...query, capabilities: caps, reference: p.reference() });
      expect(result.status).toBe('ready');
      if (result.status !== 'ready') throw new Error('CI ready chunk missing');
      expect(result.chunk.objects).toEqual(p.descriptors.filter((o) => o.objectId !== p.otherSystem));
      expect(result).not.toHaveProperty('worldSeed');
      expect(JSON.stringify(result)).not.toContain(privateCanary);
    }
    expect(await piece(p, p.reference(p.routeChunk), { kind: 'system', systemId: p.system })).toMatchObject({
      status: 'ready',
      chunk: { objects: [], routes: [{ fromObjectId: p.descriptors[2]!.objectId }] },
    });
    expect(await piece(p, p.reference(p.otherChunk), { kind: 'system', systemId: p.system })).toMatchObject({
      status: 'unavailable',
      reason: 'unknown_chunk',
    });
    expect(await digest(p)).toEqual(before);
  });
  it('preserves closed own references, coarsens foreign selections/references and never echoes foreign scope', async () => {
    const p = await populated(),
      foreign = await populated(),
      before = await digest(p);
    for (const systemId of [foreign.system, randomUUID()]) {
      const body = await problem(
        await post(manifestPath, { ...query, selection: { kind: 'system', systemId } }, nativeHeaders(p)),
        404,
        'NOT_FOUND',
      );
      expect(JSON.stringify(body)).not.toContain(systemId);
    }
    for (const reference of [foreign.reference(), { ...p.reference(), privacyEpoch: 2 }]) {
      const body = await problem(await post(chunkPath, { ...query, reference }, nativeHeaders(p)), 404, 'NOT_FOUND');
      expect(JSON.stringify(body)).not.toContain(reference.chunkId);
      expect(JSON.stringify(body)).not.toContain(foreign.universeId);
    }
    expect(await piece(p, { ...p.reference(), chunkId: randomUUID() })).toMatchObject({
      status: 'unavailable',
      reason: 'unknown_chunk',
    });
    expect(await piece(p, { ...p.reference(), manifestSceneRevision: 2 })).toMatchObject({
      status: 'unavailable',
      reason: 'stale_manifest',
    });
    expect(await read(p, { ...query, capabilities: { ...capabilities, generators: [] } })).toMatchObject({
      status: 'unsupported_version',
    });
    expect(await piece(p, p.reference(), query.selection, { ...capabilities, families: [] })).toMatchObject({
      status: 'unsupported_version',
    });
    expect(await digest(p)).toEqual(before);
  });
  it('uses real pending jobs for lagging/loading, refuses failed/dead/missing progress and retains old chunks in a new current manifest', async () => {
    const p = await populated();
    await newerGeography(p);
    expect(await read(p)).toMatchObject({ status: 'unavailable', reason: 'temporarily_unavailable' });
    await pending(p, 'failed');
    await pending(p, 'created', true);
    let before = await digest(p);
    expect(await read(p)).toMatchObject({ status: 'unavailable', reason: 'temporarily_unavailable' });
    expect(await digest(p)).toEqual(before);
    for (const state of ['created', 'retry', 'active'] as const) {
      await sql`delete from pgboss.job where data->>'universeId'=${p.universeId}`.execute(handle.db);
      await pending(p, state);
      before = await digest(p);
      expect(await read(p)).toMatchObject({
        status: 'lagging',
        sceneRevision: 1,
        pendingProjection: { geographyRevision: 2, personalRevision: 2 },
      });
      expect(await piece(p, p.reference())).toMatchObject({
        status: 'ready',
        currentGeography: { revision: 2 },
        chunk: { revisions: { geographyRevision: 1 } },
      });
      expect(await digest(p)).toEqual(before);
    }
    const manifest = SceneManifestSchema.parse({
      ...p.manifest,
      revisions: {
        ...p.manifest.revisions,
        geographyRevision: 2,
        structureRevision: 2,
        sceneRevision: 2,
        personalRevision: 2,
      },
    });
    await scope()(p.authority, async (s) => {
      const tx = transactionOf(s);
      await tx
        .insertInto('scenes.manifests')
        .values({ universe_id: p.universeId, privacy_epoch: 1, scene_revision: 2, payload: JSON.stringify(manifest) })
        .execute();
      await sql`update scenes.state set scene_revision=2,payload=jsonb_set(payload,'{manifest}',${JSON.stringify(manifest)}::jsonb) where universe_id=${p.universeId}::uuid`.execute(
        tx,
      );
    });
    before = await digest(p);
    expect(await read(p)).toMatchObject({ status: 'ready', sceneRevision: 2 });
    expect(await piece(p, p.reference())).toMatchObject({ status: 'unavailable', reason: 'stale_manifest' });
    expect(await piece(p, p.reference(p.objectChunk, 2))).toMatchObject({
      status: 'ready',
      chunk: { revisions: { sceneRevision: 1 } },
    });
    expect(await digest(p)).toEqual(before);
    await sql`update scenes.state set payload=jsonb_set(payload,'{failure}','{"geographyRevision":2,"reason":"limit"}'::jsonb) where universe_id=${p.universeId}::uuid`.execute(
      handle.db,
    );
    before = await digest(p);
    expect(await read(p)).toMatchObject({ status: 'unavailable', reason: 'limit' });
    expect(await piece(p, p.reference(p.objectChunk, 2))).toMatchObject({ status: 'unavailable', reason: 'limit' });
    expect(await digest(p)).toEqual(before);
    const loading = await populated();
    await newerGeography(loading);
    await sql`delete from scenes.state where universe_id=${loading.universeId}::uuid`.execute(handle.db);
    await pending(loading);
    before = await digest(loading);
    expect(await read(loading)).toMatchObject({ status: 'loading', pendingProjection: { geographyRevision: 2 } });
    expect(await digest(loading)).toEqual(before);
  });
  it('preserves Origin, genuine session kind/revocation/expiry, scope, JSON, size and exact-method guards on both routes', async () => {
    const p = await populated(),
      other = await person();
    for (const [path, input] of [
      [manifestPath, query],
      [chunkPath, { ...query, reference: p.reference() }],
    ] as const) {
      await problem(await post(path, input, {}), 401, 'UNAUTHENTICATED');
      await problem(
        await post(path, input, { ...nativeHeaders(p), authorization: `Bearer ${p.web}` }),
        401,
        'UNAUTHENTICATED',
      );
      await problem(
        await post(path, input, { ...webHeaders(p), cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=${p.native}` }),
        401,
        'UNAUTHENTICATED',
      );
      const { origin: ignored, ...withoutOrigin } = webHeaders(p);
      void ignored;
      await problem(await post(path, input, withoutOrigin), 403, 'ORIGIN_NOT_ALLOWED');
      await problem(
        await post(path, input, { ...webHeaders(p), origin: 'https://foreign.invalid' }),
        403,
        'ORIGIN_NOT_ALLOWED',
      );
      await problem(
        await post(path, input, { ...nativeHeaders(p), origin: 'https://foreign.invalid' }),
        403,
        'ORIGIN_NOT_ALLOWED',
      );
      for (const scope of ['', `${other.accountId}:1`, `${p.accountId}:2`, `${p.accountId}:1,${p.accountId}:1`])
        await problem(
          await post(path, input, { authorization: `Bearer ${p.native}`, ...(scope ? { 'x-ks-scope': scope } : {}) }),
          409,
          'SCOPE_MISMATCH',
        );
      for (const extra of [
        { accountId: p.accountId },
        { commandId: randomUUID() },
        { cursor: { universeId: other.universeId } },
      ])
        await problem(await post(path, { ...input, ...extra }, nativeHeaders(p)), 400, 'INVALID_REQUEST');
      await problem(
        await post(path, { ...input, padding: 'x'.repeat(5000) }, nativeHeaders(p)),
        413,
        'PAYLOAD_TOO_LARGE',
      );
      await problem(
        await fetch(`${origin}${path}`, {
          method: 'POST',
          headers: { ...nativeHeaders(p), 'content-type': 'text/plain' },
          body: 'private',
        }),
        415,
        'UNSUPPORTED_MEDIA_TYPE',
      );
      await problem(
        await fetch(`${origin}${path}`, {
          method: 'POST',
          headers: { ...nativeHeaders(p), 'content-type': 'application/json' },
          body: '{invalid',
        }),
        400,
        'INVALID_REQUEST',
      );
      await problem(await fetch(`${origin}${path}`, { headers: nativeHeaders(p) }), 404, 'NOT_FOUND');
    }
    const before = await digest(p);
    await handle.db
      .updateTable('identity.sessions')
      .set({ revoked_at: new Date(), revoked_reason: 'signed_out' })
      .where('id', '=', p.nativeSessionId)
      .execute();
    for (const path of [manifestPath, chunkPath])
      await problem(
        await post(path, path === manifestPath ? query : { ...query, reference: p.reference() }, nativeHeaders(p)),
        401,
        'UNAUTHENTICATED',
      );
    expect(await digest(p)).toEqual(before);
    const expired = await populated();
    await handle.db
      .updateTable('identity.sessions')
      .set({ created_at: new Date(Date.now() - 7200000), expires_at: new Date(Date.now() - 3600000) })
      .where('id', '=', expired.nativeSessionId)
      .execute();
    for (const path of [manifestPath, chunkPath])
      await problem(
        await post(
          path,
          path === manifestPath ? query : { ...query, reference: expired.reference() },
          nativeHeaders(expired),
        ),
        401,
        'UNAUTHENTICATED',
      );
    const suspended = await populated();
    await handle.db
      .updateTable('identity.accounts')
      .set({ status: 'suspended' })
      .where('id', '=', suspended.accountId)
      .execute();
    for (const path of [manifestPath, chunkPath])
      await problem(
        await post(
          path,
          path === manifestPath ? query : { ...query, reference: suspended.reference() },
          nativeHeaders(suspended),
        ),
        401,
        'UNAUTHENTICATED',
      );
  });
  it('rechecks epoch after an admitted installed HTTP read waits for its personal root', async () => {
    for (const path of [manifestPath, chunkPath]) {
      const p = await populated();
      let locked!: () => void, release!: () => void;
      const entered = new Promise<void>((r) => {
          locked = r;
        }),
        held = new Promise<void>((r) => {
          release = r;
        });
      const holder = handle.db.transaction().execute(async (tx) => {
        await tx
          .selectFrom('identity.universes')
          .select('id')
          .where('id', '=', p.universeId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        locked();
        await held;
        await tx.updateTable('identity.universes').set({ privacy_epoch: 2 }).where('id', '=', p.universeId).execute();
      });
      await entered;
      const waiting = post(
        path,
        path === manifestPath ? query : { ...query, reference: p.reference() },
        nativeHeaders(p),
      );
      try {
        await expect
          .poll(
            async () => {
              const result = await sql<{
                n: number;
              }>`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and application_name<>'scene-http-fixture'`.execute(
                handle.db,
              );
              return result.rows[0]!.n;
            },
            { timeout: 3000 },
          )
          .toBeGreaterThan(0);
      } finally {
        release();
        await holder;
      }
      const body = await problem(await waiting, 403, 'UNIVERSE_UNAVAILABLE');
      expect(JSON.stringify(body)).not.toContain(p.objectChunk);
      await problem(await post(manifestPath, query, nativeHeaders(p)), 409, 'SCOPE_MISMATCH');
      const response = await read(p, query, nativeHeaders(p, 2));
      expect(response).toMatchObject({ status: 'empty', scope: { privacyEpoch: 2 } });
      expect(response).not.toHaveProperty('chunk');
    }
  });
});
