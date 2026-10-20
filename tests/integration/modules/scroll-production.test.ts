import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import type { ProductionReasoningHarness } from '@knowscroll/backend/reasoning';
import {
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
} from '@knowscroll/backend/reasoning/nest-providers';
import { ScrollDraft, normaliseDraftInput } from '@knowscroll/scroll-model/producer';
import {
  extractResearch,
  ResearchRefusal,
  type ResearchPage,
} from '../../../packages/backend/src/infrastructure/research/public-pages.js';
import { makeProduceScroll } from '../../../packages/backend/src/modules/content/production/produce.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel, fixtureSettings, gate, signal, silent } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';

// Every word below and every model answer is a labelled, authored CI fixture, never real provider evidence.
const passage =
  'This deliberately authored fixture passage describes the public research snapshot boundary with sufficiently distinctive wording for exact quote checks while avoiding overlap with the separate fixture explanation.';
const page = extractResearch(
  `<html><title>CI fixture</title><main>${[0, 1, 2, 3].map((n) => `<p>${passage} Example ${n}.</p>`).join('')}</main></html>`,
  'https://spaceplace.nasa.gov/seasons/en/',
  '2026-10-20T00:00:00.000Z',
);
const claims = {
  claims: [0, 1, 2, 3].map((n) => ({
    claimId: `claim-fixture-${n}`,
    pageId: page.id,
    passageId: page.passages[n]?.id ?? '',
    statement: 'An authored CI fixture checks structure without establishing factual generation.',
    quote: passage,
    truthState: 'documented',
  })),
};
function draft() {
  const starter = JSON.parse(
    readFileSync(
      new URL(
        '../../../packages/backend/src/modules/content/starter/why-the-sky-is-blue.editorial-scroll.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { draft: unknown };
  const value = ScrollDraft.parse(normaliseDraftInput(starter.draft));
  for (const section of value.sections)
    for (const block of section.blocks) {
      if (block.type !== 'subheading')
        value.bindings.push({ kind: 'block', blockId: block.id ?? '', claimId: 'claim-fixture-0' });
      if (block.type === 'disclosure')
        for (const child of block.data.blocks)
          value.bindings.push({ kind: 'block', blockId: child.id ?? '', claimId: 'claim-fixture-0' });
    }
  return value;
}
const answer = (value: unknown): FixtureScenario => ({ kind: 'success', text: JSON.stringify(value) });
describe('Scroll production (CI fixture + real PostgreSQL; no provider network)', () => {
  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('scroll_production');
    await sql`update reasoning.production_scopes set enabled=true where id='scroll-supply'`.execute(database.db);
  });
  afterEach(async () => {
    await database.drop();
  });
  function setup(script: Parameters<typeof fixtureModel>[0]) {
    const model = fixtureModel(script, { label: 'scroll-production-CI-fixture' });
    const withScope = makeWithProductionScope(database.db, { enabled: true, lockTimeoutMs: 5000 });
    const harness = makeProductionReasoningHarness(
      postgresProductionHarnessPorts({
        db: database.db,
        withProductionScope: withScope,
        enabled: true,
        model,
        logEvent: silent,
        settings: fixtureSettings,
      }),
    );
    const produce = (
      selected: ProductionReasoningHarness = harness,
      research: (url: string) => Promise<ResearchPage> = () => Promise.resolve(page),
    ) =>
      makeProduceScroll({
        db: database.db,
        authority: { scopeId: 'scroll-supply', generation: 1 },
        withScope,
        harness: selected,
        model: 'fixture-model-v1',
        research,
      });
    return { model, harness, produce };
  }
  it('publishes once, keeps private provenance separate and does no further work on rerun', async () => {
    const p = setup((n) => answer(n === 1 ? claims : draft()));
    const first = await p.produce()('greenhouse', false, signal());
    expect(first).toMatchObject({ outcome: 'published', requestBound: 4, revision: 1 });
    expect(p.model.calls).toHaveLength(2);
    expect(await p.produce()('greenhouse', false, signal())).toEqual(first);
    expect(p.model.calls).toHaveLength(2);
    const revision = await database.db
      .selectFrom('content.asset_revisions')
      .select(['document', 'explanation_unit_id', 'provenance_kind'])
      .where('asset_id', '=', first.assetId ?? '')
      .executeTakeFirstOrThrow();
    expect(revision.explanation_unit_id).toBe('legacy-cutroom-greenhouse');
    expect(revision.provenance_kind).toBe('generated');
    for (const hidden of ['claims', 'sources', 'bindings', 'checks', 'production'])
      expect(revision.document).not.toHaveProperty(hidden);
    const provenance = await database.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .where('asset_id', '=', first.assetId ?? '')
      .executeTakeFirstOrThrow();
    expect(provenance.provenance).toMatchObject({ production: { model: 'fixture-model-v1' } });
    expect(
      await database.db
        .selectFrom('content.asset_revisions')
        .select('revision')
        .where('asset_id', '=', first.assetId ?? '')
        .execute(),
    ).toHaveLength(1);
  });
  it('publishes at the four-request maximum with one exact-quote and one semantic writer repair', async () => {
    const badClaims = structuredClone(claims);
    if (badClaims.claims[0]) badClaims.claims[0].quote += ' Invented words.';
    const badWriter = draft();
    badWriter.bindings = [];
    const p = setup((n) => answer(n === 1 ? badClaims : n === 2 ? claims : n === 3 ? badWriter : draft()));
    const first = await p.produce()('greenhouse', false, signal());
    expect(first).toMatchObject({ outcome: 'published', requestBound: 4 });
    expect(p.model.calls).toHaveLength(4);
    const receipts = first.attempts?.filter((item) => item.role !== 'checks') ?? [];
    expect(receipts.map((item) => item.role)).toEqual(['claims', 'writer']);
    for (const receipt of receipts) {
      expect(receipt.attempts?.map((attempt) => attempt.step)).toEqual(['primary', 'repair']);
      expect(receipt.inputTokens).toBe(80);
      expect(receipt.outputTokens).toBe(24);
    }
    expect(receipts.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0)).toBe(160);
    expect(receipts.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0)).toBe(48);
    const provenance = await database.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .where('asset_id', '=', first.assetId ?? '')
      .executeTakeFirstOrThrow();
    expect(provenance.provenance).toMatchObject({
      production: {
        attemptIds: receipts.find((item) => item.role === 'writer')?.attempts?.map((attempt) => attempt.attemptId),
      },
    });
    expect(await p.produce()('greenhouse', false, signal(), true)).toEqual(first);
    expect(p.model.calls).toHaveLength(4);
  });
  it('includes semantic refusal in the single writer repair and records terminal rejection without another retry', async () => {
    const p = setup((n) =>
      answer(
        n === 1
          ? claims
          : {
              draftVersion: 'scroll-draft.v1',
              title: 'Invalid draft',
              dek: 'An invalid scripted fixture.',
              sections: [],
              bindings: [],
            },
      ),
    );
    const first = await p.produce()('seasons', false, signal());
    expect(first.outcome).toBe('rejected');
    expect(p.model.calls).toHaveLength(3);
    expect(await p.produce()('seasons', false, signal(), true)).toMatchObject({
      outcome: 'rejected',
      runId: first.runId,
    });
    expect(p.model.calls).toHaveLength(3);
    const stored = await sql<{
      state: string;
      outcomes: { kind: string }[];
    }>`select state,outcomes from content.scroll_production_runs where id=${first.runId}`.execute(database.db);
    expect(stored.rows[0]?.state).toBe('rejected');
    expect(stored.rows[0]?.outcomes.some((r) => r.kind === 'invalid_output')).toBe(true);
    expect(await database.db.selectFrom('content.asset_revisions').select('asset_id').execute()).toHaveLength(0);
  });
  it.each(['content.scroll-claims', 'content.scroll-writer'])(
    'resumes frozen same-run %s output after a crash without a new paid attempt',
    async (role) => {
      const p = setup((n) => answer(n === 1 ? claims : draft()));
      let crashed = false;
      const crashing: ProductionReasoningHarness = {
        readProductionRunAccounting: (scope, runId) => p.harness.readProductionRunAccounting(scope, runId),
        closeProductionRun: (scope, run) => p.harness.closeProductionRun(scope, run),
        async proposeProduction(input, abort) {
          const output = await p.harness.proposeProduction(input, abort);
          if (input.role.id === role && !crashed) {
            crashed = true;
            throw new Error('CI_CRASH_AFTER_PROVIDER_SETTLEMENT');
          }
          return output;
        },
      };
      await expect(p.produce(crashing)('greenhouse', false, signal())).rejects.toThrow(
        'CI_CRASH_AFTER_PROVIDER_SETTLEMENT',
      );
      expect((await p.produce()('greenhouse', false, signal())).outcome).toBe('in_progress');
      const resumed = await p.produce()('greenhouse', false, signal(), true);
      expect(resumed.outcome).toBe('published');
      expect(p.model.calls).toHaveLength(2);
    },
  );
  it.each(['success', 'refusal'] as const)(
    'keeps an advanced writer alive when concurrent stale research finishes with %s',
    async (outcome) => {
      const researchEntered = gate();
      const researchRelease = gate();
      const writerEntered = gate();
      const writerRelease = gate<FixtureScenario>();
      const p = setup((n) => {
        if (n === 1) return answer(claims);
        writerEntered.open();
        return { kind: 'hold', until: writerRelease.promise };
      });
      const stale = p.produce(p.harness, async () => {
        researchEntered.open();
        await researchRelease.promise;
        if (outcome === 'refusal') throw new ResearchRefusal('network_failed');
        return page;
      })('greenhouse', false, signal());
      await researchEntered.promise;
      const active = p.produce()('greenhouse', false, signal(), true);
      try {
        await writerEntered.promise;
        researchRelease.open();
        const replay = await stale;
        expect(replay.outcome).toBe('in_progress');
        const current = await sql<{
          state: string;
          outcomes: { role: string; kind: string }[];
        }>`select state,outcomes from content.scroll_production_runs where id=${replay.runId}`.execute(database.db);
        expect(current.rows[0]?.state).toBe('writer');
        expect(current.rows[0]?.outcomes.map((receipt) => receipt.role)).toEqual(['claims']);
        expect(p.model.calls).toHaveLength(2);
        const attempts = await database.db
          .selectFrom('reasoning.production_attempts')
          .select(['state', 'step'])
          .orderBy('reserved_at')
          .execute();
        expect(attempts.map((attempt) => attempt.state)).toEqual(['succeeded', 'dispatched']);
        writerRelease.open(answer(draft()));
        expect((await active).outcome).toBe('published');
        expect(p.model.calls).toHaveLength(2);
      } finally {
        researchRelease.open();
        writerRelease.open(answer(draft()));
        await Promise.allSettled([stale, active]);
      }
    },
  );
  it('replays the current job when a stale claims delivery finds its run closed during another writer', async () => {
    const claimsEntered = gate();
    const claimsRelease = gate();
    const writerEntered = gate();
    const writerRelease = gate<FixtureScenario>();
    const p = setup((n) => {
      if (n === 1) return answer(claims);
      writerEntered.open();
      return { kind: 'hold', until: writerRelease.promise };
    });
    const delayed: ProductionReasoningHarness = {
      readProductionRunAccounting: (scope, runId) => p.harness.readProductionRunAccounting(scope, runId),
      closeProductionRun: (scope, run) => p.harness.closeProductionRun(scope, run),
      async proposeProduction(input, abort) {
        if (input.role.id === 'content.scroll-claims') {
          claimsEntered.open();
          await claimsRelease.promise;
        }
        return p.harness.proposeProduction(input, abort);
      },
    };
    const stale = p.produce(delayed)('greenhouse', false, signal());
    await claimsEntered.promise;
    const active = p.produce()('greenhouse', false, signal(), true);
    try {
      await writerEntered.promise;
      claimsRelease.open();
      const replay = await stale;
      expect(replay.outcome).toBe('in_progress');
      const current = await sql<{
        state: string;
      }>`select state from content.scroll_production_runs where id=${replay.runId}`.execute(database.db);
      expect(current.rows[0]?.state).toBe('writer');
      expect(p.model.calls).toHaveLength(2);
      writerRelease.open(answer(draft()));
      expect((await active).outcome).toBe('published');
      expect(p.model.calls).toHaveLength(2);
    } finally {
      claimsRelease.open();
      writerRelease.open(answer(draft()));
      await Promise.allSettled([stale, active]);
    }
  });
  it('halts an unknown attempt and never resends it even with explicit resume', async () => {
    const p = setup(() => ({ kind: 'timeout_after_dispatch' }));
    expect((await p.produce()('tides', false, signal())).outcome).toBe('unknown');
    expect((await p.produce()('tides', false, signal(), true)).outcome).toBe('unknown');
    expect(p.model.calls).toHaveLength(1);
  });
  it('dry run reports the bound and performs no database/provider effects', async () => {
    const p = setup(() => ({ kind: 'malformed' }));
    expect(await p.produce()('greenhouse', true, signal())).toEqual({ outcome: 'dry_run', requestBound: 4 });
    expect(p.model.calls).toHaveLength(0);
    expect(
      (
        await sql<{ count: string }>`select count(*)::text as count from content.scroll_production_runs`.execute(
          database.db,
        )
      ).rows[0]?.count,
    ).toBe('0');
  });
});
