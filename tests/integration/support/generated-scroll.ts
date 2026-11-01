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
import {
  hasEnoughWords,
  isAbout,
  sharedStems,
} from '../../../packages/backend/src/modules/content/domain/ask-support.js';
import type { WriterFormat } from '../../../packages/backend/src/modules/content/production/writer.js';
import { fixtureModel, fixtureSettings, silent } from './fixture-model.js';
import type { FixtureCall, FixtureScenario } from './fixture-model-port.js';

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
    case 'plain':
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
      ...(format === 'plain' ? [] : [formatBlock(format)]),
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

/**
 * The answer to a question, authored about the same invented lighthouse as the sources above: every sentence is written
 * from the passages its block cites, so a support check that reads it finds words of those passages that are about the
 * sentence. It is a labelled CI fixture, never product content. `sentence` replaces one sentence of the answer (the
 * support check's repair).
 */
export function fixtureAnswer(overrides: { readonly sentence?: readonly [string, string] } = {}) {
  const say = (text: string) => (overrides.sentence?.[0] === text ? overrides.sentence[1] : text);
  return AuthoredScroll.parse({
    title: 'How a lamp and a prism ring guide sailors',
    dek: 'A ring of glass shapes one beam, and the lamp clockwork turns it so sailors can read the coast.',
    blocks: [
      { type: 'heading', text: 'The beam' },
      {
        type: 'paragraph',
        cites: ['e2', 'e3'],
        text: [
          'A ring of prisms around the flame bends the light into one narrow beam.',
          say('Because the beam turns, sailors see it only as a flash, once each turn.'),
          'By counting the seconds between flashes, sailors learn which lighthouse they are near.',
          'Each tower repeats its own rhythm, so a pattern of flashes cannot be mistaken for the next coast along.',
        ].join(' '),
      },
      { type: 'heading', text: 'The upkeep' },
      {
        type: 'paragraph',
        cites: ['e1', 'e6'],
        text: [
          'Someone had to keep that turning going, and the keeper once wound the lamp clockwork by hand every few hours.',
          'Today a small motor does that work, though the glass prisms are the original ones.',
          'So the keeper no longer winds the clockwork every few hours.',
        ].join(' '),
      },
      {
        type: 'paragraph',
        cites: ['e4'],
        text: [
          'Thick fog scatters light in every direction, so the beam fades after a short distance.',
          'That is why a lighthouse also needs a sound signal, which fog does not stop.',
        ].join(' '),
      },
      { type: 'heading', text: 'Putting it together' },
      {
        type: 'paragraph',
        cites: ['e5', 'e6'],
        text: [
          'Height helps too, because a lamp set high above the sea can clear distant waves.',
          'The tower in this story is twenty-one metres tall.',
          'Each part solves a different problem, and the whole is only as reliable as its weakest piece.',
        ].join(' '),
      },
      {
        type: 'callout',
        cites: ['e4'],
        kind: 'limit',
        title: 'Where this stops',
        text: 'This picture ignores radio and satellite navigation, which now do most of the work.',
      },
    ],
  });
}

export const answerWith = (value: unknown): FixtureScenario => ({ kind: 'success', text: JSON.stringify(value) });

/** Whether a request is the answer checker's (a v2 library Scroll's second role, D-198). */
export const isCheckerCall = (call: FixtureCall): boolean =>
  call.request.system.includes('content.scroll-answer-check');

/** The ids of the calls a checker request lists, in the order given. */
export function checkedCallIds(call: FixtureCall): string[] {
  return [...call.request.user.matchAll(/<context-item ref="answer-check:([^"]+)"/gu)].map((match) => match[1]!);
}

/** A checker's verdicts: every call consistent, except the ones named (id -> problem). */
export function verdicts(ids: readonly string[], flagged: Readonly<Record<string, string>> = {}): FixtureScenario {
  return answerWith({
    calls: ids.map((id) =>
      flagged[id] === undefined ? { id, consistent: true } : { id, consistent: false, problem: flagged[id] },
    ),
  });
}

/** Whether a request is the support checker's (the answer to a person's question, D-250). */
export const isSupportCall = (call: FixtureCall): boolean => call.request.system.includes('content.ask-support-check');

const unescapeData = (text: string): string =>
  text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

/** The text of one context item of a request, as the model would read it. */
function itemText(call: FixtureCall, ref: string): string {
  const match = new RegExp(`<context-item ref="${ref}"[^>]*>\\n([\\s\\S]*?)\\n</context-item>`, 'u').exec(
    call.request.user,
  );
  return match === null ? '' : unescapeData(match[1]!);
}

/** A support check request as the fixture reads it: the sentences listed, and the text of each passage by handle. */
export function supportRequestOf(call: FixtureCall): {
  readonly sentences: readonly { readonly n: number; readonly cites: readonly string[]; readonly text: string }[];
  readonly passages: ReadonlyMap<string, string>;
} {
  const sentences = itemText(call, 'support:sentences')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { n: number; cites: string[]; text: string });
  const passages = new Map(
    itemText(call, 'support:passages')
      .split('\n')
      .flatMap((line) => {
        const parsed = /^\[(e\d+)\] (.*)$/u.exec(line);
        return parsed === null ? [] : [[parsed[1]!, parsed[2]!] as const];
      }),
  );
  return { sentences, passages };
}

/** Which sentences of a support check a fixture finds unsupported (number -> kind and note), and which it marks as stating no fact. */
export interface SupportScript {
  readonly unsupported?: Readonly<Record<number, { readonly kind: string; readonly problem: string }>>;
  readonly noClaim?: readonly number[];
}

/**
 * The words of the cited passages that are about a sentence: the window of at most twenty-five words with the most key
 * words in common with it (the shortest of those), or nothing when no window of any cited passage is about it. A quote
 * that is real but about something else would not pass the schema, so a fixture reply must choose words that are.
 */
export function quoteAbout(sentence: string, passages: readonly string[]): string | undefined {
  let best: { readonly quote: string; readonly shared: number; readonly length: number } | undefined;
  for (const passage of passages) {
    const words = passage.split(/\s+/u);
    for (let from = 0; from < words.length; from += 1)
      for (let to = from + 2; to < Math.min(words.length, from + 25); to += 1) {
        const quote = words.slice(from, to + 1).join(' ');
        if (!hasEnoughWords(quote) || !isAbout(quote, sentence)) continue;
        const shared = sharedStems(quote, sentence);
        if (best === undefined || shared > best.shared || (shared === best.shared && to - from < best.length))
          best = { quote, shared, length: to - from };
      }
  }
  return best?.quote;
}

/**
 * A support checker's reply: every sentence supported with words of a passage it cites that are about it, except the
 * ones named, and a sentence no cited passage is about is marked as stating no fact. The quote is real text of the
 * request and about the sentence, so the reply passes the schema's checks; an unrelated quote would not.
 */
export function supportReply(call: FixtureCall, script: SupportScript = {}): FixtureScenario {
  const { sentences, passages } = supportRequestOf(call);
  return answerWith({
    sentences: sentences.map((sentence) => {
      const flagged = script.unsupported?.[sentence.n];
      if (flagged !== undefined) return { n: sentence.n, verdict: 'unsupported', ...flagged };
      if (script.noClaim?.includes(sentence.n) === true) return { n: sentence.n, verdict: 'no_claim' };
      const cited = sentence.cites.flatMap((handle) => passages.get(handle) ?? []);
      const quote = quoteAbout(sentence.text, cited);
      return quote === undefined
        ? { n: sentence.n, verdict: 'no_claim' }
        : { n: sentence.n, verdict: 'supported', quote };
    }),
  });
}

/** The support checker's script: its own request count from 1, the request, and a reply (by default every sentence supported). */
export type SupportChecker = (check: number, call: FixtureCall) => FixtureScenario | Promise<FixtureScenario>;

/**
 * Routes a production job's requests: the answer checker's go to `checker` (its own count, from 1, and the ids of
 * the calls it was asked about; by default every call is consistent), the support checker's go to `support` (its own
 * count, from 1; by default every sentence is supported), and everything the writer is asked, a check repair
 * included, to `writer` with the writer's own count, so a script written for the writer alone still counts its
 * requests from 1.
 */
export function routedScript(
  writer: (sequence: number, call: FixtureCall) => FixtureScenario | Promise<FixtureScenario>,
  checker: (check: number, ids: readonly string[], call: FixtureCall) => FixtureScenario = (_check, ids) =>
    verdicts(ids),
  support: SupportChecker = (_check, call) => supportReply(call),
): {
  readonly script: (sequence: number, call: FixtureCall) => FixtureScenario | Promise<FixtureScenario>;
  /** The writer's requests so far (live). */
  readonly writerCalls: FixtureCall[];
  /** The answer checker's requests so far (live). */
  readonly checkerCalls: FixtureCall[];
  /** The support checker's requests so far (live). */
  readonly supportCalls: FixtureCall[];
} {
  const writerCalls: FixtureCall[] = [];
  const checkerCalls: FixtureCall[] = [];
  const supportCalls: FixtureCall[] = [];
  const script = (_sequence: number, call: FixtureCall) => {
    if (isCheckerCall(call)) {
      checkerCalls.push(call);
      return checker(checkerCalls.length, checkedCallIds(call), call);
    }
    if (isSupportCall(call)) {
      supportCalls.push(call);
      return support(supportCalls.length, call);
    }
    writerCalls.push(call);
    return writer(writerCalls.length, call);
  };
  return { script, writerCalls, checkerCalls, supportCalls };
}

/**
 * A production run over the test database whose model is a labelled fixture. The transport is not
 * real, but it carries a MiniMax identity so the published attempts pass the same identity checks as
 * a real run.
 */
export function fixtureProduction(
  db: Kysely<Database>,
  script: (sequence: number, call: FixtureCall) => FixtureScenario | Promise<FixtureScenario>,
  research: (url: string) => ResearchPage = fixtureResearchFor,
  checker?: Parameters<typeof routedScript>[1],
  support?: Parameters<typeof routedScript>[2],
): {
  /** The writer's requests only (the first answer, the validator's repair and a check repair). */
  readonly calls: readonly FixtureCall[];
  /** The answer checker's requests only. */
  readonly checks: readonly FixtureCall[];
  /** The support checker's requests only. */
  readonly supports: readonly FixtureCall[];
  readonly produce: ReturnType<typeof makeProduceScroll>;
} {
  const routed = routedScript(script, checker, support);
  const fixture = fixtureModel(routed.script, { label: 'generated-scroll-CI-fixture' });
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
  return { calls: routed.writerCalls, checks: routed.checkerCalls, supports: routed.supportCalls, produce };
}

/** The production scope is disabled until an operator enables it; tests enable it explicitly. */
export async function enableProductionScope(db: Kysely<Database>): Promise<void> {
  await sql`update reasoning.production_scopes set enabled=true where id='scroll-supply'`.execute(db);
}
