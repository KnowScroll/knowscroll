import { readFileSync } from 'node:fs';
import { sql, type Kysely } from 'kysely';
import { ScrollDraft, normaliseDraftInput } from '@knowscroll/scroll-model/producer';
import { makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
  guardedModelPort,
} from '@knowscroll/backend/reasoning/nest-providers';
import {
  extractResearch,
  type ResearchPage,
} from '../../../packages/backend/src/infrastructure/research/public-pages.js';
import { makeProduceScroll } from '../../../packages/backend/src/modules/content/production/produce.js';
import {
  hydrateSelectedClaims,
  quoteCandidates,
} from '../../../packages/backend/src/modules/content/production/quote-candidates.js';
import { writerDraftExampleJson } from '../../../packages/backend/src/modules/content/production/writer-example.js';
import { fixtureModel, fixtureSettings, silent } from './fixture-model.js';
import type { FixtureModelPort, FixtureScenario } from './fixture-model-port.js';

/**
 * CI fixtures that drive the real Scroll production path (`makeProduceScroll`) against a labelled
 * fixture model: authored research text, an authored claim selection and an authored writer draft.
 * Nothing here is provider output or product content.
 */
const passage =
  'This deliberately authored fixture passage describes the public research snapshot boundary with sufficiently distinctive wording for exact quote checks while avoiding overlap with the separate fixture explanation.';
/** Served for every recipe page, so use recipes that name exactly one page. */
export const fixtureResearchPage: ResearchPage = extractResearch(
  `<html><title>CI fixture</title><main>${[0, 1, 2, 3].map((n) => `<p>${passage} Example ${n}.</p>`).join('')}</main></html>`,
  'https://spaceplace.nasa.gov/seasons/en/',
  '2026-10-20T00:00:00.000Z',
);
const candidates = quoteCandidates([fixtureResearchPage]);
/** The claims role's answer: four candidate quotes. */
export const fixtureClaimSelection = { candidateIds: candidates.slice(0, 4).map(({ id }) => id) };
const claims = hydrateSelectedClaims([fixtureResearchPage], candidates, fixtureClaimSelection.candidateIds);

/** The writer's answer: the authored starter prose plus the format block the recipe asks for. */
export function fixtureWriterDraft(interactive: boolean) {
  const starter = JSON.parse(
    readFileSync(
      new URL(
        '../../../packages/backend/src/modules/content/starter/why-the-sky-is-blue.editorial-scroll.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { draft: unknown };
  const draft = ScrollDraft.parse(normaliseDraftInput(starter.draft));
  draft.sections = draft.sections
    .map((section) => ({
      ...section,
      blocks: section.blocks.filter((block) => block.type === 'paragraph' || block.type === 'callout'),
    }))
    .filter((section) => section.blocks.length > 0);
  const format = ScrollDraft.parse(JSON.parse(writerDraftExampleJson(interactive))).sections[0]?.blocks[1];
  if (format === undefined) throw new Error('CI_FORMAT_MISSING');
  draft.sections[0]?.blocks.push(format);
  for (const section of draft.sections)
    for (const block of section.blocks)
      draft.bindings.push({ kind: 'block', blockId: block.id ?? '', claimId: claims.claims[0]?.claimId ?? '' });
  return draft;
}

export const answerWith = (value: unknown): FixtureScenario => ({ kind: 'success', text: JSON.stringify(value) });

/**
 * A production run over the test database whose model is a labelled fixture. The transport is not
 * real, but it carries a MiniMax identity so the published attempts pass the same identity checks as
 * a real run.
 */
export function fixtureProduction(
  db: Kysely<Database>,
  script: Parameters<typeof fixtureModel>[0],
): { readonly calls: FixtureModelPort['calls']; readonly produce: ReturnType<typeof makeProduceScroll> } {
  const fixture = fixtureModel(script, { label: 'generated-scroll-CI-fixture' });
  const model = guardedModelPort({
    ...fixture,
    supportsSingleToolObject: true,
    supportsSingleToolJsonString: true,
    supportsNativeOutputSchema: true,
    provider: 'minimax',
    model: 'MiniMax-M3',
  });
  const withScope = makeWithProductionScope(db, { enabled: true, lockTimeoutMs: 5000 });
  const harness = makeProductionReasoningHarness(
    postgresProductionHarnessPorts({
      db,
      withProductionScope: withScope,
      enabled: true,
      model,
      logEvent: silent,
      settings: fixtureSettings,
    }),
  );
  const produce = makeProduceScroll({
    db,
    authority: { scopeId: 'scroll-supply', generation: 1 },
    withScope,
    harness,
    model: model.model,
    research: () => Promise.resolve(fixtureResearchPage),
  });
  return { calls: fixture.calls, produce };
}

/** The production scope is disabled until an operator enables it; tests enable it explicitly. */
export async function enableProductionScope(db: Kysely<Database>): Promise<void> {
  await sql`update reasoning.production_scopes set enabled=true where id='scroll-supply'`.execute(db);
}
