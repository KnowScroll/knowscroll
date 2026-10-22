/** Authored CI mappings/geography only. No live semantic approval, model call or formation. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import type { RegionEncounterOpenRequest, RegionEncounterTarget } from '@knowscroll/contracts';
import { makeWithPersonalScope, transactionOf, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { createBoss, applyQueueDeclarations, makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import { explorationStores, personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse, eraseExploration, checkErasureInventory } from '@knowscroll/backend/infrastructure/erasure';
import { REGION_ENCOUNTERS, type RegionEncounterUseCases } from '@knowscroll/backend/modules/experience';
import {
  navigationProviders,
  NAVIGATION_PORTS,
  makeNavigateEncounter,
  makeActivateOffer,
  makeRegionEncounters,
  type NavigationPorts,
} from '@knowscroll/backend/modules/experience/nest-providers';
import {
  contentProviders,
  coverageCatalogue,
  makeAdmitCoverage,
  makeCoverageAdmissionPorts,
} from '@knowscroll/backend/modules/content/nest-providers';
import { COVERAGE_POLICY, CONCEPT_CATALOGUE_VERSION, type CoverageCommand } from '@knowscroll/backend/modules/content';
import { composerProviders } from '@knowscroll/backend/modules/composer/nest-providers';
import { READ_COMPOSER_CONTEXT } from '@knowscroll/backend/modules/personal-context';
import { READ_OWN_REGION_CONSTRAINT } from '@knowscroll/backend/modules/geography';
import { geographyProviders } from '@knowscroll/backend/modules/geography/nest-providers';
import { clearReasoning } from '@knowscroll/backend/reasoning/nest-providers';
import { clearExplorationQueue, recoverClearOperationsQueue } from '@knowscroll/backend/modules/identity';
import { clearExplorationFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { identityScopeOwnerProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { scrollUseCases, starterSource, baselineCapabilities } from '../support/scroll.js';
import { buildFromProviders } from '../support/providers.js';

const topic = 'earth.seasons',
  facet = 'earth.seasons.axial-tilt';
const capabilities = baselineCapabilities;
describe('current canonical Region navigation (real PostgreSQL, Actions only)', () => {
  let database: TestDatabase<Database>,
    c: Awaited<ReturnType<typeof scrollUseCases>>,
    p: NavigationPorts,
    region: RegionEncounterUseCases;
  let privacyBoss: ReturnType<typeof createBoss>;
  const approvals = new Map<string, string>();
  const scope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 2000 });
  beforeAll(async () => {
    database = await createTestDatabase<Database>('region_encounter');
    c = await scrollUseCases(database);
    privacyBoss = createBoss(database.settings, 'install', { onError: () => undefined, onWarning: () => undefined });
    await privacyBoss.start();
    await applyQueueDeclarations(privacyBoss, [clearExplorationQueue, recoverClearOperationsQueue]);
    const SCOPE = Symbol('scope'),
      ENQUEUE = Symbol('enqueue');
    const values = new Map<symbol, unknown>([
      [SCOPE, scope()],
      [ENQUEUE, makeEnqueueJob(c.boss)],
      [READ_COMPOSER_CONTEXT, c.readComposerContext],
      ...contentProviders().map((x) => [x.provide, x.useValue] as const),
      ...composerProviders({ isOperator: () => false }).map((x) => [x.provide, x.useValue] as const),
      ...identityScopeOwnerProviders().map((x) => [x.provide, x.useValue] as const),
    ]);
    values.set(
      READ_OWN_REGION_CONSTRAINT,
      buildFromProviders(
        geographyProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE }),
        READ_OWN_REGION_CONSTRAINT,
        values,
      ),
    );
    p = buildFromProviders(
      navigationProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE }, { region: true }),
      NAVIGATION_PORTS,
      values,
    ) as NavigationPorts;
    region = makeRegionEncounters(p, makeNavigateEncounter(p));
    expect(REGION_ENCOUNTERS.description).toBe('experience.regionEncounters');
  });
  afterAll(async () => {
    await privacyBoss?.stop({ graceful: false });
    await c?.close();
    await database?.drop();
  });
  function review(command: CoverageCommand) {
    approvals.set(canonicalSha256(command), command.semanticReviewReference);
    return command;
  }
  const admit = (command: CoverageCommand) =>
    makeAdmitCoverage(makeCoverageAdmissionPorts(database.db, (digest, ref) => approvals.get(digest) === ref))(
      review(command),
    );
  async function asset(mappedFacet = facet) {
    const source = starterSource() as {
      assetId: string;
      reference: string;
      publication: { explanationUnitId: string };
      draft: { title: string };
    };
    source.assetId = randomUUID();
    source.reference = 'ci-only-region-source';
    source.publication.explanationUnitId = 'ci-region-' + randomUUID();
    source.draft.title = 'Authored CI Region card';
    expect((await c.importScroll(source)).kind).toBe('imported');
    const row = await database.db
      .selectFrom('content.asset_revisions')
      .select(['document_sha256', 'reading_facts'])
      .where('asset_id', '=', source.assetId)
      .executeTakeFirstOrThrow();
    const provenance = await database.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .where('asset_id', '=', source.assetId)
      .executeTakeFirstOrThrow();
    const command: CoverageCommand = {
      version: 'content-coverage-command.v1',
      assetId: source.assetId,
      assetRevision: 1,
      expectedHeadRevision: 0,
      semanticReviewReference: 'ci-only-region-review',
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
              facetId: mappedFacet,
              meaningSha256: coverageCatalogue.meaningSha256(topic, mappedFacet)!,
              requiredBlockIds: ['intro-look-up'],
            },
          ],
        },
      },
    };
    await admit(command);
    return { assetId: source.assetId, assetRevision: 1, command };
  }
  async function place(person: FixturePerson, mappedFacet = facet): Promise<RegionEncounterTarget> {
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
        id: randomUUID(),
        key: `region:${mappedFacet}:factual`,
        kind: 'region',
        conceptId: mappedFacet,
        parentKey: `planet:${topic}:factual`,
      },
    ];
    await database.db
      .insertInto('geography.state')
      .values({ universe_id: person.universeId, privacy_epoch: 1, revision: 1, structure_revision: 1 })
      .execute();
    for (const object of objects)
      await database.db
        .insertInto('geography.objects')
        .values({
          universe_id: person.universeId,
          privacy_epoch: 1,
          id: object.id,
          semantic_key: object.key,
          payload: {
            ...object,
            truthStatus: 'factual',
            label: 'CI fixture',
            labels: ['CI fixture'],
            objectRevision: 1,
          },
          support_refs: JSON.stringify([]),
        })
        .execute();
    return { kind: 'region', regionId: objects[2]!.id, expectedObjectRevision: 1, expectedGeographyRevision: 1 };
  }
  const open = (
    target: RegionEncounterTarget,
    expected?: { assetId: string; assetRevision: number },
  ): RegionEncounterOpenRequest => ({
    version: 'region-encounter-open.v1',
    commandId: randomUUID(),
    target,
    capabilities,
    ...(expected ? { expectedEncounter: { assetId: expected.assetId, assetRevision: expected.assetRevision } } : {}),
  });
  const preview = (person: FixturePerson, target: RegionEncounterTarget) =>
    region.preview(person.authority, {
      version: 'region-encounter-preview.v1',
      readId: randomUUID(),
      target,
      capabilities,
    });
  async function effects(person: FixturePerson) {
    const result: Record<string, unknown> = {};
    for (const table of [
      'experience.sessions',
      'experience.offers',
      'experience.offer_region_constraints',
      'experience.exposures',
      'experience.offer_activations',
      'experience.navigation_transitions',
      'receipts.personal_commands',
      'composer.decisions',
    ] as const) {
      const row = await sql<{
        n: number;
      }>`select count(*)::int n from ${sql.table(table)} where universe_id=${person.universeId}::uuid`.execute(
        database.db,
      );
      result[table] = row.rows[0]!.n;
    }
    result.root = await database.db
      .selectFrom('identity.universes')
      .select(['revision', 'privacy_epoch'])
      .where('id', '=', person.universeId)
      .executeTakeFirstOrThrow();
    result.jobs = (
      await sql<{
        n: number;
      }>`select count(*)::int n from pgboss.job where data->>'universeId'=${person.universeId}`.execute(database.db)
    ).rows[0]!.n;
    return result;
  }
  async function ready(person: FixturePerson, command: RegionEncounterOpenRequest) {
    const r = await region.open(person.authority, command);
    if (r.kind !== 'accepted' || r.value.outcome.status !== 'ready') throw new Error('CI regional Open refused');
    return r.value.outcome;
  }
  it('preview reads the real indexed card with no personal effects and never substitutes a foreign/stale place', async () => {
    const person = await seedPerson(database.db),
      other = await seedPerson(database.db),
      target = await place(person),
      a = await asset();
    const before = await effects(person),
      value = await preview(person, target);
    expect(value).toMatchObject({
      kind: 'accepted',
      value: {
        status: 'available',
        scope: { universeId: person.universeId, privacyEpoch: 1 },
        encounter: { assetId: a.assetId },
      },
    });
    expect(await effects(person)).toEqual(before);
    expect(await preview(other, target)).toMatchObject({
      kind: 'accepted',
      value: { status: 'unavailable', reason: 'stale_target' },
    });
    expect(await preview(person, { ...target, expectedObjectRevision: 2 })).toEqual({
      kind: 'refused',
      code: 'INVALID_REQUEST',
    });
    expect(await preview(person, { ...target, expectedObjectRevision: 2, expectedGeographyRevision: 2 })).toMatchObject(
      {
        kind: 'accepted',
        value: { status: 'unavailable', reason: 'stale_target' },
      },
    );
    expect(await effects(person)).toEqual(before);
  });
  it('displayed A remains exact, unknown replay is stable, and retraction refuses before old receipt replay', async () => {
    const person = await seedPerson(database.db),
      target = await place(person),
      a = await asset();
    await asset();
    const command = open(target, a),
      first = await ready(person, command),
      before = await effects(person);
    expect(first.offer.assetId).toBe(a.assetId);
    expect(await region.open(person.authority, command)).toMatchObject({
      kind: 'accepted',
      value: { outcome: { ...first, replayed: true } },
    });
    expect(await effects(person)).toEqual(before);
    const changed = { ...command, expectedEncounter: { assetId: randomUUID(), assetRevision: 1 } };
    expect(await region.open(person.authority, changed)).toEqual({ kind: 'refused', code: 'COMMAND_KEY_REUSED' });
    await admit({ ...a.command, expectedHeadRevision: 1, change: { kind: 'retract' } });
    expect(await region.open(person.authority, command)).toEqual({ kind: 'refused', code: 'OFFER_UNAVAILABLE' });
    expect(await region.open(person.authority, open(target, a))).toEqual({
      kind: 'refused',
      code: 'OFFER_UNAVAILABLE',
    });
    expect(await effects(person)).toEqual(before);
  });
  it('all actual offers and vertical children retain immutable region identity; legacy writer cannot escape it', async () => {
    const person = await seedPerson(database.db),
      target = await place(person);
    await asset();
    await asset();
    await asset();
    const first = await ready(person, open(target));
    const ids = [first.offer, ...first.bufferedOffers].map((x) => x.offerId);
    const rows = await database.db
      .selectFrom('experience.offer_region_constraints')
      .selectAll()
      .where('universe_id', '=', person.universeId)
      .execute();
    expect(rows.map((x) => x.offer_id).sort()).toEqual(ids.sort());
    expect(rows.every((x) => JSON.stringify(x.constraint_payload).includes(target.regionId))).toBe(true);
    await expect(
      sql`update experience.offer_region_constraints set mapping_sha256=repeat('a',64) where universe_id=${person.universeId}::uuid`.execute(
        database.db,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const activation = {
      commandId: randomUUID(),
      target: {
        kind: 'offer' as const,
        sessionId: first.sessionId,
        offerId: first.offer.offerId,
        expectedIntentRevision: first.intentRevision,
      },
    };
    const activated = await makeActivateOffer(p)(person.authority, activation);
    if (activated.kind !== 'accepted') throw new Error('CI regional activation refused');
    const next = await makeNavigateEncounter(p)(person.authority, {
      commandId: randomUUID(),
      sessionId: first.sessionId,
      expectedIntentRevision: first.intentRevision,
      from: { offerId: first.offer.offerId, exposureId: activated.outcome.exposureId },
      intent: { mode: 'vertical', direction: 'next' },
    });
    expect(next.kind).toBe('accepted');
    const all = await database.db
      .selectFrom('experience.offer_region_constraints')
      .select('constraint_payload')
      .where('universe_id', '=', person.universeId)
      .execute();
    expect(all.length).toBeGreaterThan(rows.length);
    expect(all.every((x) => JSON.stringify(x.constraint_payload).includes(target.regionId))).toBe(true);
    const original = await database.db
      .selectFrom('experience.offers')
      .selectAll()
      .where('id', '=', first.offer.offerId)
      .executeTakeFirstOrThrow();
    const illegalId = randomUUID();
    await expect(
      database.db.transaction().execute(async (tx) => {
        await tx
          .insertInto('experience.offers')
          .values({
            ...original,
            id: illegalId,
            source_offer_id: first.offer.offerId,
            source_exposure_id: activated.outcome.exposureId,
            descriptor: { ...first.offer, offerId: illegalId },
          })
          .execute();
      }),
    ).rejects.toThrow('REGION_CONSTRAINT_REQUIRED');
    expect(
      await database.db.selectFrom('experience.offers').select('id').where('id', '=', illegalId).execute(),
    ).toEqual([]);
  });
  it('refuses old activation without a permit and rolls exposure/receipt/job back; correct new activation is atomic', async () => {
    const person = await seedPerson(database.db),
      target = await place(person),
      a = await asset(),
      first = await ready(person, open(target, a));
    const command = {
      commandId: randomUUID(),
      target: {
        kind: 'offer' as const,
        sessionId: first.sessionId,
        offerId: first.offer.offerId,
        expectedIntentRevision: first.intentRevision,
      },
    };
    const before = await effects(person);
    const legacy = makeActivateOffer({ ...p, bindOffer: (s, o, e) => p.bindOffer(s, o, e) });
    await expect(legacy(person.authority, command)).rejects.toThrow('REGION_PROTOCOL_REQUIRED');
    expect(await effects(person)).toEqual(before);
    const failed = makeActivateOffer({
      ...p,
      enqueueActivity: async (s, e) => {
        await p.enqueueActivity(s, e);
        throw new Error('CI_REQUIRED_JOB_ROLLBACK');
      },
    });
    await expect(failed(person.authority, command)).rejects.toThrow('CI_REQUIRED_JOB_ROLLBACK');
    expect(await effects(person)).toEqual(before);
    const accepted = await makeActivateOffer(p)(person.authority, command);
    expect(accepted.kind).toBe('accepted');
    const after = await effects(person);
    expect(await makeActivateOffer(p)(person.authority, command)).toMatchObject({
      kind: 'accepted',
      outcome: { replayed: true },
    });
    expect(await effects(person)).toEqual(after);
    expect(
      (
        await sql<{
          value: string | null;
        }>`select current_setting('knowscroll.region_activation_v1',true) value`.execute(database.db)
      ).rows[0]?.value ?? '',
    ).toBe('');
    await admit({ ...a.command, expectedHeadRevision: 1, change: { kind: 'retract' } });
    expect(await makeActivateOffer(p)(person.authority, command)).toEqual({
      kind: 'refused',
      code: 'OFFER_UNAVAILABLE',
    });
    expect(await effects(person)).toEqual(after);
  });
  it('rechecks Geography after Composer and before receipt replay; no session or offer escapes a stale snapshot', async () => {
    const person = await seedPerson(database.db),
      target = await place(person),
      a = await asset();
    let once = false;
    const raced = makeRegionEncounters(
      p,
      makeNavigateEncounter({
        ...p,
        compose: (s) => {
          const result = p.compose(s);
          once = true;
          return result;
        },
        withPersonalScope: async (authority, fn) => {
          if (once) {
            once = false;
            await database.db
              .updateTable('geography.state')
              .set({ revision: 2 })
              .where('universe_id', '=', person.universeId)
              .execute();
          }
          return p.withPersonalScope(authority, fn);
        },
      }),
    );
    const before = await effects(person);
    expect(await raced.open(person.authority, open(target, a))).toEqual({ kind: 'refused', code: 'OFFER_UNAVAILABLE' });
    expect(await effects(person)).toEqual(before);
  });
  it('account revocation, epoch and Clear barrier refuse current access before historical commands', async () => {
    const person = await seedPerson(database.db),
      target = await place(person),
      a = await asset(),
      command = open(target, a);
    await ready(person, command);
    await database.db
      .updateTable('identity.accounts')
      .set({ status: 'suspended' })
      .where('id', '=', person.accountId)
      .execute();
    expect(await region.open(person.authority, command)).toEqual({ kind: 'refused', code: 'UNIVERSE_UNAVAILABLE' });
    expect(await preview(person, target)).toEqual({ kind: 'refused', code: 'UNIVERSE_UNAVAILABLE' });
    await database.db
      .updateTable('identity.accounts')
      .set({ status: 'active' })
      .where('id', '=', person.accountId)
      .execute();
    await database.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', person.universeId)
      .execute();
    expect(await region.open(person.authority, command)).toEqual({ kind: 'refused', code: 'PRIVACY_EPOCH_CHANGED' });
  });
  it('full erasure inventories/removes constraints across epochs, preserving other owner and shared canonical projection', async () => {
    const a = await seedPerson(database.db),
      b = await seedPerson(database.db),
      ta = await place(a),
      tb = await place(b),
      card = await asset();
    await ready(a, open(ta, card));
    await ready(b, open(tb, card));
    const shared = await database.db.selectFrom('content.region_bindings').selectAll().execute();
    const peer = await database.db
      .selectFrom('experience.offer_region_constraints')
      .selectAll()
      .where('universe_id', '=', b.universeId)
      .execute();
    expect(await checkErasureInventory(database.db, personalStores)).toEqual([]);
    await scope()(a.authority, (s) => eraseUniverse(s, personalStores));
    expect(
      await database.db
        .selectFrom('experience.offer_region_constraints')
        .selectAll()
        .where('universe_id', '=', a.universeId)
        .execute(),
    ).toEqual([]);
    expect(
      await database.db
        .selectFrom('experience.offer_region_constraints')
        .selectAll()
        .where('universe_id', '=', b.universeId)
        .execute(),
    ).toEqual(peer);
    expect(await database.db.selectFrom('content.region_bindings').selectAll().execute()).toEqual(shared);
    expect(
      await scope()(b.authority, (s) =>
        transactionOf(s).selectFrom('experience.offer_region_constraints').select('offer_id').execute(),
      ),
    ).toMatchObject({ kind: 'entered' });
  });
  it('selective Clear removes every regional constraint while preserving Saved tuples/shared map; late replay cannot erase fresh data', async () => {
    const person = await seedPerson(database.db),
      target = await place(person),
      card = await asset();
    await ready(person, open(target, card));
    await database.db
      .insertInto('experience.saved_items')
      .values({ universe_id: person.universeId, asset_id: card.assetId, asset_revision: 1, saved_at: new Date() })
      .execute();
    const saved = await database.db
      .selectFrom('experience.saved_items')
      .selectAll()
      .where('universe_id', '=', person.universeId)
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('experience.saved_places')
      .values({
        universe_id: person.universeId,
        saved_entry_id: saved.saved_entry_id,
        place_revision: '1',
        position: JSON.stringify({ kind: 'scroll', blockId: 'intro-look-up', offsetWithinBlock: 12.5 }),
      })
      .execute();
    const places = await database.db
      .selectFrom('experience.saved_places')
      .selectAll()
      .where('universe_id', '=', person.universeId)
      .execute();
    const bindings = await database.db.selectFrom('content.region_bindings').selectAll().execute();
    const clear = clearExplorationFor(database.db, privacyBoss, {
        reasoning: clearReasoning,
        eraseCore: async (s) => {
          await eraseExploration(s, explorationStores);
        },
      }),
      commandId = randomUUID();
    const started = await clear.start(
      { accountId: person.accountId, universeId: person.universeId, privacyEpoch: 1 },
      {
        version: 'clear-exploration.v1',
        commandId,
        expectedPrivacyEpoch: 1,
        confirmation: 'clear-exploration-preserve-keep-and-social',
      },
    );
    expect(started).toMatchObject({ kind: 'entered', value: { kind: 'ok' } });
    const fresh = { ...person.authority, privacyEpoch: 2 };
    expect(
      await region.preview(fresh, {
        version: 'region-encounter-preview.v1',
        readId: randomUUID(),
        target,
        capabilities,
      }),
    ).toEqual({ kind: 'refused', code: 'UNIVERSE_UNAVAILABLE' });
    await clear.process({ v: 1, accountId: person.accountId, commandId });
    expect(
      await database.db
        .selectFrom('experience.offer_region_constraints')
        .selectAll()
        .where('universe_id', '=', person.universeId)
        .execute(),
    ).toEqual([]);
    expect(
      await database.db
        .selectFrom('experience.saved_items')
        .selectAll()
        .where('universe_id', '=', person.universeId)
        .execute(),
    ).toEqual([saved]);
    expect(
      await database.db
        .selectFrom('experience.saved_places')
        .selectAll()
        .where('universe_id', '=', person.universeId)
        .execute(),
    ).toEqual(places);
    expect(await database.db.selectFrom('content.region_bindings').selectAll().execute()).toEqual(bindings);
    const freshSession = randomUUID();
    await database.db
      .insertInto('experience.sessions')
      .values({
        universe_id: person.universeId,
        privacy_epoch: 2,
        id: freshSession,
        intent_revision: 0,
        capabilities,
        intent: { kind: 'fixture-fresh-after-clear' },
      })
      .execute();
    await clear.process({ v: 1, accountId: person.accountId, commandId });
    expect(
      await database.db.selectFrom('experience.sessions').select('id').where('id', '=', freshSession).execute(),
    ).toEqual([{ id: freshSession }]);
  });

  it('waits on the root, then rechecks account authority before returning a preview', async () => {
    const person = await seedPerson(database.db),
      target = await place(person);
    await asset();
    const held = await database.pool.connect();
    await held.query('begin');
    await held.query('select id from identity.universes where id=$1 for update', [person.universeId]);
    const pending = preview(person, target);
    try {
      await expect
        .poll(
          async () =>
            (
              await sql<{
                n: number;
              }>`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
                database.db,
              )
            ).rows[0]!.n,
        )
        .toBeGreaterThan(0);
      await database.db
        .updateTable('identity.accounts')
        .set({ status: 'suspended' })
        .where('id', '=', person.accountId)
        .execute();
    } finally {
      await held.query('rollback');
      held.release();
    }
    expect(await pending).toEqual({ kind: 'refused', code: 'UNIVERSE_UNAVAILABLE' });
  });
  it('holds exact current Content authorities through commit, so a concurrent retraction waits', async () => {
    const person = await seedPerson(database.db),
      a = await asset();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => {
        entered = r;
      }),
      held = new Promise<void>((r) => {
        release = r;
      });
    const consumer = scope()(person.authority, async (sc) => {
      const found = await p.readRegionCandidates(sc, {
        topicId: topic,
        facetId: facet,
        truthStatus: 'factual',
        capabilities,
        expected: { assetId: a.assetId, assetRevision: 1 },
      });
      if (found.kind !== 'read' || !found.candidates[0]) throw new Error('CI candidate missing');
      expect(
        await p.lockRegionCandidates(sc, {
          topicId: topic,
          facetId: facet,
          truthStatus: 'factual',
          capabilities,
          candidates: [{ ref: { assetId: a.assetId, assetRevision: 1 }, coverage: found.candidates[0].coverage }],
        }),
      ).toBe(true);
      entered();
      await held;
    });
    await ready;
    const correction = admit({ ...a.command, expectedHeadRevision: 1, change: { kind: 'retract' } });
    try {
      await expect
        .poll(
          async () =>
            (
              await sql<{
                n: number;
              }>`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
                database.db,
              )
            ).rows[0]!.n,
        )
        .toBeGreaterThan(0);
    } finally {
      release();
    }
    await consumer;
    await correction;
    expect(
      await scope()(person.authority, (sc) =>
        p.readRegionCandidates(sc, {
          topicId: topic,
          facetId: facet,
          truthStatus: 'factual',
          capabilities,
          expected: { assetId: a.assetId, assetRevision: 1 },
        }),
      ),
    ).toMatchObject({ kind: 'entered', value: { kind: 'read', candidates: [], hasMore: false } });
  });
  it('rejects forged/copied/foreign/closed/reused region permits without mutating bindings', async () => {
    const person = await seedPerson(database.db),
      target = await place(person),
      a = await asset(),
      first = await ready(person, open(target, a));
    const command = {
      commandId: randomUUID(),
      target: {
        kind: 'offer' as const,
        sessionId: first.sessionId,
        offerId: first.offer.offerId,
        expectedIntentRevision: first.intentRevision,
      },
    };
    let captured: Parameters<NavigationPorts['bindOffer']> | undefined;
    const run = makeActivateOffer({
      ...p,
      bindOffer: async (...args) => {
        captured = args;
        await p.bindOffer(...args);
      },
    });
    expect((await run(person.authority, command)).kind).toBe('accepted');
    if (!captured || !captured[3]) throw new Error('CI permit not observed');
    const old = captured,
      before = await effects(person);
    await expect(p.bindOffer(...old)).rejects.toThrow();
    await scope()(person.authority, async (sc) => {
      for (const permit of [{}, { ...old[3] }, old[3]])
        await expect(p.bindOffer(sc, first.offer.offerId, randomUUID(), permit as never)).rejects.toThrow(
          'REGION_ACTIVATION_PERMIT_INVALID',
        );
      await expect(p.bindOffer({ ...sc }, first.offer.offerId, randomUUID(), old[3])).rejects.toThrow();
      await expect(p.bindOffer(sc, randomUUID(), randomUUID(), old[3])).rejects.toThrow(
        'REGION_ACTIVATION_PERMIT_INVALID',
      );
    });
    expect(await effects(person)).toEqual(before);
  });

  it('bounds the actual canonical lookup to100+one and never calls a hidden first page exhausted; expected tail A uses its exact key', async () => {
    const person = await seedPerson(database.db),
      mappedFacet = 'earth.seasons.hemispheres',
      target = await place(person, mappedFacet);
    const cards = [];
    for (let i = 0; i < 101; i++) cards.push(await asset(mappedFacet));
    const sorted = cards.sort((a, b) => a.assetId.localeCompare(b.assetId));
    const query = { topicId: topic, facetId: mappedFacet, truthStatus: 'factual' as const, capabilities };
    const read = await scope()(person.authority, (sc) => p.readRegionCandidates(sc, query));
    expect(read).toMatchObject({ kind: 'entered', value: { kind: 'read', hasMore: true } });
    if (read.kind !== 'entered' || read.value.kind !== 'read') throw new Error('CI canonical lookup failed');
    expect(read.value.candidates.map((x) => x.encounter.assetId)).toEqual(sorted.slice(0, 100).map((x) => x.assetId));
    const tail = sorted[100]!;
    await database.db
      .insertInto('experience.action_state')
      .values(
        sorted
          .slice(0, 100)
          .map((x) => ({ universe_id: person.universeId, privacy_epoch: 1, asset_id: x.assetId, hidden: true })),
      )
      .execute();
    expect(await preview(person, target)).toMatchObject({
      kind: 'accepted',
      value: { status: 'unavailable', reason: 'selection_unavailable' },
    });
    const before = await effects(person);
    expect(await region.open(person.authority, open(target))).toEqual({ kind: 'refused', code: 'OFFER_UNAVAILABLE' });
    expect(await effects(person)).toEqual(before);
    expect((await ready(person, open(target, tail))).offer.assetId).toBe(tail.assetId);
  }, 60000);
});
