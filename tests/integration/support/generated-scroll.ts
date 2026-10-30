import { sql, type Kysely } from 'kysely';
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
import { AuthoredScroll } from '@knowscroll/scroll-model/producer';
import { makeProduceScroll } from '../../../packages/backend/src/modules/content/production/produce.js';
import type { WriterFormat } from '../../../packages/backend/src/modules/content/production/writer.js';
import { fixtureModel, fixtureSettings, silent } from './fixture-model.js';
import type { FixtureModelPort, FixtureScenario } from './fixture-model-port.js';

/**
 * CI fixtures that drive the real Scroll production path (`makeProduceScroll`) against a labelled
 * fixture model. Every source paragraph and every model answer here is authored text about an
 * invented lighthouse: never provider output and never product content.
 */
export const FIXTURE_SOURCE = [
  'The Skerry lighthouse keeper winds the lamp clockwork every four hours through the long winter nights.',
  'A prism ring around the flame gathers the light into a single beam that sweeps across the water.',
  'Sailors count the seconds between flashes to learn which lighthouse they are approaching on the coast.',
  'Fog signals complement the beam, because light cannot cross a thick bank of fog for any useful distance.',
  'The tower stands twenty-one metres tall, which places the lamp high enough to clear distant waves.',
  'Today the clockwork has been replaced by a small motor, though the prisms are still the original glass.',
];
const researchHtml = (paragraphs: readonly string[]) =>
  `<html><title>CI fixture</title><main>${paragraphs.map((text) => `<p>${text}</p>`).join('')}</main></html>`;
export const fixtureResearchPage: ResearchPage = extractResearch(
  researchHtml(FIXTURE_SOURCE),
  'https://spaceplace.nasa.gov/seasons/en/',
  '2026-10-20T00:00:00.000Z',
);

/**
 * The page a fixture serves for a recipe URL: the first page of the seasons recipe as it is, any
 * other URL with one extra paragraph of its own, so a recipe with two pages gets two distinct ones.
 */
export function fixtureResearchFor(url: string): ResearchPage {
  if (url === fixtureResearchPage.url) return fixtureResearchPage;
  const closing = `This invented fixture page for ${url} adds nothing further about the lighthouse.`;
  return extractResearch(researchHtml([...FIXTURE_SOURCE, closing]), url, '2026-10-20T00:00:00.000Z');
}

/** Reader prose in other words than the source (no nine-word run in common), ~280 words in all. */
export const FIXTURE_PROSE = [
  'Ships need a way to know where the land begins long before they can see it. A tall tower with a bright lamp answers that need, and the clever part is how the lamp is shaped rather than how strong it is. Glass rings bend the glow into one narrow ribbon.',
  'Because the ribbon turns, a distant observer sees it only for a moment each rotation. Those regular flashes are not decoration. Each tower repeats its own rhythm, so a navigator who times the gaps can tell neighbouring towers apart on a dark coast.',
  'Someone had to keep that rotation going. In earlier times a keeper climbed the stairs on a fixed schedule to wind a weight-driven mechanism, and a missed visit meant a dark coast. Modern towers use a motor, yet the glass that shapes the beam is often the very same.',
  'Weather changes what a lamp can do. Thick fog scatters light in every direction, so the beam dissolves after a short distance, however clever its glass. That is why towers also carry sound signals, which travel through fog far better than any flash.',
  'Height matters as well as brightness. Raising the lamp pushes the horizon outward, so the beam can be seen from farther away before the curve of the sea hides the tower. A modest hill or a tall column both do the same job.',
  'Put together, these ideas describe a small system: a shaped beam, a signature rhythm, a dependable rotation and a backup for bad weather. Each part solves a different problem, and the whole is only as reliable as its weakest piece.',
];
const DIAGRAM = {
  type: 'diagram',
  cites: ['e2', 'e3', 'e4'],
  title: 'A lighthouse in two conditions',
  layout: 'flow-lr',
  nodes: [
    { id: 'lamp', label: 'Lamp' },
    { id: 'prisms', label: 'Prism ring', kind: 'process' },
    { id: 'ship', label: 'Ship' },
  ],
  edges: [
    { id: 'glow', from: 'lamp', to: 'prisms', label: 'Glow' },
    { id: 'beam', from: 'prisms', to: 'ship', label: 'Beam' },
  ],
  frames: [
    {
      label: 'Clear night',
      description: 'The beam crosses open water and reaches the ship.',
      highlight: ['beam'],
    },
    {
      label: 'Thick fog',
      description: 'The beam fades early, so a sound signal must take over.',
      hide: ['beam'],
    },
  ],
} as const;
const SEQUENCE = {
  type: 'sequence',
  cites: ['e2', 'e3', 'e4'],
  title: 'A night at the lighthouse',
  steps: [
    { title: 'Light the lamp', text: 'The keeper lights the lamp at dusk.' },
    { title: 'Turn the lens', text: 'The prism ring turns, so the beam sweeps the water.' },
    { title: 'Watch the weather', text: 'In thick fog a sound signal takes over from the beam.' },
  ],
} as const;
const COMPARISON = {
  type: 'comparison',
  cites: ['e2', 'e3', 'e4'],
  title: 'A lighthouse in two conditions',
  columns: ['Clear night', 'Thick fog'],
  rows: [
    ['The beam crosses open water and reaches the ship.', 'The beam fades early, so the ship sees nothing of it.'],
    ['Sailors time the flashes to name the tower.', 'A sound signal must take over from the lamp.'],
  ],
} as const;

/** The block a recipe's format asks for, authored about the same invented lighthouse. */
function formatBlock(format: WriterFormat) {
  switch (format) {
    case 'diagram':
      return DIAGRAM;
    case 'comparison':
      return COMPARISON;
    case 'sequence':
      return SEQUENCE;
    case 'chart':
    case 'simulation':
    case 'timeline':
      throw new Error(`CI_FIXTURE_FORMAT_UNSUPPORTED:${format}`);
  }
}

/** The writer's answer in the authoring shape, with the block the recipe's format asks for. */
export function fixtureAuthored(
  format: WriterFormat,
  overrides: { readonly drop?: string; readonly paragraph?: string } = {},
) {
  const prose = FIXTURE_PROSE.map((text, index) => (index === 1 && overrides.paragraph ? overrides.paragraph : text));
  return AuthoredScroll.parse({
    title: 'How a lighthouse guides ships',
    dek: 'A shaped beam, a rhythm and a dependable rotation turn one lamp into a coastal signal.',
    blocks: [
      { type: 'heading', text: 'The beam' },
      { type: 'paragraph', cites: ['e1', 'e2'], text: prose[0] },
      { type: 'paragraph', cites: ['e2', 'e3'], text: prose[1] },
      { type: 'heading', text: 'The upkeep' },
      { type: 'paragraph', cites: ['e1', 'e6'], text: prose[2] },
      { type: 'paragraph', cites: ['e4'], text: prose[3] },
      formatBlock(format),
      { type: 'heading', text: 'Putting it together' },
      { type: 'paragraph', cites: ['e5'], text: prose[4] },
      { type: 'paragraph', cites: ['e3', 'e5'], text: prose[5] },
      {
        type: 'callout',
        cites: ['e4'],
        kind: 'limit',
        title: 'Where this stops',
        text: 'This picture ignores radio and satellite navigation, which now do most of the work.',
      },
    ].filter((block) => block.type !== overrides.drop),
  });
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
  research: (url: string) => ResearchPage = fixtureResearchFor,
): { readonly calls: FixtureModelPort['calls']; readonly produce: ReturnType<typeof makeProduceScroll> } {
  const fixture = fixtureModel(script, { label: 'generated-scroll-CI-fixture' });
  const model = guardedModelPort({ ...fixture, provider: 'minimax', model: 'MiniMax-M3.1-Flash' });
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
    research: (url) => Promise.resolve(research(url)),
  });
  return { calls: fixture.calls, produce };
}

/** The production scope is disabled until an operator enables it; tests enable it explicitly. */
export async function enableProductionScope(db: Kysely<Database>): Promise<void> {
  await sql`update reasoning.production_scopes set enabled=true where id='scroll-supply'`.execute(db);
}
