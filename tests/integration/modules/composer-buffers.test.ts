import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { createBoss, drainConsumers, jobConsumer, startConsumers } from '@knowscroll/backend/infrastructure/jobs';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  PREPARE_COMPOSER_BUFFER,
  prepareBufferQueue,
  type ComposerDecision,
  type PrepareBuffer,
  type PrepareBufferJob,
} from '@knowscroll/backend/modules/composer';
import {
  composerBufferStore,
  composerBufferWorkerProviders,
  composerProviders,
  makeComposerStore,
} from '@knowscroll/backend/modules/composer/nest-providers';
import { contentProviders } from '@knowscroll/backend/modules/content/nest-providers';
import { experienceBufferSourceProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import { READ_COMPOSER_CONTEXT } from '@knowscroll/backend/modules/personal-context';
import { REASONING_HARNESS } from '@knowscroll/backend/reasoning';
import { guardedModelPort } from '@knowscroll/backend/reasoning/nest-providers';
import type { NavigationOutcome } from '@knowscroll/contracts';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModelPort, type FixtureModelPort, type FixtureScenario } from '../support/fixture-model-port.js';
import { fixtureHarness } from '../support/fixture-model.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { buildFromProviders } from '../support/providers.js';
import { scrollUseCases, starterSource, textCapabilities } from '../support/scroll.js';

type Cases = Awaited<ReturnType<typeof scrollUseCases>>;
type Ready = Extract<NavigationOutcome, { status: 'ready' }>;

const WITH_SCOPE = Symbol('test.withPersonalScope');
const WORKER_CONFIG = Symbol('test.workerConfig');

function ready(result: Awaited<ReturnType<Cases['navigate']>>): Ready {
  expect(result).toMatchObject({ kind: 'accepted', outcome: { status: 'ready' } });
  if (result.kind !== 'accepted' || result.outcome.status !== 'ready') throw new Error('CI fixture expected ready');
  return result.outcome;
}

describe('Worker-prepared Composer buffers and Jev (real PostgreSQL, labelled CI fixtures)', () => {
  let database: TestDatabase<Database>;
  let cases: Cases;
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });

  beforeAll(async () => {
    database = await createTestDatabase<Database>('composer_buffers');
    cases = await scrollUseCases(database, { buffers: true });
  });
  afterAll(async () => {
    await cases.close();
    await database.drop();
  });

  /** Admits one Scroll as its own explanation unit. */
  async function admit(title: string) {
    const source = starterSource() as { assetId: string; title?: string; publication: { explanationUnitId: string } };
    source.assetId = randomUUID();
    source.publication.explanationUnitId = `fixture-buffer-${randomUUID()}`;
    if (source.title !== undefined) source.title = title;
    const imported = await cases.importScroll(source);
    if (imported.kind !== 'imported') throw new Error('fixture admission refused');
    return { assetId: imported.assetId, assetRevision: imported.revision, unit: source.publication.explanationUnitId };
  }

  /** The worker side, built from the real providers over the real harness; only the model is a fixture. */
  function workerFor(jev?: { readonly model: FixtureModelPort }): { prepare: PrepareBuffer; calls: () => number } {
    const { harness } = fixtureHarness(database.db, { model: jev?.model });
    const values = new Map<symbol, unknown>([
      [WITH_SCOPE, withScope()],
      [WORKER_CONFIG, { jevEnabled: jev !== undefined, reasoning: { minimax: { model: 'fixture-model-v1' } } }],
      [REASONING_HARNESS, harness],
      [READ_COMPOSER_CONTEXT, cases.readComposerContext],
      ...[
        ...experienceBufferSourceProviders(),
        ...composerProviders({ isOperator: () => false }),
        ...contentProviders(),
      ].map((provider) => [provider.provide, provider.useValue] as const),
    ]);
    const providers = composerBufferWorkerProviders({ withPersonalScope: WITH_SCOPE, workerConfig: WORKER_CONFIG });
    return {
      prepare: buildFromProviders(providers, PREPARE_COMPOSER_BUFFER, values) as PrepareBuffer,
      calls: () => jev?.model.calls.length ?? 0,
    };
  }

  /** A fixture model that answers with `play(refs)`, given the candidate refs it was shown. */
  function jevModel(play: (refs: readonly string[]) => FixtureScenario): FixtureModelPort {
    return guardedModelPort(
      fixtureModelPort({
        label: 'composer-buffers',
        model: 'fixture-model-v1',
        script: (call) => play([...call.request.user.matchAll(/ref="(c\d+)"/g)].map((match) => match[1]!)),
      }),
    );
  }
  const scores =
    (byRef: (ref: string) => [number, number, number]) =>
    (refs: readonly string[]): FixtureScenario => ({
      kind: 'success',
      text: JSON.stringify({
        assessments: refs.map((ref) => {
          const [relevance, appropriateness, redundancy] = byRef(ref);
          return { ref, relevance, appropriateness, redundancy };
        }),
      }),
    });

  /** Opens Explore and activates the first offer, like the client does. */
  async function openAndActivate(person: FixturePerson) {
    const open = ready(
      await cases.navigate(person.authority, {
        commandId: randomUUID(),
        target: { kind: 'discover' },
        capabilities: textCapabilities,
      }),
    );
    return { open, ...(await activate(person, open)) };
  }
  async function activate(person: FixturePerson, outcome: Ready) {
    const activated = await cases.activateOffer(person.authority, {
      commandId: randomUUID(),
      target: {
        kind: 'offer',
        sessionId: outcome.sessionId,
        offerId: outcome.offer.offerId,
        expectedIntentRevision: outcome.intentRevision,
      },
    });
    if (activated.kind !== 'accepted') throw new Error('fixture activation refused');
    return {
      exposureId: activated.outcome.exposureId,
      from: { offerId: outcome.offer.offerId, exposureId: activated.outcome.exposureId },
    };
  }
  const nextSubject = (person: FixturePerson, outcome: Ready, from: { offerId: string; exposureId: string }) =>
    cases.navigate(person.authority, {
      commandId: randomUUID(),
      sessionId: outcome.sessionId,
      expectedIntentRevision: outcome.intentRevision,
      from,
      intent: { mode: 'vertical', direction: 'next' },
    });

  const jobsFor = async (universeId: string): Promise<PrepareBufferJob[]> =>
    (
      await sql<{
        data: PrepareBufferJob;
      }>`select data from pgboss.job where name=${prepareBufferQueue.name} and data->>'universeId'=${universeId} order by created_on`.execute(
        database.db,
      )
    ).rows.map((row) => row.data);
  const run = (worker: { prepare: PrepareBuffer }, job: PrepareBufferJob) =>
    worker.prepare(job, { jobId: randomUUID(), signal: new AbortController().signal });
  const bufferOf = async (universeId: string) =>
    (
      await sql<{
        decision_id: string;
        intent_revision: number;
        source_offer_id: string;
        selection: { assetId: string; assetRevision: number; catalogWatermark: string }[];
        assessments: { model: string; roleVersion: string; entries: { assetId: string }[] } | null;
      }>`select decision_id,intent_revision,source_offer_id,selection,assessments from composer.buffers where universe_id=${universeId}::uuid`.execute(
        database.db,
      )
    ).rows[0];
  const count = async (query: ReturnType<typeof sql>) =>
    Number(((await query.execute(database.db)).rows[0] as { n: string | number }).n);
  const decisionCount = (universeId: string) =>
    count(sql`select count(*) as n from composer.decisions where universe_id=${universeId}::uuid`);
  const decisionPayload = async (id: string) =>
    (
      await sql<{ payload: ComposerDecision }>`select payload from composer.decisions where id=${id}::uuid`.execute(
        database.db,
      )
    ).rows[0]?.payload;
  const expireBuffer = (universeId: string) =>
    sql`update composer.buffers set prepared_at=now()-interval '20 minutes', expires_at=now()-interval '10 minutes' where universe_id=${universeId}::uuid`.execute(
      database.db,
    );

  it('a next-subject move never offers the explanation being watched (open → activate → navigate)', async () => {
    const lone = await seedPerson(database.db);
    const first = await admit('Only explanation');
    const alone = await openAndActivate(lone);
    expect(alone.open.offer.explanationUnitId).toBe(first.unit);
    // With nothing else to offer, the honest answer is exhaustion, never the same explanation again.
    expect(await nextSubject(lone, alone.open, alone.from)).toMatchObject({
      kind: 'accepted',
      outcome: { status: 'exhausted', reason: 'no_eligible_content' },
    });

    await admit('Second explanation');
    await admit('Third explanation');
    const person = await seedPerson(database.db);
    const { open, from } = await openAndActivate(person);
    const next = ready(await nextSubject(person, open, from));
    const offered = [next.offer, ...next.bufferedOffers].map((offer) => offer.explanationUnitId);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).not.toContain(open.offer.explanationUnitId);
  });

  it('activation enqueues the preparation job in its own transaction, and a rolled-back activation leaves none', async () => {
    const failing = await scrollUseCases(database, {
      buffers: true,
      wrapEnqueue: (enqueue) => async (scope, queue, payload, options) => {
        await enqueue(scope, queue, payload, options);
        if (queue.name === prepareBufferQueue.name) throw new Error('fixture rollback after the job was written');
      },
    });
    try {
      await admit('Explanation A');
      await admit('Explanation B');
      const person = await seedPerson(database.db);
      const open = ready(
        await failing.navigate(person.authority, {
          commandId: randomUUID(),
          target: { kind: 'discover' },
          capabilities: textCapabilities,
        }),
      );
      await expect(
        failing.activateOffer(person.authority, {
          commandId: randomUUID(),
          target: {
            kind: 'offer',
            sessionId: open.sessionId,
            offerId: open.offer.offerId,
            expectedIntentRevision: open.intentRevision,
          },
        }),
      ).rejects.toThrow('fixture rollback');
      expect(await jobsFor(person.universeId)).toEqual([]);
      expect(
        await count(sql`select count(*) as n from experience.exposures where universe_id=${person.universeId}::uuid`),
      ).toBe(0);
    } finally {
      await failing.close();
    }

    const person = await seedPerson(database.db);
    const { open, from } = await openAndActivate(person);
    expect(await jobsFor(person.universeId)).toEqual([
      {
        v: 1,
        universeId: person.universeId,
        privacyEpoch: 1,
        sessionId: open.sessionId,
        intentRevision: open.intentRevision,
        sourceOfferId: from.offerId,
        sourceExposureId: from.exposureId,
      },
    ]);
  });

  it('the worker prepares a buffer that is only a ranking: no evidence, no encounter', async () => {
    const person = await seedPerson(database.db);
    const { open, from } = await openAndActivate(person);
    const [job] = await jobsFor(person.universeId);
    const exposures = () =>
      count(sql`select count(*) as n from experience.exposures where universe_id=${person.universeId}::uuid`);
    const lineage = () =>
      count(sql`select count(*) as n from experience.encounter_lineage where universe_id=${person.universeId}::uuid`);
    const before = { exposures: await exposures(), lineage: await lineage() };

    const result = await run(workerFor(), job!);
    expect(result).toMatchObject({ kind: 'prepared', jev: 'off' });
    const buffer = await bufferOf(person.universeId);
    expect(buffer).toMatchObject({ intent_revision: open.intentRevision, source_offer_id: from.offerId });
    expect(buffer!.selection.length).toBeGreaterThan(0);
    expect(buffer!.selection.length).toBeLessThanOrEqual(3);
    const decision = await decisionPayload(buffer!.decision_id);
    expect(decision?.selection.map((s) => s.assetId)).toEqual(buffer!.selection.map((s) => s.assetId));
    // The realised selection policy and its probability are logged with the ranking.
    expect(['ranked', 'explore']).toContain(decision?.exploration.branch);
    expect(decision?.exploration.selectedProbability).toBeGreaterThan(0);
    expect(decision?.input.semanticAssessments).toBeUndefined();
    expect({ exposures: await exposures(), lineage: await lineage() }).toEqual(before);
  });

  it('a real pg-boss delivery to the worker consumer fills the buffer after an activation', async () => {
    const person = await seedPerson(database.db);
    const { open, from } = await openAndActivate(person);
    const worker = workerFor();
    const consumer = createBoss(database.settings, 'consumer', {
      onError: () => undefined,
      onWarning: () => undefined,
    });
    await consumer.start();
    try {
      await startConsumers(
        consumer,
        [
          jobConsumer(prepareBufferQueue, async (job, delivery) => {
            await worker.prepare(job, { jobId: delivery.jobId, signal: delivery.signal });
          }),
        ],
        () => undefined,
      );
      const deadline = Date.now() + 15_000;
      let buffer = await bufferOf(person.universeId);
      while (!buffer && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        buffer = await bufferOf(person.universeId);
      }
      expect(buffer).toMatchObject({ intent_revision: open.intentRevision, source_offer_id: from.offerId });
    } finally {
      await drainConsumers(consumer, 1, 5_000, () => undefined);
    }
  });

  it('serves the next navigation from the buffer, once, without ranking again', async () => {
    const person = await seedPerson(database.db);
    const { open, from } = await openAndActivate(person);
    await run(workerFor(), (await jobsFor(person.universeId))[0]!);
    const buffer = (await bufferOf(person.universeId))!;
    const decisionsBefore = await decisionCount(person.universeId);

    const command = {
      commandId: randomUUID(),
      sessionId: open.sessionId,
      expectedIntentRevision: open.intentRevision,
      from,
      intent: { mode: 'vertical' as const, direction: 'next' as const },
    };
    const served = ready(await cases.navigate(person.authority, command));
    expect(served.decisionId).toBe(buffer.decision_id);
    expect([served.offer, ...served.bufferedOffers].map((offer) => offer.assetId)).toEqual(
      buffer.selection.map((s) => s.assetId),
    );
    expect(await decisionCount(person.universeId)).toBe(decisionsBefore);
    expect(await bufferOf(person.universeId)).toBeUndefined();
    expect(
      await count(
        sql`select count(*) as n from experience.offers where universe_id=${person.universeId}::uuid and decision_id=${buffer.decision_id}::uuid`,
      ),
    ).toBe(buffer.selection.length);
    // A retry replays the committed outcome; it does not need, or consume, another buffer.
    expect(await cases.navigate(person.authority, command)).toMatchObject({
      kind: 'accepted',
      outcome: { decisionId: buffer.decision_id, replayed: true },
    });
  });

  it('a duplicate or concurrent delivery of the job is harmless', async () => {
    const person = await seedPerson(database.db);
    await openAndActivate(person);
    const job = (await jobsFor(person.universeId))[0]!;
    const worker = workerFor();
    const results = await Promise.all([run(worker, job), run(worker, job)]);
    expect(results.filter((result) => result.kind === 'prepared').length).toBeGreaterThanOrEqual(1);
    expect(await run(worker, job)).toEqual({ kind: 'skipped', reason: 'already_prepared' });
    expect(
      await count(sql`select count(*) as n from composer.buffers where universe_id=${person.universeId}::uuid`),
    ).toBe(1);
    // The open navigation's decision and the buffer's: a duplicate delivery adds no second buffer decision.
    expect(await decisionCount(person.universeId)).toBe(2);
  });

  it('a job for a superseded intent, an unactivated offer or an old epoch changes nothing', async () => {
    const person = await seedPerson(database.db);
    const { open } = await openAndActivate(person);
    const job = (await jobsFor(person.universeId))[0]!;
    const worker = workerFor();
    expect(await run(worker, { ...job, intentRevision: open.intentRevision + 1 })).toEqual({
      kind: 'skipped',
      reason: 'session_superseded',
    });
    expect(await run(worker, { ...job, sourceExposureId: randomUUID() })).toEqual({
      kind: 'skipped',
      reason: 'source_unavailable',
    });
    await database.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', person.universeId)
      .execute();
    expect(await run(worker, job)).toEqual({ kind: 'skipped', reason: 'universe_unavailable' });
    expect(await bufferOf(person.universeId)).toBeUndefined();
  });

  describe('stale buffers are discarded, never served', () => {
    async function prepared() {
      const person = await seedPerson(database.db);
      const started = await openAndActivate(person);
      await run(workerFor(), (await jobsFor(person.universeId))[0]!);
      return { person, ...started, buffer: (await bufferOf(person.universeId))! };
    }

    it('an intent that moved on does not match the buffer', async () => {
      const { person, open, from, buffer } = await prepared();
      const target = { assetId: open.offer.assetId, assetRevision: open.offer.assetRevision };
      const revisit = ready(
        await cases.navigate(person.authority, {
          commandId: randomUUID(),
          sessionId: open.sessionId,
          expectedIntentRevision: open.intentRevision,
          from,
          intent: { mode: 'return', target },
        }),
      );
      const moved = await activate(person, revisit);
      const next = ready(await nextSubject(person, revisit, moved.from));
      expect(next.decisionId).not.toBe(buffer.decision_id);
      expect((await bufferOf(person.universeId))?.decision_id).toBe(buffer.decision_id);
    });

    it('a buffer of an earlier privacy epoch is never read', async () => {
      const { person, from, open, buffer } = await prepared();
      const key = { sessionId: open.sessionId, intentRevision: open.intentRevision, source: from };
      const read = (epoch: number) =>
        withScope()({ ...person.authority, privacyEpoch: epoch }, (scope) => composerBufferStore.read(scope, key));
      expect(await read(1)).toMatchObject({ kind: 'entered', value: { decisionId: buffer.decision_id } });
      await database.db
        .updateTable('identity.universes')
        .set({ privacy_epoch: 2 })
        .where('id', '=', person.universeId)
        .execute();
      expect(await read(2)).toMatchObject({ kind: 'entered', value: undefined });
      expect(await read(1)).toMatchObject({ kind: 'refused' });
    });

    it('a buffer past its life is not served', async () => {
      const { person, open, from, buffer } = await prepared();
      await expireBuffer(person.universeId);
      const next = ready(await nextSubject(person, open, from));
      expect(next.decisionId).not.toBe(buffer.decision_id);
    });

    it('a withdrawn asset makes the buffer drift: it is deleted with its decision and the rank is redone', async () => {
      const { person, open, from, buffer } = await prepared();
      const withdrawn = buffer.selection[0]!.assetId;
      await database.db
        .updateTable('content.assets')
        .set({ status: 'withdrawn' })
        .where('id', '=', withdrawn)
        .execute();
      const next = ready(await nextSubject(person, open, from));
      expect(next.decisionId).not.toBe(buffer.decision_id);
      expect([next.offer, ...next.bufferedOffers].map((o) => o.assetId)).not.toContain(withdrawn);
      expect(await bufferOf(person.universeId)).toBeUndefined();
      expect(await decisionPayload(buffer.decision_id)).toBeUndefined();
    });

    it('a Hide of a buffered asset is rechecked in the serving transaction', async () => {
      const { person, open, from, buffer } = await prepared();
      const hidden = buffer.selection[0]!;
      await cases.applyEncounterAction(person.authority, {
        commandId: randomUUID(),
        kind: 'hide',
        target: { assetId: hidden.assetId, assetRevision: hidden.assetRevision },
      });
      const next = ready(await nextSubject(person, open, from));
      expect(next.decisionId).not.toBe(buffer.decision_id);
      expect([next.offer, ...next.bufferedOffers].map((o) => o.assetId)).not.toContain(hidden.assetId);
      expect(await bufferOf(person.universeId)).toBeUndefined();
    });
  });

  it('a buffer replaced or removed between the two transactions falls back to a rerank, not an error', async () => {
    const person = await seedPerson(database.db);
    const { open, from } = await openAndActivate(person);
    await run(workerFor(), (await jobsFor(person.universeId))[0]!);
    const buffer = (await bufferOf(person.universeId))!;
    let scopeCalls = 0;
    const racing = await scrollUseCases(database, {
      buffers: true,
      wrapScope: (inner) => async (authority, work) => {
        scopeCalls += 1;
        // The second scope entry of a navigation is its committing transaction: the worker (or a
        // discard) has just replaced the buffer the first one chose.
        if (scopeCalls === 2) {
          await sql`delete from composer.buffers where universe_id=${person.universeId}::uuid`.execute(database.db);
          await sql`delete from composer.decisions where id=${buffer.decision_id}::uuid`.execute(database.db);
        }
        return inner(authority, work);
      },
    });
    try {
      const next = ready(
        await racing.navigate(person.authority, {
          commandId: randomUUID(),
          sessionId: open.sessionId,
          expectedIntentRevision: open.intentRevision,
          from,
          intent: { mode: 'vertical', direction: 'next' },
        }),
      );
      expect(scopeCalls).toBeGreaterThanOrEqual(4);
      expect(next.decisionId).not.toBe(buffer.decision_id);
      expect(next.offer.explanationUnitId).not.toBe(open.offer.explanationUnitId);
    } finally {
      await racing.close();
    }
  });

  it('a navigation deletes the buffer it finds past its life, unless its assessments are still valid', async () => {
    const person = await seedPerson(database.db);
    const { open, from } = await openAndActivate(person);
    await run(workerFor(), (await jobsFor(person.universeId))[0]!);
    const buffer = (await bufferOf(person.universeId))!;
    await expireBuffer(person.universeId);
    ready(await nextSubject(person, open, from));
    expect(await bufferOf(person.universeId)).toBeUndefined();
    expect(await decisionPayload(buffer.decision_id)).toBeUndefined();

    // With assessments still valid the row stays: the ranking reuses them and a later preparation too.
    const assessed = await seedPerson(database.db);
    const started = await openAndActivate(assessed);
    const jevWorker = workerFor({ model: jevModel(scores(() => [0.8, 0.8, 0.2])) });
    await run(jevWorker, (await jobsFor(assessed.universeId))[0]!);
    await expireBuffer(assessed.universeId);
    ready(await nextSubject(assessed, started.open, started.from));
    expect((await bufferOf(assessed.universeId))?.assessments).not.toBeNull();
  });

  it('pruning deletes an expired buffer before its decision and never trips over a live one', async () => {
    const person = await seedPerson(database.db);
    await openAndActivate(person);
    await run(workerFor(), (await jobsFor(person.universeId))[0]!);
    const buffer = (await bufferOf(person.universeId))!;
    const store = makeComposerStore({ isOperator: () => true });
    // The decision is logically expired (30 days) while the buffer is still live: it must be kept.
    await sql`update composer.decisions set recorded_at=now()-interval '40 days', expires_at=now()-interval '10 days' where id=${buffer.decision_id}::uuid`.execute(
      database.db,
    );
    expect(await withScope()(person.authority, (scope) => store.pruneComposerDecisions(scope, 100))).toMatchObject({
      kind: 'entered',
    });
    expect(await bufferOf(person.universeId)).toBeDefined();
    expect(await decisionPayload(buffer.decision_id)).toBeDefined();

    await expireBuffer(person.universeId);
    await withScope()(person.authority, (scope) => store.pruneComposerDecisions(scope, 100));
    expect(await bufferOf(person.universeId)).toBeUndefined();
    expect(await decisionPayload(buffer.decision_id)).toBeUndefined();
  });

  it('Clear and full erasure remove the buffer, its decision and the queued job', async () => {
    const person = await seedPerson(database.db);
    await openAndActivate(person);
    await run(workerFor(), (await jobsFor(person.universeId))[0]!);
    expect(await bufferOf(person.universeId)).toBeDefined();
    const entered = await withScope()(person.authority, (scope) => eraseUniverse(scope, personalStores));
    expect(entered.kind).toBe('entered');
    expect(await bufferOf(person.universeId)).toBeUndefined();
    expect(await decisionCount(person.universeId)).toBe(0);
    expect(await jobsFor(person.universeId)).toEqual([]);
  });

  describe('Jev', () => {
    async function threeCandidates() {
      await admit('Rivers and valleys');
      await admit('Tides and moons');
      await admit('Volcano islands');
    }

    it('stores atomic criteria with model and prompt versions and ranks with the combined SemanticFit', async () => {
      await threeCandidates();
      const person = await seedPerson(database.db);
      await openAndActivate(person);
      const model = jevModel(scores((ref) => (ref === 'c2' ? [1, 1, 0] : [0.1, 0.1, 0.9])));
      const worker = workerFor({ model });
      const jobId = randomUUID();
      const result = await worker.prepare((await jobsFor(person.universeId))[0]!, {
        jobId,
        signal: new AbortController().signal,
      });
      expect(result).toMatchObject({ kind: 'prepared', jev: 'assessed' });
      expect(worker.calls()).toBe(1);
      const buffer = (await bufferOf(person.universeId))!;
      expect(buffer.assessments).toMatchObject({ model: 'fixture-model-v1', roleVersion: 'jev.1/hp2' });
      const decision = (await decisionPayload(buffer.decision_id))!;
      const fits = decision.evaluations.map((e) => e.features.semanticFit);
      expect(fits.some((fit) => Math.abs(fit - 1) < 1e-9)).toBe(true);
      expect(fits.some((fit) => Math.abs(fit - 0.1) < 1e-9)).toBe(true);
      // The best-assessed candidate is the ranked winner; exploration may still pick another first.
      const best = decision.evaluations.filter((e) => e.eligible).reduce((a, b) => (b.score > a.score ? b : a));
      expect(decision.exploration.rankedWinner?.assetId).toBe(best.assetId);
      // The paid run is closed in the transaction that applied it, under the job's ID.
      const runRow = await sql<{
        state: string;
        purpose: string;
      }>`select state,purpose from reasoning.business_runs where id=${jobId}::uuid`.execute(database.db);
      expect(runRow.rows[0]).toMatchObject({ state: 'completed', purpose: 'jev-assessment' });
    });

    it('provider failure is the absence of an assessment: the buffer is still prepared, nothing is judged', async () => {
      await threeCandidates();
      const person = await seedPerson(database.db);
      await openAndActivate(person);
      const worker = workerFor({ model: jevModel(() => ({ kind: 'server_error' })) });
      expect(await run(worker, (await jobsFor(person.universeId))[0]!)).toMatchObject({
        kind: 'prepared',
        jev: 'absent',
        jevReason: 'provider_failed',
      });
      const buffer = (await bufferOf(person.universeId))!;
      expect(buffer.assessments).toBeNull();
      expect((await decisionPayload(buffer.decision_id))?.input.semanticAssessments).toBeUndefined();
    });

    it('unusable output is absence too, and unknown or repeated refs are dropped, not guessed', async () => {
      await threeCandidates();
      const garbled = await seedPerson(database.db);
      await openAndActivate(garbled);
      expect(
        await run(
          workerFor({ model: jevModel(() => ({ kind: 'malformed' })) }),
          (await jobsFor(garbled.universeId))[0]!,
        ),
      ).toMatchObject({ kind: 'prepared', jev: 'absent', jevReason: 'invalid_output' });

      const partial = await seedPerson(database.db);
      await openAndActivate(partial);
      const entry = { relevance: 0.9, appropriateness: 0.9, redundancy: 0 };
      const model = jevModel((refs) => ({
        kind: 'success',
        text: JSON.stringify({
          assessments: [
            { ref: refs[0], ...entry },
            { ref: refs[0], ...entry, relevance: 0 },
            { ref: 'c99', ...entry },
          ],
        }),
      }));
      expect(await run(workerFor({ model }), (await jobsFor(partial.universeId))[0]!)).toMatchObject({
        kind: 'prepared',
        jev: 'assessed',
      });
      expect((await bufferOf(partial.universeId))!.assessments!.entries).toHaveLength(1);
    });

    it('does not call the model when Jev is off, and reuses valid assessments instead of paying again', async () => {
      await threeCandidates();
      const person = await seedPerson(database.db);
      const { open, from } = await openAndActivate(person);
      const job = (await jobsFor(person.universeId))[0]!;
      const worker = workerFor({ model: jevModel(scores(() => [0.8, 0.8, 0.2])) });
      await run(worker, job);
      expect(worker.calls()).toBe(1);
      const first = (await bufferOf(person.universeId))!;

      // The buffer expires but its assessments are still valid: a new preparation reuses them.
      await expireBuffer(person.universeId);
      expect(await run(worker, job)).toMatchObject({ kind: 'prepared', jev: 'reused' });
      expect(worker.calls()).toBe(1);
      expect((await bufferOf(person.universeId))!.assessments).toEqual(first.assessments);

      // And so does the HTTP path once the buffer is no longer servable: stored, never awaited.
      await expireBuffer(person.universeId);
      const expired = (await bufferOf(person.universeId))!;
      const next = ready(await nextSubject(person, open, from));
      expect(next.decisionId).not.toBe(expired.decision_id);
      expect((await decisionPayload(next.decisionId))?.input.semanticAssessments?.model).toBe('fixture-model-v1');

      const off = workerFor();
      const another = await seedPerson(database.db);
      await openAndActivate(another);
      expect(await run(off, (await jobsFor(another.universeId))[0]!)).toMatchObject({ kind: 'prepared', jev: 'off' });
      expect(off.calls()).toBe(0);
    });
  });
});
