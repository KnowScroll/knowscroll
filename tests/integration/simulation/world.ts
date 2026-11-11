import { sql } from 'kysely';
import { makeEnqueueJob, jobConsumer, type JobConsumer } from '@knowscroll/backend/infrastructure/jobs';
import { fencePersonalRecording, makeWithPersonalScope } from '@knowscroll/backend/infrastructure/postgres';
import { personalRecordingReasoningHarnessFor } from '@knowscroll/backend/reasoning/nest-providers';
import { RECORDING_REASONING_HARNESS } from '@knowscroll/backend/reasoning';
import { FENCE_OWN_ACCOUNT, FENCE_PERSONAL_RECORDING } from '@knowscroll/backend/modules/identity';
import {
  accountAccessUseCases,
  identityScopeOwnerProviders,
} from '@knowscroll/backend/modules/identity/nest-providers';
import { READ_DISCOVERY_CANDIDATES, READ_EXACT_ENCOUNTER } from '@knowscroll/backend/modules/content';
import { contentProviders } from '@knowscroll/backend/modules/content/nest-providers';
import { PREPARE_COMPOSER_BUFFER, prepareBufferQueue, type PrepareBuffer } from '@knowscroll/backend/modules/composer';
import { composerBufferWorkerProviders, composerProviders } from '@knowscroll/backend/modules/composer/nest-providers';
import { experienceBufferSourceProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import {
  applyActionEvidenceQueue,
  projectEncounterActivityQueue,
  projectScrollReadingQueue,
  type ApplyActionEvidence,
} from '@knowscroll/backend/modules/evidence';
import {
  READ_COMPOSER_CONTEXT,
  READ_COVERAGE_INPUTS,
  READ_EXPLORATION_SNAPSHOT,
  READ_RECENT_CONTEXT_TOPICS,
  READ_TRUSTED_COVERAGE,
} from '@knowscroll/backend/modules/personal-context';
import { personalContextProviders } from '@knowscroll/backend/modules/personal-context/nest-providers';
import { cartographyQueue, publishDeltaQueue } from '@knowscroll/backend/modules/geography';
import { geographyProviders } from '@knowscroll/backend/modules/geography/nest-providers';
import { RUN_PLANNER, plannerQueue, type RunPlanner } from '@knowscroll/backend/modules/planner';
import { RECORD_PLANNED_DEMAND } from '@knowscroll/backend/modules/supply';
import {
  plannerRequestProviders,
  plannerWorkerProviders,
  plannerStore,
  makeCheckPlannerRecordingRun,
  type FrozenContext,
} from '@knowscroll/backend/modules/planner/nest-providers';
import { geographyStore, makeCheckGeographyRecordingRun } from '@knowscroll/backend/modules/geography/nest-providers';
import { PROJECT_SCENE, projectSceneQueue, type ProjectScene } from '@knowscroll/backend/modules/scenes';
import { sceneAppliedProviders, sceneProviders } from '@knowscroll/backend/modules/scenes/nest-providers';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { evidenceUseCase } from '../support/evidence.js';
import { fixtureModel, fixtureSettings, fixtureHarness, silent } from '../support/fixture-model.js';
import { geographyWorld, type GeographyWorld } from '../support/geography-world.js';
import { realSupply } from '../support/planned-demand.js';
import { buildRecursively } from '../support/providers.js';
import { recordingPerson } from '../support/recording-person.js';
import { fixtureRecordingHarness } from '../support/recording-harness.js';
import type { FixturePerson } from '../support/fixtures.js';
import type { SimConfig } from './config.js';
import { drain, type DrainOptions, type DrainReport } from './drain.js';
import { buildLibrary, type Library } from './library.js';
import { plannerProposalFor } from './planner-fixture.js';

/**
 * The lab's world: one disposable database holding the fixture library, the real use cases a person
 * touches (Experience, Evidence intake, Region encounters), and the real consumers a worker runs
 * (Evidence projections, the Composer's buffer, the Planner, the Cartographer, Scenes), composed from
 * the same provider lists the API and the worker compose. The only stand-ins are the labelled fixture
 * model behind the harness and the absence of a provider: no module under test is mocked.
 */
export interface SimWorld {
  readonly geo: GeographyWorld;
  readonly library: Library;
  readonly config: SimConfig;
  /** A new person, signed in through the real operator sign-in so they have an account, a universe and a recording policy. */
  newPerson(): Promise<FixturePerson>;
  /** Runs the worker's consumers until every queue is idle (see `drain`). */
  drain(options?: DrainOptions): Promise<DrainReport>;
  /** The tables that hold a person's evidence and places (one `universe_id` column each), for isolation fingerprints. */
  personalTables(): Promise<readonly { readonly schema: string; readonly table: string }[]>;
  /** Model calls the Planner and the Cartographer made (labelled fixture calls; none leave the process). */
  readonly modelCalls: () => { readonly planner: number; readonly cartographer: number };
  close(): Promise<void>;
}

const SCOPE = Symbol('sim.withPersonalScope');
const ENQUEUE = Symbol('sim.enqueueJob');
const WORKER_CONFIG = Symbol('sim.workerConfig');
const LOG = Symbol('sim.logEvent');

/** The Cartographer's fixture reply: a valid, empty proposal, so the rules alone decide what forms. */
const EMPTY_PROPOSAL: FixtureScenario = {
  kind: 'success',
  text: JSON.stringify({ version: 'cartographer-proposal.v1', operations: [] }),
};

export async function simulationWorld(name: string, config: SimConfig): Promise<SimWorld> {
  const geo = await geographyWorld(name, {
    buffers: true,
    region: true,
    composerPolicy: config.composerPolicy,
    workerMaterialChange: true,
  });
  const { database, c } = geo;
  const library = await buildLibrary(database.db, c.importScroll, config);
  const persons = new Map<string, FixturePerson>();
  const calls = { planner: 0, cartographer: 0 };
  const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
  const own = accountAccessUseCases({ db: database.db, lockTimeoutMs: 5_000 }).fenceOwnAccount;

  // --- the Planner, composed from the worker's providers -----------------------------------------
  let plannerUniverse: string | undefined;
  const plannerModel = fixtureModel(
    async () => {
      calls.planner += 1;
      const universeId = plannerUniverse;
      if (universeId === undefined) throw new Error('SIM_PLANNER_UNIVERSE_UNKNOWN');
      const run = await database.db
        .selectFrom('planner.state')
        .innerJoin('planner.runs', (join) =>
          join
            .onRef('planner.runs.id', '=', 'planner.state.active_run_id')
            .onRef('planner.runs.universe_id', '=', 'planner.state.universe_id'),
        )
        .select('planner.runs.context')
        .where('planner.state.universe_id', '=', universeId)
        .executeTakeFirstOrThrow();
      return { kind: 'success', text: JSON.stringify(plannerProposalFor(run.context as unknown as FrozenContext)) };
    },
    { label: 'simulation-planner-fixture' },
  );
  const plannerFixture = fixtureHarness(database.db, { model: plannerModel });
  const plannerHarness = personalRecordingReasoningHarnessFor({
    db: database.db,
    model: plannerFixture.ports.model,
    withPersonalScope: plannerFixture.ports.withPersonalScope,
    fenceOwn: own,
    settings: fixtureSettings,
    logEvent: silent,
    overrides: plannerFixture.ports,
    checkPlanner: makeCheckPlannerRecordingRun({ store: plannerStore, now: () => new Date() }),
    checkGeography: makeCheckGeographyRecordingRun({ store: geographyStore, now: () => new Date() }),
    checkSupply: () => Promise.resolve('unavailable' as const),
    checkScenarios: () => Promise.resolve('unavailable' as const),
    checkRooms: () => Promise.resolve('unavailable' as const),
    checkComposer: () => Promise.resolve('unavailable' as const),
  });
  const contentValues = contentProviders().map((provider) => [provider.provide, provider.useValue] as const);
  const plannerValues = new Map<symbol, unknown>([
    [SCOPE, withScope],
    [ENQUEUE, makeEnqueueJob(c.boss)],
    [FENCE_OWN_ACCOUNT, own],
    [FENCE_PERSONAL_RECORDING, fencePersonalRecording],
    [READ_EXPLORATION_SNAPSHOT, c.readExploration],
    [READ_RECENT_CONTEXT_TOPICS, c.readRecentTopics],
    [RECORDING_REASONING_HARNESS, plannerHarness],
    // Dev's Create caps (STATUS.md): the Planner may start 5 a day, people 10.
    [
      RECORD_PLANNED_DEMAND,
      realSupply(database, c.boss, { createDailyCap: 10, plannerCreateDailyCap: 5, readExploration: c.readExploration })
        .record,
    ],
    [WORKER_CONFIG, { plannerEnabled: true }],
    ...contentValues.filter(([token]) => token === READ_DISCOVERY_CANDIDATES || token === READ_EXACT_ENCOUNTER),
  ]);
  const plannerProviders = [
    ...plannerRequestProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE }),
    ...plannerWorkerProviders({ workerConfig: WORKER_CONFIG }),
  ];
  const runPlanner = buildRecursively(plannerProviders, RUN_PLANNER, plannerValues) as RunPlanner;

  // --- the buffer the Composer prepares on every activation --------------------------------------
  const { harness: bufferHarness } = fixtureRecordingHarness(database.db, { model: undefined });
  const bufferValues = new Map<symbol, unknown>([
    [SCOPE, withScope],
    [WORKER_CONFIG, { jevEnabled: false, reasoning: {} }],
    [RECORDING_REASONING_HARNESS, bufferHarness],
    [READ_COMPOSER_CONTEXT, c.readComposerContext],
    ...[
      ...experienceBufferSourceProviders(),
      ...composerProviders({ isOperator: () => false }, config.composerPolicy),
      ...contentProviders(),
    ].map((provider) => [provider.provide, provider.useValue] as const),
  ]);
  const prepareBuffer = buildRecursively(
    composerBufferWorkerProviders({ withPersonalScope: SCOPE, workerConfig: WORKER_CONFIG }),
    PREPARE_COMPOSER_BUFFER,
    bufferValues,
  ) as PrepareBuffer;

  // --- Scenes, projected after each applied Geography delta --------------------------------------
  const sceneProviderList = [
    ...sceneAppliedProviders({ enqueueJob: ENQUEUE }),
    ...geographyProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE }),
    ...sceneProviders({ withPersonalScope: SCOPE, logEvent: LOG }),
  ];
  const projectScene = buildRecursively(
    sceneProviderList,
    PROJECT_SCENE,
    new Map<symbol, unknown>([
      [SCOPE, withScope],
      [LOG, () => undefined],
      [ENQUEUE, makeEnqueueJob(c.boss)],
      [FENCE_OWN_ACCOUNT, own],
      [FENCE_PERSONAL_RECORDING, fencePersonalRecording],
      [READ_TRUSTED_COVERAGE, c.readTrustedCoverage],
      [READ_COVERAGE_INPUTS, buildRecursively(personalContextProviders(), READ_COVERAGE_INPUTS, new Map())],
      ...identityScopeOwnerProviders().map((provider) => [provider.provide, provider.useValue] as const),
    ]),
  ) as ProjectScene;

  const applyActionEvidence: ApplyActionEvidence = evidenceUseCase(database);
  const personOf = (universeId: string): FixturePerson => {
    const person = persons.get(universeId);
    if (!person) throw new Error('SIM_UNKNOWN_PERSON');
    return person;
  };

  /** The worker's registry for the queues a reader's activity reaches, in the order a worker would meet them. */
  const consumers: JobConsumer<unknown>[] = [
    jobConsumer(projectScrollReadingQueue, async (payload) => {
      await c.projectScrollReading(payload);
    }),
    jobConsumer(applyActionEvidenceQueue, async (payload) => {
      await applyActionEvidence(payload);
    }),
    jobConsumer(projectEncounterActivityQueue, async (payload) => {
      await c.projectActivity(payload);
    }),
    jobConsumer(prepareBufferQueue, async (payload, delivery) => {
      await prepareBuffer(payload, { jobId: delivery.jobId, signal: delivery.signal });
    }),
    jobConsumer(plannerQueue, async (payload, delivery) => {
      plannerUniverse = payload.universeId;
      await runPlanner(payload, delivery.signal);
    }),
    jobConsumer(cartographyQueue, async (payload, delivery) => {
      const runner = geo.runner(personOf(payload.universeId), () => {
        calls.cartographer += 1;
        return EMPTY_PROPOSAL;
      });
      await runner.run(payload, delivery.signal);
    }),
    jobConsumer(publishDeltaQueue, async (payload) => {
      await geo.publish(payload);
    }),
    jobConsumer(projectSceneQueue, async (payload) => {
      await projectScene(payload);
    }),
  ] as JobConsumer<unknown>[];

  let tables: { schema: string; table: string }[] | undefined;
  return {
    geo,
    library,
    config,
    async newPerson() {
      const person = await recordingPerson(database);
      persons.set(person.universeId, person);
      return person;
    },
    async personalTables() {
      tables ??= (
        await sql<{ schema: string; table: string }>`
          select c.table_schema schema, c.table_name "table"
          from information_schema.columns c
          join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
          where c.column_name = 'universe_id' and c.table_schema in ('evidence', 'personal_context', 'geography', 'scenes')
          order by 1, 2`.execute(database.db)
      ).rows;
      return tables;
    },
    drain: (options) => drain(c.boss, database.db, consumers, options),
    modelCalls: () => ({ ...calls }),
    close: () => geo.close(),
  };
}
