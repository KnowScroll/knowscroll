import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import {
  CONCEPT_CATALOGUE_VERSION,
  fixtureSnapshot,
  staticCatalogue,
  type CatalogueSnapshot,
} from '@knowscroll/backend/modules/content';
import {
  geographyStore,
  makeCheckGeographyRecordingRun,
  makeRunCartographer,
  pinCatalogue,
  type CartographerPorts,
  type Catalogue,
  type CatalogueTopic,
} from '@knowscroll/backend/modules/geography/nest-providers';
import { makeCheckPlannerRecordingRun, plannerStore } from '@knowscroll/backend/modules/planner/nest-providers';
import { personalRecordingReasoningHarnessFor } from '@knowscroll/backend/reasoning/nest-providers';
import { fixtureHarness, fixtureModel, fixtureSettings, signal, silent } from '../support/fixture-model.js';
import type { FixturePerson } from '../support/fixtures.js';
import type { GeographyWorld } from '../support/geography-world.js';
import { seedSupports, type SupportKey } from './seed.js';
import { SYSTEM_SIZE, topicId } from './config.js';

/**
 * Formation over a catalogue of any size. The product's catalogue is data in Postgres (#674, D-419; release 1 holds 17 topics), so a
 * catalogue of 10,000 topics is a labelled fixture: the Cartographer's `catalogue` port answers one fixture snapshot (`fixtureSnapshot`,
 * `staticCatalogue`), and the trusted read (Content's and Evidence's certificate checks, which are exercised by their own suites) vouches for each support
 * the seed wrote. Every other part of a run is the real code on the real database. The pattern is incremental-formation.test.ts's.
 */
export const FACETS_PER_PLANET = 2;
/** Every ninth planet has one unit (half built): it forms nothing until two more units arrive. */
export const halfBuilt = (index: number): boolean => index % 9 === 4;
const DAY = 86_400_000;

export interface FormationFixture {
  readonly catalogue: Catalogue;
  readonly planets: readonly CatalogueTopic[];
  readonly overrides: Partial<CartographerPorts>;
  /** Seeds the support rows of `planetCount` planets (the first ones) and remembers them for the trusted read. */
  seed(db: Parameters<typeof seedSupports>[0], universeId: string, planetCount: number): Promise<number>;
  /** One more reading of planet `index`: a support row of a new unit, vouched for by the trusted read. */
  addUnit(
    db: Parameters<typeof seedSupports>[0],
    universeId: string,
    index: number,
    label: string,
    facet?: number,
  ): Promise<void>;
}

const keyOf = (topic: string, facet: string, unit: string) => `${topic}\u0000${facet}\u0000${unit}`;

/** A fixture for the catalogue `entries` (systems and planets); `planetsOf(index)` names planet `index`'s entry. */
export function formationFixture(
  entries: readonly CatalogueTopic[],
  planets: readonly CatalogueTopic[],
  options: { readonly halfBuilt?: boolean; readonly snapshot?: CatalogueSnapshot } = {},
): FormationFixture {
  const half = (index: number) => options.halfBuilt !== false && halfBuilt(index);
  const snapshot =
    options.snapshot ??
    fixtureSnapshot(
      entries.map((entry) => ({ id: entry.id, parent: entry.parent, facets: entry.facets.map((f) => f.id) })),
    );
  const catalogue = pinCatalogue(snapshot);
  const known = new Map<string, { ageDays: number }>();
  const hash = (value: unknown) => canonicalSha256(value);
  const truthSha256 = hash({ kind: 'factual' });
  const uuidOf = (label: string, probe: unknown) => {
    const digest = hash({ label, probe });
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  };
  const trusted = ((
    _scope: unknown,
    query: { probes: readonly { topicId: string; facetId: string; explanationUnitId: string }[] },
  ) => {
    const rows = query.probes.flatMap((probe) => {
      const key = known.get(keyOf(probe.topicId, probe.facetId, probe.explanationUnitId));
      if (!key) return [];
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
      const witnessKey = hash(probe);
      const identity = {
        sourceKind: 'segment' as const,
        recordingGeneration: 1,
        activityId: uuidOf('activity', probe),
        qualificationId: uuidOf('qualification', probe),
        certificateSha256: hash({ witnessKey }),
      };
      const exposureId = uuidOf('exposure', probe);
      return [
        {
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
        },
      ];
    });
    return Promise.resolve(
      rows.length
        ? ({
            version: 'trusted-coverage-read.v1',
            completeness: 'not_asserted',
            supportedFormats: ['scroll', 'reel'],
            availability: 'available',
            reason: 'current',
            supports: rows.map((row) => row.support),
            witnesses: rows.map((row) => row.witness),
            certificates: rows.map((row) => row.certificate),
          } as const)
        : ({
            version: 'trusted-coverage-read.v1',
            completeness: 'not_asserted',
            supportedFormats: ['scroll', 'reel'],
            availability: 'unavailable',
            reason: 'not_observed',
            supports: [],
            witnesses: [],
            certificates: [],
          } as const),
    );
  }) as unknown as CartographerPorts['readTrusted'];
  const remember = (key: SupportKey) => known.set(keyOf(key.topicId, key.facetId, key.unit), { ageDays: key.ageDays });
  return {
    catalogue,
    planets,
    overrides: { catalogue: staticCatalogue(snapshot), readTrusted: trusted },
    async seed(db, universeId, planetCount) {
      const keys: SupportKey[] = [];
      for (let index = 0; index < planetCount; index++) {
        const planet = planets[index]!;
        for (let unit = 0; unit < (half(index) ? 1 : 3); unit++)
          for (const facet of planet.facets)
            keys.push({
              topicId: planet.id,
              facetId: facet.id,
              unit: `${planet.id}:u${String(unit)}`,
              ageDays: 2 + ((unit * 7 + index) % 11),
            });
      }
      keys.forEach(remember);
      await seedSupports(db, universeId, keys);
      return keys.length;
    },
    async addUnit(db, universeId, index, label, facet = 0) {
      const planet = planets[index]!;
      const key: SupportKey = {
        topicId: planet.id,
        facetId: planet.facets[facet % planet.facets.length]!.id,
        unit: `${planet.id}:${label}`,
        ageDays: 0,
      };
      remember(key);
      await sql`insert into personal_context.coverage_supports(universe_id, privacy_epoch, topic_id, facet_id, meaning_sha256,
          explanation_unit_id, truth_sha256, reference_count, last_activated_at)
        values(${universeId}::uuid, 1, ${key.topicId}, ${key.facetId}, repeat('0', 64), ${key.unit}, repeat('0', 64), 1, now())`.execute(
        db,
      );
    },
  };
}

/** The synthetic catalogue: systems `load.sNNN`, each with `SYSTEM_SIZE` planets of two facets. */
export function syntheticCatalogue(topics: number): { entries: CatalogueTopic[]; planets: CatalogueTopic[] } {
  const systems = Math.ceil(topics / SYSTEM_SIZE);
  const entries: CatalogueTopic[] = [];
  const planets: CatalogueTopic[] = [];
  for (let s = 0; s < systems; s++)
    entries.push({
      id: topicId(s * SYSTEM_SIZE).split('.t')[0]!,
      parent: null,
      meaning: `Load system ${String(s)}.`,
      facets: [],
    });
  for (let i = 0; i < topics; i++) {
    const planet: CatalogueTopic = {
      id: topicId(i),
      parent: topicId(i).split('.t')[0]!,
      meaning: `Load topic ${String(i)}.`,
      facets: Array.from({ length: FACETS_PER_PLANET }, (_, f) => ({
        id: `${topicId(i)}.f${String(f)}`,
        meaning: `Load facet ${String(f)}.`,
      })),
    };
    planets.push(planet);
    entries.push(planet);
  }
  return { entries, planets };
}

/**
 * A Cartographer runner as `world.runner` composes it (same harness, same owner checks, same ports), with the fixture model answering the
 * normal reply, an empty proposal, so the rules decide what forms and a run costs what the product's costs: the model's wait is a fixture.
 */
export function formationRunner(world: GeographyWorld, overrides: Partial<CartographerPorts>) {
  const model = fixtureModel(
    () => ({ kind: 'success', text: JSON.stringify({ version: 'cartographer-proposal.v1', operations: [] }) }),
    {
      label: 'load-cartographer-fixture',
    },
  );
  const fixture = fixtureHarness(world.database.db, { model, settings: fixtureSettings });
  const now = world.base.now;
  const harness = personalRecordingReasoningHarnessFor({
    db: world.database.db,
    model: fixture.ports.model,
    withPersonalScope: fixture.ports.withPersonalScope,
    fenceOwn: world.base.fenceOwn,
    settings: fixtureSettings,
    logEvent: silent,
    overrides: fixture.ports,
    checkPlanner: makeCheckPlannerRecordingRun({ store: plannerStore, now }),
    checkGeography: makeCheckGeographyRecordingRun({ store: geographyStore, now }),
    checkSupply: () => Promise.resolve('unavailable' as const),
    checkScenarios: () => Promise.resolve('unavailable' as const),
    checkRooms: () => Promise.resolve('unavailable' as const),
    checkComposer: () => Promise.resolve('unavailable' as const),
  });
  const ports: CartographerPorts = { ...world.base, harness, enabled: () => true, ...overrides };
  const run = makeRunCartographer(ports);
  return {
    model,
    /** Runs the person's active Cartographer run once; returns its id and recorded outcome. */
    async cartograph(person: FixturePerson) {
      const runId = (await world.state(person)).activeRunId;
      if (!runId) throw new Error('LOAD_EXPECTED_ACTIVE_RUN');
      await run(await world.job(person, runId), signal());
      return runId;
    },
  };
}

/** An explicit request wakes a run over every topic with support; a reading dirties only its topic, so the rest are cleared, as in the incremental test. */
export async function dirtyOnly(world: GeographyWorld, person: FixturePerson, planetId: string): Promise<void> {
  const asked = await world.request(person.authority, { commandId: randomUUID() });
  if (asked.kind !== 'accepted') throw new Error('LOAD_REQUEST_REFUSED');
  await sql`delete from personal_context.coverage_dirty_topics where universe_id = ${person.universeId}::uuid and topic_id <> ${planetId}`.execute(
    world.database.db,
  );
}
