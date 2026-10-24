import { sceneAppliedProviders } from '@knowscroll/backend/modules/scenes/nest-providers';
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import {
  makeWithPersonalScope,
  fencePersonalRecording,
  insideTransaction,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { FENCE_OWN_ACCOUNT, FENCE_PERSONAL_RECORDING } from '@knowscroll/backend/modules/identity';
import {
  accountAccessUseCases,
  identityScopeOwnerProviders,
} from '@knowscroll/backend/modules/identity/nest-providers';
import {
  makeAdmitCoverage,
  makeCoverageAdmissionPorts,
  coverageCatalogue,
} from '@knowscroll/backend/modules/content/nest-providers';
import {
  COVERAGE_POLICY,
  CONCEPT_CATALOGUE_VERSION,
  type CoverageMapping,
  type CoverageCommand,
} from '@knowscroll/backend/modules/content';
import {
  READ_COVERAGE_INPUTS,
  READ_EXPLORATION_SNAPSHOT,
  READ_TRUSTED_COVERAGE,
} from '@knowscroll/backend/modules/personal-context';
import { personalContextProviders } from '@knowscroll/backend/modules/personal-context/nest-providers';
import {
  GEOGRAPHY_MATERIAL_CHANGE,
  GEOGRAPHY_APPLIED,
  REQUEST_CARTOGRAPHY,
  READ_OWN_GEOGRAPHY,
  READ_OWN_DELTAS,
  READ_OWN_EMERGING,
  PUBLISH_GEOGRAPHY_DELTA,
  type MaterialGeographyChange,
  type RequestCartography,
  type ReadOwnGeography,
  type ReadOwnDeltas,
  type ReadOwnEmerging,
  type PublishGeographyDelta,
} from '@knowscroll/backend/modules/geography';
import {
  geographyProviders,
  GEOGRAPHY_PORTS,
  geographyStore,
  makeRunCartographer,
  applyProposal,
  makeCheckGeographyRecordingRun,
  type GeographyPorts,
  type CartographerPorts,
  type GeographyContext,
} from '@knowscroll/backend/modules/geography/nest-providers';
import { plannerStore, makeCheckPlannerRecordingRun } from '@knowscroll/backend/modules/planner/nest-providers';
import { personalRecordingReasoningHarnessFor } from '@knowscroll/backend/reasoning/nest-providers';
import type { PersonalRecordingPurpose } from '@knowscroll/backend/reasoning';
import type { HarnessSettings } from '@knowscroll/backend/reasoning/nest-providers';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { fixtureHarness, fixtureModel, fixtureSettings, silent, signal } from '../support/fixture-model.js';
import { createTestDatabase } from '../support/database.js';
import { type FixturePerson } from '../support/fixtures.js';
import { scrollUseCases, starterSource } from '../support/scroll.js';
import { buildFromProviders } from '../support/providers.js';
import { activatedAgo, coverage, dwell, event, openActive } from '../support/observations.js';

/** Authored CI sources, maps and model proposals only. No source approval, provider or real formation claim. */
export const topic = 'earth.seasons',
  facet = 'earth.seasons.axial-tilt',
  otherFacet = 'earth.seasons.hemispheres';

/**
 * A disposable database with the real Geography, Scenes, Evidence and Personal Context wiring, plus
 * helpers that read authored Scrolls as a person and run the Cartographer against a fixture model.
 */
export async function geographyWorld(name: string) {
  const database = await createTestDatabase<Database>(name);
  // The Scroll use cases need the material-change hook that the providers below build.
  const hooks: { material?: MaterialGeographyChange } = {};
  const c = await scrollUseCases(database, {
    recording: true,
    activityMaterialChange: (s, x) => hooks.material!(s, x),
  });
  const approvals = new Map<string, string>();
  const scope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
  const SCOPE = Symbol('scope'),
    ENQUEUE = Symbol('enqueue'),
    providers = [
      ...sceneAppliedProviders({ enqueueJob: ENQUEUE }),
      ...geographyProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE }),
    ];
  const values = new Map<symbol, unknown>([
    [SCOPE, scope()],
    [FENCE_OWN_ACCOUNT, accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount],
    [FENCE_PERSONAL_RECORDING, fencePersonalRecording],
    [ENQUEUE, makeEnqueueJob(c.boss)],
    [READ_TRUSTED_COVERAGE, c.readTrustedCoverage],
    [READ_COVERAGE_INPUTS, buildFromProviders(personalContextProviders(), READ_COVERAGE_INPUTS, new Map())],
    [READ_EXPLORATION_SNAPSHOT, c.readExploration],
    ...identityScopeOwnerProviders().map((p) => [p.provide, p.useValue] as const),
  ]);
  values.set(GEOGRAPHY_APPLIED, buildFromProviders(providers, GEOGRAPHY_APPLIED, values));
  const get = <T>(token: symbol): T => {
    const value = buildFromProviders(providers, token, values);
    values.set(token, value);
    return value as T;
  };
  const base = get<GeographyPorts>(GEOGRAPHY_PORTS);
  hooks.material = get<MaterialGeographyChange>(GEOGRAPHY_MATERIAL_CHANGE);
  const request = get<RequestCartography>(REQUEST_CARTOGRAPHY),
    read = get<ReadOwnGeography>(READ_OWN_GEOGRAPHY),
    deltas = get<ReadOwnDeltas>(READ_OWN_DELTAS),
    emerging = get<ReadOwnEmerging>(READ_OWN_EMERGING),
    publish = get<PublishGeographyDelta>(PUBLISH_GEOGRAPHY_DELTA);
  async function fixture(unit = `ci-geography-unit-${randomUUID()}`, t = topic, facets = [facet]) {
    const source = starterSource() as {
      assetId: string;
      reference: string;
      publication: { explanationUnitId: string };
      draft: { title: string };
    };
    source.assetId = randomUUID();
    source.reference = 'ci-only-synthetic-geography-map';
    source.publication.explanationUnitId = unit;
    source.draft.title = 'Authored CI Geography source';
    const imported = await c.importScroll(source);
    if (imported.kind !== 'imported') throw new Error('CI fixture import refused');
    await database.db
      .insertInto('content.encounter_topics')
      .values({ asset_id: source.assetId, asset_revision: 1, topic_id: t, role: 'primary', weight: 1 })
      .execute();
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
    const map: CoverageMapping = {
      version: COVERAGE_POLICY,
      documentSha256: row.document_sha256,
      provenanceSha256: canonicalSha256(provenance.provenance),
      explanationUnitId: unit,
      framing: 'factual',
      framingSha256: canonicalSha256({ kind: 'factual' }),
      readingFactsVersion: 2,
      readingFactsSha256: canonicalSha256(row.reading_facts),
      catalogueVersion: CONCEPT_CATALOGUE_VERSION,
      catalogueSha256: coverageCatalogue.sha256,
      bindings: facets.map((f) => ({
        topicId: t,
        facetId: f,
        meaningSha256: coverageCatalogue.meaningSha256(t, f)!,
        requiredBlockIds: f === facets[0] ? ['intro-look-up'] : ['intro-look-up', 'intro-short-version'],
      })),
    };
    const command: CoverageCommand = {
      version: 'content-coverage-command.v1',
      assetId: source.assetId,
      assetRevision: 1,
      expectedHeadRevision: 0,
      semanticReviewReference: 'ci-geography-semantic-fixture-only',
      change: { kind: 'admit', mapping: map },
    };
    approvals.set(canonicalSha256(command), command.semanticReviewReference);
    await makeAdmitCoverage(makeCoverageAdmissionPorts(database.db, (digest, ref) => approvals.get(digest) === ref))(
      command,
    );
    return {
      assetId: source.assetId,
      revision: 1,
      unit,
      map,
      command,
      blocks: (row.reading_facts as { blocks: { id: string }[] }).blocks.map((b) => b.id),
    };
  }
  async function observe(
    p: FixturePerson,
    f: Pick<Awaited<ReturnType<typeof fixture>>, 'assetId' | 'revision' | 'blocks'>,
    omit: string[] = [],
    minutesAgo = 20,
  ) {
    const e = await openActive(c, p, f);
    await activatedAgo(database.db, e.exposureId, minutesAgo);
    await c.ingestObservations(p.authority, {
      instrumentationVersion: 1,
      events: [
        event(
          e,
          coverage(
            f.blocks.filter((id) => !omit.includes(id)),
            1000,
          ),
        ),
        event(e, dwell([0, 700000])),
      ],
    });
    expect(
      await c.projectScrollReading({ v: 1, universeId: p.universeId, privacyEpoch: 1, exposureId: e.exposureId }),
    ).toMatchObject({ kind: 'applied', qualification: 'qualified' });
    expect(
      await c.projectActivity({ v: 1, universeId: p.universeId, privacyEpoch: 1, exposureId: e.exposureId }),
    ).toMatchObject({ kind: 'applied' });
    return e;
  }
  async function coherent(p: FixturePerson) {
    const assets = [];
    for (let i = 0; i < 3; i++) {
      const f = await fixture(undefined, topic, [i === 1 ? otherFacet : facet]);
      assets.push(f);
      await observe(p, f);
    }
    return assets;
  }
  async function state(p: FixturePerson) {
    const result = await scope()(p.authority, (s) => geographyStore.state(s));
    if (result.kind !== 'entered') throw new Error('CI scope refused');
    return result.value;
  }
  async function context(p: FixturePerson, runId: string) {
    return (
      await database.db
        .selectFrom('geography.runs')
        .select('context')
        .where('universe_id', '=', p.universeId)
        .where('id', '=', runId)
        .executeTakeFirstOrThrow()
    ).context as unknown as GeographyContext;
  }
  const job = async (p: FixturePerson, runId: string) => {
    const h = await database.db
      .selectFrom('geography.runs')
      .select(['normal_wake_id', 'claim_wake_claim_id', 'recording_generation'])
      .where('universe_id', '=', p.universeId)
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    if (!h.recording_generation || (!h.normal_wake_id && !h.claim_wake_claim_id))
      throw new Error('CI exact durable wake absent');
    return {
      v: 2 as const,
      universeId: p.universeId,
      privacyEpoch: 1,
      runId,
      recordingGeneration: h.recording_generation,
      ...(h.normal_wake_id ? { wakeId: h.normal_wake_id } : { expectedClaimId: h.claim_wake_claim_id! }),
    };
  };
  const formation = (ctx: GeographyContext, t = topic) => ({
    version: 'cartographer-proposal.v1' as const,
    operations: ctx.facts.candidates
      .filter(
        (x) =>
          // Only the system that holds the planet is formed; the catalogue now has several systems.
          ((x.kind === 'system' || x.kind === 'star') && x.conceptId === t.split('.')[0]) ||
          (x.kind === 'planet' && x.conceptId === t) ||
          (x.kind === 'region' && ctx.facts.supports.some((s) => s.topicId === t && s.facetId === x.conceptId)),
      )
      .filter((x) => !ctx.facts.objects.some((o) => o.key === x.key))
      .map((x) => ({
        kind: (
          { system: 'create_system', star: 'establish_star', planet: 'form_planet', region: 'add_region' } as const
        )[x.kind],
        key: x.key,
        label: x.labels[0]!,
        truthStatus: 'factual' as const,
        supportRefs: ctx.facts.supports
          .filter(
            (s) =>
              x.kind === 'system' ||
              x.kind === 'star' ||
              (x.kind === 'planet' ? s.topicId === x.conceptId : s.facetId === x.conceptId),
          )
          .map((s) => s.ref),
      })),
  });
  function runner(
    p: FixturePerson,
    script?: (ctx: GeographyContext, sequence: number) => FixtureScenario | Promise<FixtureScenario>,
    overrides: Partial<CartographerPorts> = {},
    settings: HarnessSettings = fixtureSettings,
  ) {
    const model = fixtureModel(
      async (sequence) => {
        expect(insideTransaction()).toBe(false);
        const active = (await state(p)).activeRunId!;
        const ctx = await context(p, active);
        return script ? script(ctx, sequence) : { kind: 'success', text: JSON.stringify(formation(ctx)) };
      },
      { label: 'geography-authored-ci-only' },
    );
    const fixture = fixtureHarness(database.db, { model, settings }),
      now = overrides.now ?? base.now;
    const harness = personalRecordingReasoningHarnessFor({
      db: database.db,
      model: fixture.ports.model,
      withPersonalScope: fixture.ports.withPersonalScope,
      fenceOwn: base.fenceOwn,
      settings,
      logEvent: silent,
      overrides: fixture.ports,
      checkPlanner: makeCheckPlannerRecordingRun({ store: plannerStore, now }),
      checkGeography: makeCheckGeographyRecordingRun({ store: geographyStore, now }),
    });
    const ports: CartographerPorts = {
      ...base,
      harness,
      enabled: () => true,
      ...overrides,
    };
    return { model, ports, run: makeRunCartographer(ports) };
  }
  async function snapshot(
    p: FixturePerson,
    query: Parameters<ReadOwnGeography>[1] = { selection: { kind: 'universe' }, limit: 100 },
  ) {
    const r = await read(p.authority, query);
    if (r.kind !== 'read') throw new Error('CI geography read refused');
    return r.snapshot;
  }
  async function scopeApply(
    p: FixturePerson,
    runId: string,
    ctx: GeographyContext,
    proposal: ReturnType<typeof formation>,
    ports = base,
  ) {
    return scope()(p.authority, async (s) => {
      if ((await ports.fenceOwn(s)).kind !== 'active') throw new Error('CI own');
      const gate = await ports.fenceRecording(s, 1);
      if (gate.kind !== 'recording') throw new Error('CI recording');
      return applyProposal(ports, gate.scope, runId, ctx, proposal, () =>
        Promise.reject(new Error('CI immutable replay must never close ledger')),
      );
    });
  }
  async function manualApply(
    p: FixturePerson,
    work: (
      cap: Parameters<typeof applyProposal>[1],
      ctx: GeographyContext,
      runId: string,
      close: () => Promise<void>,
    ) => ReturnType<typeof applyProposal>,
  ) {
    const r = runner(p),
      state0 = await state(p),
      runId = state0.activeRunId!;
    let entered!: () => void, release!: () => void, purpose!: PersonalRecordingPurpose;
    const ready = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    const running = makeRunCartographer({
      ...r.ports,
      harness: {
        ...r.ports.harness,
        withPersonalApply: () => Promise.reject(new Error('CI manual facade takeover')),
        proposePersonal: async (input, abort) => {
          const result = await r.ports.harness.proposePersonal(input, abort);
          purpose = input.recordingPurpose;
          entered();
          await held;
          return result;
        },
      },
    })(await job(p, runId), signal());
    await Promise.race([
      ready,
      running.then(() => {
        throw new Error('CI actual proposal did not prepare');
      }),
    ]);
    try {
      const ctx = await context(p, runId);
      return await r.ports.harness.withPersonalApply(p.authority, purpose, (cap) =>
        work(cap, ctx, runId, async () => {
          expect(
            await r.ports.harness.closePersonalRun(cap, { runId, state: 'completed', recordingPurpose: purpose }),
          ).toBe('closed');
        }),
      );
    } finally {
      release();
      await running.catch((error) => {
        if (!(error instanceof Error) || error.message !== 'CI manual facade takeover') throw error;
      });
    }
  }
  return {
    database,
    c,
    base,
    request,
    read,
    deltas,
    emerging,
    publish,
    scope,
    fixture,
    observe,
    coherent,
    state,
    context,
    job,
    formation,
    runner,
    snapshot,
    scopeApply,
    manualApply,
    close: async () => {
      await c.close();
      await database.drop();
    },
  };
}
export type GeographyWorld = Awaited<ReturnType<typeof geographyWorld>>;
