import { createHmac, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { makeEnqueueInTransaction } from '@knowscroll/backend/infrastructure/jobs';
import { CONCEPTS, CONCEPT_CATALOGUE_VERSION } from '@knowscroll/backend/modules/content';
import {
  catalogueOf,
  derivedPlaceId,
  derivedRouteId,
  makeSettleQuiet,
  makeSweepQuiet,
  quietSweepStore,
  type Catalogue,
  type CatalogueTopic,
  type CartographerPorts,
} from '@knowscroll/backend/modules/geography/nest-providers';
import { reconcileCoverageDirty } from '@knowscroll/backend/modules/personal-context/nest-providers';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { gate, signal } from '../support/fixture-model.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { geographyWorld, topic, facet, otherFacet, type GeographyWorld } from '../support/geography-world.js';

/**
 * Formation costs what changed (#674, slice 4.1, D-416): the dirty set, the evaluation of only the topics a run takes, the
 * derived ids and the per-place quiet time, on real PostgreSQL. The scale cases give a reader a catalogue of two hundred and forty
 * topics and thousands of support keys; the trusted read is a labelled CI fixture over them (the real Content and Evidence
 * checks are exercised by the other suites), everything else is the real code and database.
 */
const DAY = 86_400_000;
const garbage: FixtureScenario = { kind: 'malformed' };

describe('incremental formation on real PostgreSQL (CI fixtures)', () => {
  let world: GeographyWorld;
  beforeAll(async () => {
    world = await geographyWorld('incremental_formation');
  });
  afterAll(() => world.close());

  const db = () => world.database.db;
  const dirtyOf = async (person: FixturePerson) =>
    (
      await db()
        .selectFrom('personal_context.coverage_dirty_topics')
        .select(['topic_id', 'dirty_revision'])
        .where('universe_id', '=', person.universeId)
        .orderBy('topic_id')
        .execute()
    ).map((row) => ({ topic: row.topic_id, revision: row.dirty_revision }));
  /** Runs the person's active Cartographer run once; the fixture model answers nothing usable. */
  async function cartograph(person: FixturePerson, overrides?: Partial<CartographerPorts>) {
    const runId = (await world.state(person)).activeRunId;
    if (!runId) throw new Error('CI expected an active Cartographer run');
    const run = world.runner(person, () => garbage, overrides);
    await run.run(await world.job(person, runId), signal());
    return { runId, calls: run.model.calls.length };
  }
  async function places(person: FixturePerson) {
    const universe = await world.snapshot(person);
    return 'page' in universe ? universe.page.objects : [];
  }
  /** The stored places by kind and activity, read from the table: a universe of hundreds of places is not paged through the snapshot here. */
  async function storedPlaces(person: FixturePerson) {
    return (
      await sql<{ kind: string; state: string | null; n: number }>`select payload ->> 'kind' as kind,
        payload #>> '{activity,state}' as state, count(*)::int as n from geography.objects
        where universe_id = ${person.universeId}::uuid group by 1, 2`.execute(db())
    ).rows;
  }
  const total = (rows: { n: number }[], match: (row: { kind: string; state: string | null }) => boolean = () => true) =>
    rows.filter((row) => match(row as never)).reduce((sum, row) => sum + row.n, 0);

  describe('reading that arrives during a run', () => {
    it('keeps the topic dirty, and gives it its own paced run once the answer in flight has applied', async () => {
      const person = await seedPerson(db());
      await world.coherent(person);
      expect(await dirtyOf(person)).toEqual([{ topic, revision: expect.any(Number) as number }]);
      const first = (await world.state(person)).activeRunId!;
      const answer = gate<FixtureScenario>();
      let frozen!: Parameters<NonNullable<Parameters<typeof world.runner>[1]>>[0];
      let inFlight!: () => void;
      const flying = new Promise<void>((resolve) => {
        inFlight = resolve;
      });
      const run = world.runner(person, (context) => {
        frozen = context;
        inFlight();
        return { kind: 'hold', until: answer.promise };
      });
      const finished = run.run(await world.job(person, first), signal());
      await flying;
      expect(frozen.evaluated).toMatchObject({ topics: [topic], hasMore: false });
      const [seen] = await dirtyOf(person);

      // Two Scrolls are read while the model works: the topic is marked again, at a later revision.
      await world.observe(person, await world.fixture(undefined, topic, [facet]));
      await world.observe(person, await world.fixture(undefined, 'earth.tides', ['earth.tides.forcing']));
      answer.open({ kind: 'success', text: JSON.stringify(world.formation(frozen)) });
      await finished;

      expect((await places(person)).map((place) => place.kind).sort()).toEqual([
        'planet',
        'region',
        'region',
        'star',
        'system',
      ]);
      // The run cleared only what it had seen: both topics are dirty again, the later reading above the run's read.
      const after = await dirtyOf(person);
      expect(after.map((row) => row.topic)).toEqual([topic, 'earth.tides']);
      for (const row of after) expect(row.revision).toBeGreaterThan(seen!.revision);
      // And they have their own run, paced, which takes both and clears them.
      const successor = (await world.state(person)).activeRunId;
      expect(successor).toBeDefined();
      expect(successor).not.toBe(first);
      const second = await cartograph(person);
      expect(second.runId).toBe(successor);
      expect(await dirtyOf(person)).toEqual([]);
      expect((await world.state(person)).activeRunId).toBeUndefined();
    });

    it('applies activity changes of the second run to the places it evaluated, and stores when each was last supported', async () => {
      const person = await seedPerson(db());
      await world.coherent(person);
      await cartograph(person);
      const rows = await db()
        .selectFrom('geography.objects')
        .select(['semantic_key', 'last_support_at', 'quiet_check_at'])
        .where('universe_id', '=', person.universeId)
        .execute();
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(row.last_support_at).toBeInstanceOf(Date);
        expect(row.quiet_check_at!.getTime()).toBe(row.last_support_at!.getTime() + 30 * DAY + 1);
      }
    });
  });

  describe('an explicit request and the operator reconciliation', () => {
    it('marks every topic with a support key dirty, and a run takes them as a reading does', async () => {
      const person = await seedPerson(db());
      await world.observe(person, await world.fixture(undefined, topic, [facet]));
      await world.observe(person, await world.fixture(undefined, 'earth.tides', ['earth.tides.forcing']));
      await cartograph(person);
      expect(await dirtyOf(person)).toEqual([]);
      const asked = await world.request(person.authority, { commandId: randomUUID() });
      if (asked.kind !== 'accepted') throw new Error('CI request refused');
      expect((await dirtyOf(person)).map((row) => row.topic)).toEqual([topic, 'earth.tides']);
      const run = await cartograph(person);
      expect(run.runId).toBe(asked.runId);
      expect(await dirtyOf(person)).toEqual([]);
    });

    it('marks the topics of every reader with support, once, and writes nothing when asked only to count', async () => {
      const reader = await seedPerson(db());
      await world.observe(reader, await world.fixture(undefined, topic, [facet]));
      await world.observe(reader, await world.fixture(undefined, topic, [otherFacet]));
      await cartograph(reader);
      expect(await dirtyOf(reader)).toEqual([]);
      const nobody = await seedPerson(db());

      expect(await reconcileCoverageDirty(db(), { universeId: reader.universeId, dryRun: true })).toEqual({
        universes: 1,
        topics: 1,
      });
      expect(await dirtyOf(reader)).toEqual([]);
      expect(await reconcileCoverageDirty(db(), { universeId: reader.universeId, dryRun: false })).toEqual({
        universes: 1,
        topics: 1,
      });
      const [marked] = await dirtyOf(reader);
      expect(marked).toMatchObject({ topic });
      const root = await db()
        .selectFrom('identity.universes')
        .select('revision')
        .where('id', '=', reader.universeId)
        .executeTakeFirstOrThrow();
      // Marked at the universe's current revision, so a run entering after it has seen the row.
      expect(marked!.revision).toBe(Math.max(root.revision, 1));
      // Twice marks nothing new, and a universe with no support is not touched.
      expect(await reconcileCoverageDirty(db(), { universeId: reader.universeId, dryRun: false })).toEqual({
        universes: 0,
        topics: 0,
      });
      expect(await reconcileCoverageDirty(db(), { universeId: nobody.universeId, dryRun: false })).toEqual({
        universes: 0,
        topics: 0,
      });
      expect(await dirtyOf(nobody)).toEqual([]);
    });
  });

  describe('the ids of new places', () => {
    const secretOf = async (person: FixturePerson) =>
      (
        await db()
          .selectFrom('geography.state')
          .select('place_secret')
          .where('universe_id', '=', person.universeId)
          .executeTakeFirstOrThrow()
      ).place_secret!;
    const mac = (secret: string, message: string) =>
      createHmac('sha256', Buffer.from(secret, 'hex')).update(message).digest('hex');

    it('derives a place id from the universe secret and the key, so two universes never share one and a replay finds the same', async () => {
      const [a, b] = [await seedPerson(db()), await seedPerson(db())];
      for (const person of [a, b]) {
        await world.coherent(person);
        await cartograph(person);
      }
      const secrets = [await secretOf(a), await secretOf(b)];
      expect(secrets[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(secrets[0]).not.toBe(secrets[1]);
      const idsOf = async (person: FixturePerson) =>
        Object.fromEntries(
          (
            await db()
              .selectFrom('geography.objects')
              .select(['semantic_key', 'id'])
              .where('universe_id', '=', person.universeId)
              .execute()
          ).map((row) => [row.semantic_key, row.id]),
        );
      const [idsA, idsB] = [await idsOf(a), await idsOf(b)];
      expect(Object.keys(idsA).sort()).toEqual(Object.keys(idsB).sort());
      for (const key of Object.keys(idsA)) {
        expect(idsA[key]).toBe(derivedPlaceId(mac, secrets[0]!, key));
        expect(idsB[key]).toBe(derivedPlaceId(mac, secrets[1]!, key));
        expect(idsA[key]).not.toBe(idsB[key]);
      }
    });

    it('derives a route id from the sorted pair of planets, and keeps the secret through a clear of the places', async () => {
      const person = await seedPerson(db());
      await world.coherent(person);
      await cartograph(person);
      for (let i = 0; i < 3; i++)
        await world.observe(
          person,
          await world.fixture(undefined, 'earth.tides', [i === 1 ? 'earth.tides.alignment' : 'earth.tides.forcing']),
        );
      const runId = (await world.state(person)).activeRunId!;
      const tides = world.runner(person, (context) => {
        const formed = context.facts.objects.find((place) => place.kind === 'planet')!;
        const due = context.facts.candidates.find((c) => c.kind === 'planet' && c.conceptId === 'earth.tides')!;
        return {
          kind: 'success',
          text: JSON.stringify({
            version: 'cartographer-proposal.v1',
            operations: [
              {
                kind: 'connect_route',
                fromKey: due.key,
                toKey: formed.key,
                supportRefs: context.facts.supports.map((support) => support.ref),
              },
            ],
          }),
        };
      });
      await tides.run(await world.job(person, runId), signal());
      const universe = await world.snapshot(person);
      if (universe.status !== 'ready') throw new Error('CI ready expected');
      expect(universe.page.routes).toHaveLength(1);
      const keys = (
        await db()
          .selectFrom('geography.objects')
          .select(['semantic_key'])
          .where('universe_id', '=', person.universeId)
          .where(sql<boolean>`payload ->> 'kind' = 'planet'`)
          .execute()
      ).map((row) => row.semantic_key);
      expect(keys).toHaveLength(2);
      expect(universe.page.routes[0]!.id).toBe(derivedRouteId(mac, await secretOf(person), keys[0]!, keys[1]!));
    });
  });

  describe('a reader with thousands of support keys across hundreds of topics', () => {
    const SYSTEMS = 4,
      TOPICS_PER_SYSTEM = 60,
      FACETS = 3,
      UNITS = 5;
    const topics: CatalogueTopic[] = Array.from({ length: SYSTEMS }, (_, s) => ({
      id: `syn${String(s)}`,
      parent: null,
      meaning: `Synthetic system ${String(s)}.`,
      facets: [],
    })).flatMap((system, s) => [
      system,
      ...Array.from({ length: TOPICS_PER_SYSTEM }, (_, t) => ({
        id: `${system.id}.topic-${String(t).padStart(2, '0')}`,
        parent: system.id,
        meaning: `Synthetic topic ${String(s)}/${String(t)}.`,
        facets: Array.from({ length: FACETS }, (_, f) => ({
          id: `${system.id}.topic-${String(t).padStart(2, '0')}.facet-${String(f)}`,
          meaning: `Synthetic facet ${String(f)}.`,
        })),
      })),
    ]);
    const catalogue: Catalogue = catalogueOf(topics);
    const planets = topics.filter((entry) => entry.parent !== null);
    const hash = (value: unknown) => canonicalSha256(value);
    const truthSha256 = hash({ kind: 'factual' });
    /** Every ninth planet is half built (one unit): it must stay unformed, and form later from its own new reading. */
    const halfBuilt = (index: number) => index % 9 === 4;
    const keysOf = (planet: CatalogueTopic, index: number) =>
      Array.from({ length: halfBuilt(index) ? 1 : UNITS }, (_, unit) =>
        planet.facets.map((f, n) => ({
          topicId: planet.id,
          facetId: f.id,
          unit: `${planet.id}:u${String(unit)}`,
          // A key is read by units over facets in rotation: unit u covers facets u and u+1 (mod FACETS).
          used: n === unit % FACETS || n === (unit + 1) % FACETS,
          ageDays: 2 + ((unit * 7 + index) % 11),
        })),
      )
        .flat()
        .filter((key) => key.used);
    const everyKey = planets.flatMap((planet, index) => keysOf(planet, index));

    /** The trusted read as a labelled fixture: it vouches for each probe, with the activation the key was seeded with. */
    const trusted = ((
      _scope: unknown,
      query: { probes: readonly { topicId: string; facetId: string; explanationUnitId: string }[] },
    ) => {
      const rows = query.probes.map((probe) => {
        const key = everyKey.find(
          (entry) =>
            entry.topicId === probe.topicId &&
            entry.facetId === probe.facetId &&
            entry.unit === probe.explanationUnitId,
        );
        if (!key) return undefined;
        const entry = catalogue.topic(probe.topicId)!;
        const facetEntry = entry.facets.find((f) => f.id === probe.facetId)!;
        const support = {
          topicId: probe.topicId,
          facetId: probe.facetId,
          meaningSha256: hash({
            topicId: entry.id,
            topicMeaning: entry.meaning,
            facetId: facetEntry.id,
            facetMeaning: facetEntry.meaning,
          }),
          explanationUnitId: probe.explanationUnitId,
          truthSha256,
        };
        // Every id is derived from the probe, so the claim and the apply, which each read it, see the same proof.
        const witnessKey = hash(probe);
        const uuidOf = (label: string) => {
          const digest = hash({ label, probe });
          return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
        };
        const identity = {
          sourceKind: 'segment' as const,
          recordingGeneration: 1,
          activityId: uuidOf('activity'),
          qualificationId: uuidOf('qualification'),
          certificateSha256: hash({ witnessKey }),
        };
        const exposureId = uuidOf('exposure');
        return {
          support: { ...support, witnessExposureIds: [exposureId] },
          witness: { ...support, ...identity, exposureId, witnessKey },
          certificate: {
            witnessKey,
            ...identity,
            certificate: {
              exposureId,
              availability: 'available',
              explanationUnitId: probe.explanationUnitId,
              activatedAt: new Date(Date.now() - key.ageDays * DAY).toISOString(),
              mapping: { framing: 'factual', catalogueVersion: CONCEPT_CATALOGUE_VERSION, framingSha256: truthSha256 },
            },
          },
        };
      });
      const found = rows.filter((row) => row !== undefined);
      return Promise.resolve(
        found.length
          ? ({
              version: 'trusted-coverage-read.v1',
              completeness: 'not_asserted',
              supportedFormats: ['scroll'],
              availability: 'available',
              reason: 'current',
              supports: found.map((row) => row.support),
              witnesses: found.map((row) => row.witness),
              certificates: found.map((row) => row.certificate),
            } as const)
          : ({
              version: 'trusted-coverage-read.v1',
              completeness: 'not_asserted',
              supportedFormats: ['scroll'],
              availability: 'unavailable',
              reason: 'not_observed',
              supports: [],
              witnesses: [],
              certificates: [],
            } as const),
      );
    }) as unknown as CartographerPorts['readTrusted'];
    const overrides: Partial<CartographerPorts> = { catalogue, readTrusted: trusted };

    /** The support index rows the projections keep, seeded directly: the keys, how recent each is and one reference each. */
    async function seedReader(person: FixturePerson) {
      const rows = everyKey;
      const chunk = 2000;
      for (let start = 0; start < rows.length; start += chunk) {
        const part = rows.slice(start, start + chunk);
        await sql`insert into personal_context.coverage_supports(universe_id,privacy_epoch,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256,reference_count,last_activated_at)
          select ${person.universeId}::uuid,1,t,f,repeat('0',64),u,repeat('0',64),1,now()-a*interval '1 day'
          from unnest(${part.map((key) => key.topicId)}::text[],${part.map((key) => key.facetId)}::text[],${part.map((key) => key.unit)}::text[],${part.map((key) => key.ageDays)}::int[]) as seed(t,f,u,a)`.execute(
          db(),
        );
      }
    }
    async function bytesOfContexts(person: FixturePerson) {
      return (
        await sql<{ bytes: number }>`select octet_length(context::text) as bytes from geography.runs
          where universe_id = ${person.universeId}::uuid and context is not null order by id`.execute(db())
      ).rows.map((row) => row.bytes);
    }
    /** Runs until no run is pending, as the worker does, and measures. */
    async function formAll(person: FixturePerson) {
      const started = Date.now();
      let runs = 0;
      for (; (await world.state(person)).activeRunId && runs < 60; runs++) await cartograph(person, overrides);
      return { runs, ms: Date.now() - started };
    }

    let person: FixturePerson;
    let measured: { runs: number; ms: number };
    beforeAll(async () => {
      expect(planets.length).toBe(240);
      expect(everyKey.length).toBeGreaterThan(2000);
      person = await seedPerson(db());
      await seedReader(person);
      const asked = await world.request(person.authority, { commandId: randomUUID() });
      if (asked.kind !== 'accepted') throw new Error('CI request refused');
      expect(await dirtyOf(person)).toHaveLength(240);
      measured = await formAll(person);
    }, 600_000);

    it('forms exactly what the rules entitle, a bounded run at a time, with no run held by the whole history', async () => {
      const formed = await storedPlaces(person);
      const count = (kind: string) => total(formed, (row) => row.kind === kind);
      const full = planets.filter((_, index) => !halfBuilt(index));
      expect({ system: count('system'), star: count('star'), planet: count('planet') }).toEqual({
        system: SYSTEMS,
        star: SYSTEMS,
        planet: full.length,
      });
      // Each complete planet has a region for each facet that any of its units covers.
      expect(count('region')).toBe(full.length * FACETS);
      expect(await dirtyOf(person)).toEqual([]);
      expect((await world.state(person)).activeRunId).toBeUndefined();
      // A run took at most 16 topics (and up to 8 neighbours of a system that could be created), never the 200.
      const contexts = await db()
        .selectFrom('geography.runs')
        .select(sql<number>`jsonb_array_length(context -> 'evaluated' -> 'topics')`.as('topics'))
        .where('universe_id', '=', person.universeId)
        .where('context', 'is not', null)
        .execute();
      expect(contexts.length).toBeGreaterThanOrEqual(Math.ceil(planets.length / 16));
      for (const run of contexts) expect(run.topics).toBeLessThanOrEqual(16 + 8 * SYSTEMS);
      const bytes = await bytesOfContexts(person);
      expect(Math.max(...bytes)).toBeLessThan(500_000);
      // The numbers this slice states (printed for the report): runs, the largest frozen context and the wall time.
      // eslint-disable-next-line no-console -- the numbers this slice reports (D-416)
      console.info(
        `incremental-formation scale: ${String(everyKey.length)} support keys over ${String(planets.length)} topics, ${String(measured.runs)} runs, largest context ${String(Math.max(...bytes))} bytes, ${String(measured.ms)} ms`,
      );
      expect(measured.ms).toBeLessThan(300_000);
    });

    it('leaves a half-built planet unformed, however many other supports there are, and forms it from its own next reading', async () => {
      const index = planets.findIndex((_, n) => halfBuilt(n));
      const planet = planets[index]!;
      const planetKey = `planet:${planet.id}:factual`;
      const keyRows = async () =>
        (
          await db()
            .selectFrom('geography.objects')
            .select('semantic_key')
            .where('universe_id', '=', person.universeId)
            .where('semantic_key', '=', planetKey)
            .execute()
        ).length;
      expect(await keyRows()).toBe(0);
      // Two more units over two facets arrive for that one topic: the topic is dirty, and only it is read.
      const more = ['ex-a', 'ex-b'].map((unit, n) => ({
        topicId: planet.id,
        facetId: planet.facets[(n + 1) % FACETS]!.id,
        unit: `${planet.id}:${unit}`,
        ageDays: 1,
      }));
      everyKey.push(...more.map((key) => ({ ...key, used: true })));
      await sql`insert into personal_context.coverage_supports(universe_id,privacy_epoch,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256,reference_count,last_activated_at)
        select ${person.universeId}::uuid,1,t,f,repeat('0',64),u,repeat('0',64),1,now()-interval '1 day'
        from unnest(${more.map((key) => key.topicId)}::text[],${more.map((key) => key.facetId)}::text[],${more.map((key) => key.unit)}::text[]) as seed(t,f,u)`.execute(
        db(),
      );
      const asked = await world.request(person.authority, { commandId: randomUUID() });
      if (asked.kind !== 'accepted') throw new Error('CI request refused');
      // The request marks every topic dirty again; clear all but the one that changed, which is what a reading would have done.
      await sql`delete from personal_context.coverage_dirty_topics where universe_id = ${person.universeId}::uuid and topic_id <> ${planet.id}`.execute(
        db(),
      );
      const run = await cartograph(person, overrides);
      expect(run.runId).toBe(asked.runId);
      expect(await keyRows()).toBe(1);
      // Only the touched topic and the planets formed beside the new one were read, not the two hundred and forty.
      const evaluated = (
        await sql<{
          topics: number;
          bytes: number;
        }>`select jsonb_array_length(context -> 'evaluated' -> 'topics') as topics,
          octet_length(context::text) as bytes from geography.runs where id = ${run.runId}::uuid`.execute(db())
      ).rows[0]!;
      expect(evaluated.topics).toBeLessThanOrEqual(1 + 8);
      expect(evaluated.bytes).toBeLessThan(250_000);
    }, 120_000);

    it('reads one topic and nothing else for a reading of a topic whose places are all formed: the cost is what changed', async () => {
      const index = planets.findIndex((_, n) => !halfBuilt(n));
      const planet = planets[index]!;
      const unit = { topicId: planet.id, facetId: planet.facets[0]!.id, unit: `${planet.id}:again`, ageDays: 0 };
      everyKey.push({ ...unit, used: true });
      await sql`insert into personal_context.coverage_supports(universe_id,privacy_epoch,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256,reference_count,last_activated_at)
        values(${person.universeId}::uuid,1,${unit.topicId},${unit.facetId},repeat('0',64),${unit.unit},repeat('0',64),1,now())`.execute(
        db(),
      );
      const asked = await world.request(person.authority, { commandId: randomUUID() });
      if (asked.kind !== 'accepted') throw new Error('CI request refused');
      await sql`delete from personal_context.coverage_dirty_topics where universe_id = ${person.universeId}::uuid and topic_id <> ${planet.id}`.execute(
        db(),
      );
      const run = await cartograph(person, overrides);
      const frozen = (
        await sql<{ topics: string[]; neighbours: string[] | null; bytes: number; keys: number }>`select
          (select array_agg(t) from jsonb_array_elements_text(context -> 'evaluated' -> 'topics') t) as topics,
          (select array_agg(t) from jsonb_array_elements_text(context -> 'evaluated' -> 'neighbours') t) as neighbours,
          octet_length(context::text) as bytes, jsonb_array_length(context -> 'probes') as keys
          from geography.runs where id = ${run.runId}::uuid`.execute(db())
      ).rows[0]!;
      expect(frozen.topics).toEqual([planet.id]);
      expect(frozen.neighbours).toBeNull();
      expect(frozen.bytes).toBeLessThan(40_000);
      // eslint-disable-next-line no-console -- the numbers this slice reports (D-416)
      console.info(
        `incremental-formation steady state: one dirty topic of 240, ${String(frozen.keys)} keys probed, context ${String(frozen.bytes)} bytes`,
      );
    }, 120_000);

    it('goes quiet 31 days on, past a hundred supports: every place settles, none stays active for ever', async () => {
      const now = () => new Date(Date.now() + 31 * DAY);
      const sweep = makeSweepQuiet({
        enabled: () => true,
        now,
        store: quietSweepStore({ db: db(), enqueueInTransaction: makeEnqueueInTransaction(world.c.boss) }),
      });
      const settle = makeSettleQuiet({ ...world.base, ...overrides, now, enabled: () => true });
      const jobs = async () =>
        (
          await sql<{ id: string; data: Parameters<typeof settle>[0] }>`select id, data from pgboss.job
            where name = 'geography.settle-quiet' and data->>'universeId' = ${person.universeId} and state = 'created'
            order by created_on`.execute(db())
        ).rows;
      const active = async () =>
        (
          await sql<{ n: number }>`select count(*)::int as n from geography.objects
            where universe_id = ${person.universeId}::uuid and payload #>> '{activity,state}' = 'active'`.execute(db())
        ).rows[0]!.n;
      expect(await active()).toBeGreaterThan(100);
      let changed = 0;
      for (let pass = 0; pass < 40 && (await active()) > 0; pass++) {
        await sweep();
        for (const job of await jobs()) {
          changed += (await settle(job.data)).changed;
          await sql`update pgboss.job set state = 'completed' where id = ${job.id}::uuid`.execute(db());
        }
      }
      expect(await active()).toBe(0);
      expect(changed).toBeGreaterThan(100);
      // Nothing was removed: the places are the same ones, quiet.
      const formed = await storedPlaces(person);
      expect(total(formed)).toBeGreaterThan(700);
      expect(new Set(formed.map((row) => row.state))).toEqual(new Set(['quiet']));
    }, 600_000);
  });

  describe('the review of PR #723', () => {
    const runOutcome = async (runId: string) =>
      (
        await db()
          .selectFrom('geography.runs')
          .select(['status', 'outcome'])
          .where('id', '=', runId)
          .executeTakeFirstOrThrow()
      ).outcome;
    const dirtyRows = async (person: FixturePerson) =>
      (
        await sql<{
          topic_id: string;
          attempts: number;
          waits: boolean;
        }>`select topic_id, attempts, retry_after > now() as waits
          from personal_context.coverage_dirty_topics where universe_id = ${person.universeId}::uuid order by topic_id`.execute(
          db(),
        )
      ).rows;
    const authorityChanged = {
      version: 'trusted-coverage-read.v1',
      completeness: 'not_asserted',
      supportedFormats: ['scroll'],
      availability: 'unavailable',
      reason: 'authority_changed',
      supports: [],
      witnesses: [],
      certificates: [],
    } as never;

    it('keeps the topics of a refused claim dirty in backoff and queues the next run, which forms them once it may (3)', async () => {
      const person = await seedPerson(db());
      await world.coherent(person);
      const first = (await world.state(person)).activeRunId!;
      await cartograph(person, { readTrusted: () => Promise.resolve(authorityChanged) });
      expect(await runOutcome(first)).toBe('coverage_authority_changed');
      // The reading is not lost with the claim: the topic waits a minute, and a successor run is queued for it.
      expect(await dirtyRows(person)).toEqual([{ topic_id: topic, attempts: 1, waits: true }]);
      const successor = (await world.state(person)).activeRunId;
      expect(successor).toBeDefined();
      expect(successor).not.toBe(first);
      expect(await places(person)).toEqual([]);
      // The minute passes; the successor takes the topic and forms its places.
      await sql`update personal_context.coverage_dirty_topics set retry_after = now() where universe_id = ${person.universeId}::uuid`.execute(
        db(),
      );
      expect((await cartograph(person)).runId).toBe(successor);
      expect(await dirtyRows(person)).toEqual([]);
      expect(total(await storedPlaces(person))).toBe(5);
    });

    it('marks only the topics that hold a unit whose coverage changed, out of any backoff (4)', async () => {
      const person = await seedPerson(db());
      const readTopic = await world.fixture(undefined, topic, [facet]);
      const other = await world.fixture(undefined, 'earth.tides', ['earth.tides.forcing']);
      await world.observe(person, readTopic);
      await world.observe(person, other);
      await cartograph(person);
      expect(await dirtyRows(person)).toEqual([]);
      const units = { universeId: person.universeId, units: [readTopic.unit] };
      expect(await reconcileCoverageDirty(db(), { ...units, dryRun: true })).toEqual({ universes: 1, topics: 1 });
      expect(await dirtyRows(person)).toEqual([]);
      expect(await reconcileCoverageDirty(db(), { ...units, dryRun: false })).toEqual({ universes: 1, topics: 1 });
      expect(await dirtyRows(person)).toEqual([{ topic_id: topic, attempts: 0, waits: null }]);
      // A row waiting out a backoff is eligible again at once: its content is trusted now.
      await sql`update personal_context.coverage_dirty_topics set attempts = 5, retry_after = now() + interval '1 hour'
        where universe_id = ${person.universeId}::uuid`.execute(db());
      expect(await reconcileCoverageDirty(db(), { ...units, dryRun: false })).toEqual({ universes: 1, topics: 1 });
      expect(await dirtyRows(person)).toEqual([{ topic_id: topic, attempts: 0, waits: null }]);
    });

    it('records no_changes, not no_trusted_support, when the evaluated topics are untrusted but trusted support is read elsewhere (7)', async () => {
      const person = await seedPerson(db());
      const blackHoles = CONCEPTS.find((entry) => entry.id === 'space.black-holes')!;
      const elsewhere = await world.fixture(undefined, blackHoles.id, [blackHoles.facets[0]!.id]);
      await world.observe(person, elsewhere);
      await cartograph(person);
      expect(await dirtyRows(person)).toEqual([]);
      // New reading under Earth, whose Scrolls are then withdrawn: nothing trusted in the topic the run evaluates, but the reader's
      // Black holes reading is trusted. That is a withdrawn Scroll, not a fault of the reader's coverage.
      const withdrawn = await world.fixture(undefined, topic, [facet]);
      await world.observe(person, withdrawn);
      await db()
        .updateTable('content.assets')
        .set({ status: 'withdrawn' })
        .where('id', '=', withdrawn.assetId)
        .execute();
      const runId = (await world.state(person)).activeRunId!;
      await cartograph(person);
      expect(await runOutcome(runId)).toBe('no_changes');
    });
  });
});
