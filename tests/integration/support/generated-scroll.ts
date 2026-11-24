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
import { makeProduceScroll } from '../../../packages/backend/src/modules/content/production/produce.js';
import {
  ASK_ORDER_CHECK_RULES,
  hasEnoughWords,
  isAboutSentence,
  noClaimGround,
  sharedStems,
  type CheckerRules,
} from '../../../packages/backend/src/modules/content/domain/ask-support.js';
import { LIBRARY_CHECK_RULES } from '../../../packages/backend/src/modules/content/domain/library-support.js';
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

export const answerWith = (value: unknown): FixtureScenario => ({ kind: 'success', text: JSON.stringify(value) });

/** Whether a request is the answer checker's (the second role of a v2 library Scroll's job, D-198; a document v3 job sends none). */
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

/** Whether a request is the library support checker's (a stored library Scroll revision, D-415). */
export const isLibrarySupportCall = (call: FixtureCall): boolean =>
  call.request.system.includes('content.library-support-check');

/** The asset and revision a library support request is about, from its context bundle (`scroll:<asset>:<revision>:library-support:<round>:<batch>`). */
export function librarySupportTarget(call: FixtureCall): {
  readonly assetId: string;
  readonly revision: number;
  readonly batch: number;
} {
  const match = /<context bundle="scroll:([0-9a-f-]{36}):(\d+):library-support:(\d+):(\d+)"/u.exec(call.request.user);
  if (match === null) throw new Error('CI fixture: not a library support request');
  return { assetId: match[1]!, revision: Number(match[2]), batch: Number(match[4]) };
}

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
  readonly sentences: readonly {
    readonly n: number;
    readonly cites: readonly string[];
    readonly text: string;
    readonly label?: boolean;
  }[];
  readonly passages: ReadonlyMap<string, string>;
} {
  const sentences = itemText(call, 'support:sentences')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { n: number; cites: string[]; text: string; label?: boolean });
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
export function quoteAbout(
  sentence: string,
  passages: readonly string[],
  rules: CheckerRules = ASK_ORDER_CHECK_RULES,
): string | undefined {
  let best: { readonly quote: string; readonly shared: number; readonly length: number } | undefined;
  for (const passage of passages) {
    const words = passage.split(/\s+/u);
    for (let from = 0; from < words.length; from += 1)
      for (let to = from + 2; to < Math.min(words.length, from + 25); to += 1) {
        const quote = words.slice(from, to + 1).join(' ');
        if (!hasEnoughWords(quote) || !isAboutSentence(quote, sentence, rules)) continue;
        const shared = sharedStems(quote, sentence);
        if (best === undefined || shared > best.shared || (shared === best.shared && to - from < best.length))
          best = { quote, shared, length: to - from };
      }
  }
  return best?.quote;
}

/**
 * A support checker's reply: every sentence supported with words of a passage it cites that are about it, except the
 * ones named, and a sentence no cited passage is about is marked as stating no fact (where that is allowed). The quote is real text of the
 * request and about the sentence, so the reply passes the schema's checks; an unrelated quote would not.
 */
export function supportReply(
  call: FixtureCall,
  script: SupportScript = {},
  rules: CheckerRules = ASK_ORDER_CHECK_RULES,
): FixtureScenario {
  const { sentences, passages } = supportRequestOf(call);
  return answerWith({
    sentences: sentences.map((sentence) => {
      const flagged = script.unsupported?.[sentence.n];
      if (flagged !== undefined) return { n: sentence.n, verdict: 'unsupported', ...flagged };
      if (script.noClaim?.includes(sentence.n) === true) return { n: sentence.n, verdict: 'no_claim' };
      const cited = sentence.cites.flatMap((handle) => passages.get(handle) ?? []);
      const quote = quoteAbout(sentence.text, cited, rules);
      if (quote !== undefined) return { n: sentence.n, verdict: 'supported', quote };
      // A sentence no passage is about may state no fact only where code can see it; a fixture answer must not need more.
      if (
        noClaimGround({ text: sentence.text, ...(sentence.label === true ? { label: true } : {}) }, cited, rules) ===
        undefined
      )
        throw new Error(`CI fixture: sentence ${String(sentence.n)} has no words of its passages about it`);
      return { n: sentence.n, verdict: 'no_claim' };
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
  librarySupport: SupportChecker = (_check, call) => supportReply(call, {}, LIBRARY_CHECK_RULES),
): {
  readonly script: (sequence: number, call: FixtureCall) => FixtureScenario | Promise<FixtureScenario>;
  /** The writer's requests so far (live). */
  readonly writerCalls: FixtureCall[];
  /** The answer checker's requests so far (live). */
  readonly checkerCalls: FixtureCall[];
  /** The support checker's requests so far (live). */
  readonly supportCalls: FixtureCall[];
  /** The library support checker's requests so far (live, D-415). */
  readonly librarySupportCalls: FixtureCall[];
} {
  const writerCalls: FixtureCall[] = [];
  const checkerCalls: FixtureCall[] = [];
  const supportCalls: FixtureCall[] = [];
  const librarySupportCalls: FixtureCall[] = [];
  const script = (_sequence: number, call: FixtureCall) => {
    if (isLibrarySupportCall(call)) {
      librarySupportCalls.push(call);
      return librarySupport(librarySupportCalls.length, call);
    }
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
  return { script, writerCalls, checkerCalls, supportCalls, librarySupportCalls };
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
