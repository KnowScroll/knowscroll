/** Actual installed API/PG, authored CI canonical maps/geography. No live formation/approval/provider. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import {
  RegionEncounterPreviewResponseSchema,
  RegionEncounterOpenResponseSchema,
  RegionEncounterProblemSchema,
  ActivateOfferResponseSchema,
  DEVELOPMENT_SESSION_COOKIE_NAME,
} from '@knowscroll/contracts';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { COVERAGE_POLICY, CONCEPT_CATALOGUE_VERSION, type CoverageCommand } from '@knowscroll/backend/modules/content';
import {
  importEditorialScrollUseCase,
  makeAdmitCoverage,
  makeCoverageAdmissionPorts,
  coverageCatalogue,
} from '@knowscroll/backend/modules/content/nest-providers';
import { createEmptyDatabase } from '../support/empty-database.js';
import { freePort, startReleaseProcess, waitForHttp, type ReleaseProcess } from '../support/processes.js';
import { seedPerson } from '../support/fixtures.js';
import { seedKeepSessions } from '../support/keep-fixture.js';
import { starterSource, baselineCapabilities } from '../support/scroll.js';
const canary = 'PRIVATE-REGION-HTTP-BODY-CANARY';
describe('Region current authority through installed API release (Actions only)', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>,
    db: DatabaseHandle<Database>,
    api: ReleaseProcess,
    origin: string;
  const processes: ReleaseProcess[] = [],
    secrets = new Set<string>();
  async function start() {
    const value = startReleaseProcess('api', 'main', {
      NODE_ENV: 'test',
      KS_WORLD: 'ci',
      DATABASE_URL: database.url,
      PORT: new URL(origin).port,
      KS_PUBLIC_ORIGIN: origin,
      KS_AUTH_ADAPTER: 'session',
      KS_MAIL_SENDER: 'fixture',
      AGENTMAIL_API_KEY: 'fixture-not-a-key',
      AGENTMAIL_INBOX_ID: 'fixture@agentmail.invalid',
      KS_SCOPE_LOCK_TIMEOUT_MS: '5000',
      KS_SHUTDOWN_GRACE_SECONDS: '10',
    });
    processes.push(value);
    await value.waitForEvent('process.started');
    await waitForHttp(origin + '/health');
    return value;
  }
  beforeAll(async () => {
    database = await createEmptyDatabase('region_http');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    db = createDatabase<Database>(
      { url: database.url, applicationName: 'ci-region-http', poolMax: 5, statementTimeoutMs: 15000 },
      { onIdleClientError: () => undefined },
    );
    origin = `http://127.0.0.1:${await freePort()}`;
    api = await start();
  });
  afterAll(async () => {
    try {
      for (const process of processes) {
        expect(await process.stop()).toBe(0);
        expect(process.records.filter((x) => x.event === 'http.unexpected_error')).toEqual([]);
        expect(process.rawOutput()).not.toContain(canary);
        for (const secret of secrets) expect(process.rawOutput()).not.toContain(secret);
      }
    } finally {
      await db?.close();
      await database?.drop();
    }
  });
  async function fixture() {
    const person = await seedPerson(db.db),
      tokens = await seedKeepSessions(db.db, person),
      regionId = randomUUID();
    secrets.add(tokens.native);
    secrets.add(tokens.web);
    const topic = 'earth.seasons',
      facet = 'earth.seasons.axial-tilt';
    await db.db
      .insertInto('geography.state')
      .values({ universe_id: person.universeId, privacy_epoch: 1, revision: 1, structure_revision: 1 })
      .execute();
    const objects = [
      { id: randomUUID(), key: 'system:earth:factual', kind: 'system', conceptId: 'earth', parentKey: 'universe' },
      {
        id: randomUUID(),
        key: `planet:${topic}:factual`,
        kind: 'planet',
        conceptId: topic,
        parentKey: 'system:earth:factual',
      },
      {
        id: regionId,
        key: `region:${facet}:factual`,
        kind: 'region',
        conceptId: facet,
        parentKey: `planet:${topic}:factual`,
      },
    ];
    for (const o of objects)
      await db.db
        .insertInto('geography.objects')
        .values({
          universe_id: person.universeId,
          privacy_epoch: 1,
          id: o.id,
          semantic_key: o.key,
          payload: { ...o, truthStatus: 'factual', label: 'CI fixture', labels: ['CI fixture'], objectRevision: 1 },
          support_refs: JSON.stringify([]),
        })
        .execute();
    const source = starterSource() as {
      assetId: string;
      reference: string;
      publication: { explanationUnitId: string };
      draft: { title: string };
    };
    source.assetId = randomUUID();
    source.reference = 'ci-installed-region-only';
    source.publication.explanationUnitId = 'ci-http-region-' + randomUUID();
    source.draft.title = 'Authored CI installed Region card';
    expect((await importEditorialScrollUseCase(db.db)(source)).kind).toBe('imported');
    const row = await db.db
      .selectFrom('content.asset_revisions')
      .select(['document_sha256', 'reading_facts'])
      .where('asset_id', '=', source.assetId)
      .executeTakeFirstOrThrow();
    const provenance = await db.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .where('asset_id', '=', source.assetId)
      .executeTakeFirstOrThrow();
    const command: CoverageCommand = {
      version: 'content-coverage-command.v1',
      assetId: source.assetId,
      assetRevision: 1,
      expectedHeadRevision: 0,
      semanticReviewReference: 'ci-http-region-only-not-live-approval',
      change: {
        kind: 'admit',
        mapping: {
          version: COVERAGE_POLICY,
          documentSha256: row.document_sha256,
          provenanceSha256: canonicalSha256(provenance.provenance),
          explanationUnitId: source.publication.explanationUnitId,
          framing: 'factual',
          framingSha256: canonicalSha256({ kind: 'factual' }),
          readingFactsVersion: 2,
          readingFactsSha256: canonicalSha256(row.reading_facts),
          catalogueVersion: CONCEPT_CATALOGUE_VERSION,
          catalogueSha256: coverageCatalogue.sha256,
          bindings: [
            {
              topicId: topic,
              facetId: facet,
              meaningSha256: coverageCatalogue.meaningSha256(topic, facet)!,
              requiredBlockIds: ['intro-look-up'],
            },
          ],
        },
      },
    };
    await makeAdmitCoverage(
      makeCoverageAdmissionPorts(
        db.db,
        (digest, ref) => digest === canonicalSha256(command) && ref === command.semanticReviewReference,
      ),
    )(command);
    return {
      person,
      tokens,
      target: { kind: 'region' as const, regionId, expectedObjectRevision: 1, expectedGeographyRevision: 1 },
      asset: { assetId: source.assetId, assetRevision: 1 },
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const headers = (f: Fixture, web = false, epoch = 1) => ({
    'content-type': 'application/json',
    'x-ks-scope': `${f.person.accountId}:${epoch}`,
    ...(web
      ? { cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=${f.tokens.web}`, origin }
      : { authorization: `Bearer ${f.tokens.native}` }),
  });
  const post = (path: string, body: unknown, h: Record<string, string>) =>
    fetch(origin + path, {
      method: 'POST',
      headers: h,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  const previewBody = (f: Fixture) => ({
    version: 'region-encounter-preview.v1',
    readId: randomUUID(),
    target: f.target,
    capabilities: baselineCapabilities,
  });
  async function problem(response: Response, code: string) {
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    const value = RegionEncounterProblemSchema.parse(await response.json());
    expect(value.code).toBe(code);
    expect(response.status).toBe(value.status);
    expect(JSON.stringify(value)).not.toContain(canary);
    return value;
  }
  it.each([false, true])(
    'previews pure canonical data and opens displayed A through normal activation (web=%s)',
    async (web) => {
      const f = await fixture();
      const count = async () =>
        (
          await sql<{
            offers: number;
            exposures: number;
            receipts: number;
            revision: number;
          }>`select (select count(*)::int from experience.offers where universe_id=${f.person.universeId}::uuid) offers,(select count(*)::int from experience.exposures where universe_id=${f.person.universeId}::uuid) exposures,(select count(*)::int from receipts.personal_commands where universe_id=${f.person.universeId}::uuid) receipts,revision from identity.universes where id=${f.person.universeId}::uuid`.execute(
            db.db,
          )
        ).rows[0];
      const before = await count(),
        read = await post('/v1/experience/region/preview', previewBody(f), headers(f, web));
      expect(read.status).toBe(200);
      expect(read.headers.get('cache-control')).toBe('private, no-store');
      const card = RegionEncounterPreviewResponseSchema.parse(await read.json());
      expect(card.status).toBe('available');
      expect(await count()).toEqual(before);
      if (card.status !== 'available') throw new Error('CI preview unavailable');
      const command = {
        version: 'region-encounter-open.v1',
        commandId: randomUUID(),
        target: f.target,
        capabilities: baselineCapabilities,
        expectedEncounter: { assetId: card.encounter.assetId, assetRevision: card.encounter.assetRevision },
      };
      const opened = await post('/v1/experience/region/open', command, headers(f, web));
      expect(opened.status).toBe(200);
      const value = RegionEncounterOpenResponseSchema.parse(await opened.json());
      expect(value.outcome.status).toBe('ready');
      if (value.outcome.status !== 'ready') throw new Error('CI regional Open unavailable');
      expect(value.outcome.offer.assetId).toBe(card.encounter.assetId);
      expect(await count()).toMatchObject({ offers: 1, exposures: 0, receipts: 1 });
      const activation = {
        commandId: randomUUID(),
        target: {
          kind: 'offer',
          sessionId: value.outcome.sessionId,
          offerId: value.outcome.offer.offerId,
          expectedIntentRevision: value.outcome.intentRevision,
        },
      };
      const activated = await post('/v1/experience/activate', activation, headers(f, web));
      expect(activated.status).toBe(200);
      expect(ActivateOfferResponseSchema.parse(await activated.json())).toMatchObject({
        assetId: card.encounter.assetId,
        offerId: value.outcome.offer.offerId,
      });
      // Lost HTTP acknowledgement recovery uses the original body after an actual process restart.
      expect(await api.stop()).toBe(0);
      api = await start();
      const replay = await post('/v1/experience/region/open', command, headers(f, web));
      expect(replay.status).toBe(200);
      expect(RegionEncounterOpenResponseSchema.parse(await replay.json()).outcome).toMatchObject({
        ...value.outcome,
        replayed: true,
      });
      await db.db
        .updateTable('content.assets')
        .set({ status: 'withdrawn' })
        .where('id', '=', card.encounter.assetId)
        .execute();
      await problem(await post('/v1/experience/region/open', command, headers(f, web)), 'OFFER_UNAVAILABLE');
    },
  );
  it('guards native/web current authority and masks preparse/validation/private canaries', async () => {
    const f = await fixture(),
      body = previewBody(f);
    await problem(
      await post(
        '/v1/experience/region/preview',
        { ...body, [canary]: canary },
        { 'content-type': 'application/json' },
      ),
      'UNAUTHENTICATED',
    );
    await problem(
      await post(
        '/v1/experience/region/open',
        { version: canary },
        { ...headers(f), 'x-ks-scope': `${randomUUID()}:1` },
      ),
      'SCOPE_MISMATCH',
    );
    await problem(
      await post('/v1/experience/region/preview', body, {
        ...headers(f, true),
        origin: 'https://foreign.fixture.invalid',
      }),
      'ORIGIN_NOT_ALLOWED',
    );
    for (const invalid of [
      { ...body, [canary]: canary },
      { ...body, target: { ...body.target, regionId: canary } },
      { ...body, capabilities: { ...baselineCapabilities, blocks: { [canary]: [1] } } },
    ])
      await problem(await post('/v1/experience/region/preview', invalid, headers(f)), 'INVALID_REQUEST');
    const malformed = await fetch(origin + '/v1/experience/region/open', {
      method: 'POST',
      headers: headers(f),
      body: `{"${canary}":`,
      signal: AbortSignal.timeout(15000),
    });
    await problem(malformed, 'INVALID_REQUEST');
    const foreign = await post(
      '/v1/experience/region/preview',
      { ...body, target: { ...f.target, regionId: randomUUID() } },
      headers(f),
    );
    expect(foreign.status).toBe(200);
    expect(RegionEncounterPreviewResponseSchema.parse(await foreign.json())).toMatchObject({
      status: 'unavailable',
      reason: 'stale_target',
    });
  });
  it('keeps the real Clear barrier and current epoch ahead of a Region read', async () => {
    const f = await fixture();
    const clear = await post(
      '/v1/privacy/clear-exploration',
      {
        version: 'clear-exploration.v1',
        commandId: randomUUID(),
        expectedPrivacyEpoch: 1,
        confirmation: 'clear-exploration-preserve-keep-and-social',
      },
      headers(f),
    );
    expect(clear.status).toBe(202);
    await problem(await post('/v1/experience/region/preview', previewBody(f), headers(f)), 'SCOPE_MISMATCH');
    await problem(
      await post('/v1/experience/region/preview', previewBody(f), headers(f, false, 2)),
      'UNIVERSE_UNAVAILABLE',
    );
  });
});
