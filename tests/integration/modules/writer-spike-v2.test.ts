import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@knowscroll/backend/infrastructure/ids';
import { makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  guardedModelPort,
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
  reasoningOperatorFor,
  type HarnessSettings,
} from '@knowscroll/backend/reasoning/nest-providers';
import type { AuthoredScrollV2 } from '@knowscroll/scroll-model/producer';
import {
  fixtureAuthoredV2,
  fixtureResearchPageV2,
} from '../../../packages/backend/src/modules/content/production/spike-v2/writer-v2.fixture.js';
import {
  makeWriterSpikeV2,
  runSpikeBatch,
  SPIKE_MODEL,
  type SpikeResult,
} from '../../../packages/backend/src/modules/content/production/spike-v2/run.js';
import type { ScrollTopic } from '../../../packages/backend/src/modules/content/production/topics.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel, fixtureSettings, signal, silent } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';

// The model is a labelled CI fixture and the Scroll is the authored Orrin fixture: no provider, no product content.
const answer = (
  value: unknown,
  usage?: { inputTokens: number; outputTokens: number; reasoningTokens: number },
): FixtureScenario => ({
  kind: 'success',
  text: JSON.stringify(value),
  ...(usage === undefined ? {} : { usage }),
});

/** The fixture answer with a stop copied word for word from the research, which the copy check refuses. */
function copying(): AuthoredScrollV2 {
  const draft = JSON.parse(JSON.stringify(fixtureAuthoredV2())) as { items: Record<string, unknown>[] };
  draft.items[2] = {
    ...draft.items[2],
    text: 'Near the equator the noon sun stays high in every season, so the tropics change far less across the year than the poles do.',
  };
  return draft as unknown as AuthoredScrollV2;
}

describe('the writer spike (CI fixture model + real PostgreSQL; no provider network)', () => {
  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('writer_spike_v2');
    await sql`update reasoning.production_scopes set enabled=true where id='scroll-supply'`.execute(database.db);
  });
  afterEach(async () => {
    await database.drop();
  });

  function setup(script: (sequence: number) => FixtureScenario, settings: HarnessSettings = fixtureSettings) {
    const fixture = fixtureModel(script, { label: 'writer-spike-v2-CI-fixture' });
    const model = guardedModelPort({ ...fixture, provider: 'minimax', model: SPIKE_MODEL });
    const withScope = makeWithProductionScope(database.db, { enabled: true, lockTimeoutMs: 5000 });
    const harness = makeProductionReasoningHarness(
      postgresProductionHarnessPorts({
        db: database.db,
        withProductionScope: withScope,
        enabled: true,
        model,
        logEvent: silent,
        settings,
      }),
    );
    const reasoning = reasoningOperatorFor(database.db, silent);
    const spike = makeWriterSpikeV2({
      harness,
      withScope,
      authority: { scopeId: 'scroll-supply', generation: 1 },
      model: model.model,
      spikeId: 'ci-spike',
      research: () => Promise.resolve(fixtureResearchPageV2),
      newRunId: uuidv7,
      findingsOf: async (attemptId) => {
        const shown = await reasoning.showRejectedAnswer(attemptId);
        return shown.kind === 'found' ? shown.record.issues.map(({ code, path }) => ({ code, path })) : [];
      },
    });
    return { fixture, spike };
  }

  const attempts = () =>
    database.db
      .selectFrom('reasoning.production_attempts')
      .select(['step', 'state', 'model', 'run_id'])
      .orderBy('reserved_at')
      .execute();
  const runs = () =>
    database.db.selectFrom('reasoning.production_runs').select(['id', 'purpose', 'state', 'policy_version']).execute();
  const contentRows = async () =>
    (
      await sql<{ jobs: string; revisions: string }>`
        select (select count(*) from content.scroll_production_runs) as jobs,
               (select count(*) from content.asset_revisions) as revisions`.execute(database.db)
    ).rows[0];

  it('accounts one first-take Scroll from the real ledger: one paid request, the reported tokens, the model, a closed run', async () => {
    const before = await contentRows();
    const p = setup(() =>
      answer(fixtureAuthoredV2(), { inputTokens: 4321, outputTokens: 8765, reasoningTokens: 5432 }),
    );
    const { line, document } = await p.spike.writeOne('seasons', signal());

    expect(line).toMatchObject({
      key: 'seasons',
      outcome: 'accepted_first_take',
      requests: 1,
      findings: [],
      models: [SPIKE_MODEL],
      tokens: { input: 4321, output: 8765, thinking: 5432, complete: true },
      stops: 9,
      calls: 3,
      promptVersion: 'scroll-writer.v19',
    });
    expect(line.attempts).toHaveLength(1);
    expect(document?.document.schemaVersion).toBe('scroll-document.v2');
    expect(p.fixture.calls).toHaveLength(1);
    // The request carried the v15 instructions and the brief, as data.
    const request = p.fixture.calls[0]?.request;
    expect(request?.system).toContain('wrong option that states this idea SECOND');
    expect(request?.system).toContain('A call never changes the picture');
    expect(request?.user).toContain('[e1]');
    expect(await attempts()).toEqual([{ step: 'primary', state: 'succeeded', model: SPIKE_MODEL, run_id: line.runId }]);
    expect(await runs()).toEqual([
      { id: line.runId, purpose: 'scroll-writer-spike', state: 'completed', policy_version: 'scroll-spike.v2' },
    ]);
    // Nothing was admitted, published or stored in a content table.
    expect(await contentRows()).toEqual(before);
  });

  it('sends the one repair with fixed findings and the copied words, and reports both paid requests and what was refused', async () => {
    const p = setup((sequence) =>
      sequence === 1
        ? answer(copying(), { inputTokens: 4000, outputTokens: 8000, reasoningTokens: 5000 })
        : answer(fixtureAuthoredV2(), { inputTokens: 5200, outputTokens: 7000, reasoningTokens: 3000 }),
    );
    const { line } = await p.spike.writeOne('seasons', signal());

    expect(line).toMatchObject({
      outcome: 'accepted_after_repair',
      requests: 2,
      tokens: { input: 9200, output: 15_000, thinking: 8000, complete: true },
    });
    expect(line.findings).toEqual([expect.objectContaining({ attempt: 1, code: 'copied_passage', path: 'items[2]' })]);
    const repair = p.fixture.calls[1]?.request;
    expect(repair?.system).toContain('items[2]: copied_passage');
    expect(repair?.user).toContain('<previous-answer>');
    expect(repair?.user).toContain('<repair-notes>');
    expect(repair?.user).toContain('items[2] copies: "near the equator the noon sun stays high');
    expect((await attempts()).map((attempt) => [attempt.step, attempt.state])).toEqual([
      ['primary', 'succeeded'],
      ['repair', 'succeeded'],
    ]);
  });

  it('rejects a Scroll refused twice, keeps both findings, sends nothing more and cancels the run', async () => {
    const p = setup(() => answer(copying()));
    const { line, document } = await p.spike.writeOne('seasons', signal());
    expect(line).toMatchObject({ outcome: 'rejected', requests: 2 });
    expect(line.findings.map((finding) => [finding.attempt, finding.code, finding.path])).toEqual([
      [1, 'copied_passage', 'items[2]'],
      [2, 'copied_passage', 'items[2]'],
    ]);
    expect(document).toBeUndefined();
    expect(p.fixture.calls).toHaveLength(2);
    expect((await runs())[0]?.state).toBe('cancelled');
  });

  it('never resends an attempt whose outcome is unknown, and leaves its run open for reconciliation', async () => {
    const p = setup(() => ({ kind: 'timeout_after_dispatch' }));
    const { line } = await p.spike.writeOne('seasons', signal());
    expect(line.outcome).toBe('unknown');
    expect(p.fixture.calls).toHaveLength(1);
    expect((await runs())[0]?.state).toBe('admitted');
    expect((await attempts()).map((attempt) => attempt.state)).toEqual(['unknown']);
  });

  it('stops at the production scope’s own request cap: the capped topic sends nothing and the rest of the batch never starts', async () => {
    const capped: HarnessSettings = {
      ...fixtureSettings,
      caps: { ...fixtureSettings.caps, scope: { requestsPerDay: 1, tokensPerDay: 100_000_000 } },
    };
    const p = setup(() => answer(fixtureAuthoredV2()), capped);
    const seen: SpikeResult[] = [];
    const keys: ScrollTopic[] = ['seasons', 'seasons', 'seasons'];
    const summary = await runSpikeBatch(
      keys,
      (key) => p.spike.writeOne(key, signal()),
      (result) => {
        seen.push(result);
        return Promise.resolve();
      },
      1,
    );
    expect(seen.map((result) => result.line.outcome)).toEqual(['accepted_first_take', 'paused']);
    expect(seen[1]?.line.requests).toBe(0);
    expect(seen[1]?.line.code).toContain('requests');
    expect(summary).toMatchObject({ completed: 2, notStarted: ['seasons'], stoppedBy: { outcome: 'paused' } });
    expect(p.fixture.calls).toHaveLength(1);
  });
});
