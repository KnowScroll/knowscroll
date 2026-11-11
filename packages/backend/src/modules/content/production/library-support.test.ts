import { describe, expect, it } from 'vitest';
import { validateDocumentV2, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { ScrollProvenanceV2 } from '@knowscroll/scroll-model/internal';
import { MAX_CONTEXT_ITEM_CHARS } from '../../../reasoning/public.js';
import { LIBRARY_CHECK_RULES, LIBRARY_SUPPORT_POLICY, resultsOf } from '../domain/library-support.js';
import { ASK_SUPPORT_INSTRUCTIONS, askOrderCheckerRole, askSupportRole } from './ask-support.js';
import { evidencePassages } from './evidence.js';
import { CHECK_LIBRARY_SUPPORT_CLAIM_SECONDS } from './library-support-events.js';
import {
  LIBRARY_SUPPORT_BATCH_SENTENCES,
  LIBRARY_SUPPORT_CHECK_VERSION,
  LIBRARY_SUPPORT_INSTRUCTIONS,
  LIBRARY_SUPPORT_MAX_BATCHES,
  LIBRARY_SUPPORT_REQUEST_BOUND,
  LIBRARY_SUPPORT_ROLE_ID,
  NOT_COVERED,
  NOT_COVERED_LINE,
  libraryEvidenceOf,
  librarySupportContext,
  librarySupportRole,
  sentencesOfScroll,
  underCheck,
  type LibraryEvidence,
} from './library-support.js';
import {
  CHECK_SOURCE_MODULES,
  checkerVersionOf,
  normalisedSource,
  readCheckSources,
} from './library-support-version.js';
import { fixtureAuthoredV2, fixtureResearchPageV2 } from './spike-v2/writer-v2.fixture.js';
import { storedScrollV2 } from './stored-v2.js';
import { publicationV2, type WriterV2Context } from './writer-v2.js';

const context: WriterV2Context = {
  publication: publicationV2('seasons'),
  recipe: {
    variant: 'stage',
    misconception: {
      kind: 'myth',
      claim: 'Orrin is warmest because it is closest to its star.',
      source: { label: 'CI fixture label', reviewed: true },
    },
  },
  passages: evidencePassages([fixtureResearchPageV2]),
  pages: [fixtureResearchPageV2],
};

/** The labelled Orrin fixture (invented, never product content), compiled and stored the way production stores it: the document and its private provenance. */
function orrin(): { readonly document: ScrollDocumentV2; readonly provenance: ScrollProvenanceV2 } {
  const outcome = storedScrollV2(fixtureAuthoredV2(), context, {
    runId: 'run-ci-1',
    attemptIds: ['attempt-ci-1'],
    model: 'MiniMax-M3.1-Flash',
  });
  if (outcome.kind !== 'compiled') throw new Error('CI expected a compile');
  const checked = validateDocumentV2(outcome.document);
  const provenance = ScrollProvenanceV2.safeParse(outcome.provenance);
  if (checked.kind !== 'valid' || !provenance.success) throw new Error('CI expected a valid document and provenance');
  return { document: checked.document, provenance: provenance.data };
}

describe('the sentences of a library Scroll that the support check reads (D-415, labelled Orrin CI fixture)', () => {
  const { document, provenance } = orrin();
  const evidence = libraryEvidenceOf(provenance);
  const listed = sentencesOfScroll(document, evidence);
  if (listed.kind !== 'sentences') throw new Error('CI expected sentences');
  const { sentences } = listed;
  const texts = sentences.map((sentence) => sentence.text);

  it('numbers them from 1 in reading order, the title and the dek first and the recap last', () => {
    expect(sentences.map((sentence) => sentence.number)).toEqual(sentences.map((_, index) => index + 1));
    expect(sentences[0]).toMatchObject({ part: 'title', field: 'title', label: true, text: document.title });
    expect(sentences[1]).toMatchObject({ part: 'dek', field: 'dek' });
    expect(sentences.at(-1)).toMatchObject({ part: 'recap', field: 'caption' });
    const stopOrder = document.stops.map((stop) => sentences.findIndex((sentence) => sentence.part === stop.id));
    expect(stopOrder).toEqual([...stopOrder].sort((a, b) => a - b));
  });

  it('lists what a reader reads: each stop’s lines, its plain restatement, the explanation and twist of a call, the asides and the recap', () => {
    for (const stop of document.stops) {
      if (stop.kind === 'read')
        for (const block of stop.blocks) expect(texts.join(' ')).toContain(block.text.split('.')[0]!);
      expect(sentences.some((sentence) => sentence.part === stop.id && sentence.field === 'simple')).toBe(true);
      if (stop.kind !== 'read') {
        expect(sentences.some((sentence) => sentence.part === stop.id && sentence.field === 'explain')).toBe(true);
        expect(sentences.some((sentence) => sentence.part === stop.id && sentence.field === 'twist')).toBe(true);
      }
    }
    for (const aside of document.asides) {
      expect(sentences.some((sentence) => sentence.part === aside.id && sentence.field === 'aside-text')).toBe(true);
      // An aside follows the stop it opens beside, before the next stop.
      const anchored = sentences.findIndex((sentence) => sentence.part === aside.anchorStop);
      const asideAt = sentences.findIndex((sentence) => sentence.part === aside.id);
      expect(asideAt).toBeGreaterThan(anchored);
    }
    for (const caption of document.recap.captions) expect(texts).toContain(caption);
  });

  it('marks the title, the headings and the titles of asides as labels, and nothing else', () => {
    const labels = sentences.filter((sentence) => sentence.label === true);
    expect(labels.length).toBeGreaterThan(1);
    for (const label of labels) expect(['title', 'heading', 'aside-title']).toContain(label.field);
    for (const sentence of sentences.filter((entry) => ['title', 'heading', 'aside-title'].includes(entry.field)))
      expect(sentence.label).toBe(true);
  });

  it('leaves out what is no claim of the Scroll’s own: questions, a call’s options, the misconception, the picture’s words and the ask suggestions', () => {
    expect(texts.filter((text) => text.endsWith('?'))).toEqual([]);
    for (const stop of document.stops)
      if (stop.kind !== 'read') for (const option of stop.options) expect(texts).not.toContain(option);
    if (document.misconception.kind === 'myth') expect(texts).not.toContain(document.misconception.claim);
    for (const state of document.stage?.states ?? []) expect(texts).not.toContain(state.alt);
    for (const suggestion of document.askSuggestions) expect(texts).not.toContain(suggestion);
    expect(sentences.some((sentence) => sentence.text === document.kicker)).toBe(false);
  });

  it('gives each sentence the passages its own part cites, the title and the dek everything the Scroll cites', () => {
    for (const sentence of sentences) {
      expect(sentence.cites.length).toBeGreaterThan(0);
      for (const handle of sentence.cites) expect(evidence.passages.map((passage) => passage.handle)).toContain(handle);
    }
    expect(sentences[0]!.cites).toEqual(evidence.cited);
    expect(sentences[1]!.cites).toEqual(evidence.cited);
    const aStop = document.stops.find((stop) => stop.kind === 'read')!;
    expect(sentences.find((sentence) => sentence.part === aStop.id)!.cites).toEqual(
      evidence.handlesOfPart.get(aStop.id),
    );
    expect(new Set(sentences.find((sentence) => sentence.part === aStop.id)!.cites).size).toBeLessThan(
      evidence.cited.length,
    );
  });

  it('is deterministic: the same document and provenance give the same sentences', () => {
    expect(sentencesOfScroll(document, libraryEvidenceOf(provenance))).toEqual(listed);
  });

  it('is shown to the checker without where a sentence stands', () => {
    const shown = underCheck(sentences);
    expect(shown[0]).toEqual({ number: 1, text: document.title, cites: evidence.cited, label: true });
    expect(shown[1]).not.toHaveProperty('part');
  });

  it('refuses a Scroll with a part that rests on no passage, sending nothing', () => {
    const without = (partId: string): LibraryEvidence => ({
      ...evidence,
      handlesOfPart: new Map([...evidence.handlesOfPart].filter(([id]) => id !== partId)),
    });
    expect(sentencesOfScroll(document, without(document.stops[0]!.id))).toEqual({
      kind: 'refused',
      code: 'citations_missing',
    });
    expect(sentencesOfScroll(document, without('recap'))).toEqual({ kind: 'refused', code: 'citations_missing' });
    const aside = document.asides[0];
    if (aside !== undefined)
      expect(sentencesOfScroll(document, without(aside.id))).toEqual({ kind: 'refused', code: 'citations_missing' });
  });

  it('counts within the bound of a check: a library Scroll fits the batches of one check', () => {
    expect(Math.ceil(sentences.length / LIBRARY_SUPPORT_BATCH_SENTENCES)).toBeLessThanOrEqual(
      LIBRARY_SUPPORT_MAX_BATCHES,
    );
  });
});

describe('the evidence of a stored revision', () => {
  it('numbers the claims in the order the provenance lists them and maps each part to the handles it cites', () => {
    const { provenance } = orrin();
    const evidence = libraryEvidenceOf(provenance);
    expect(evidence.passages.map((passage) => passage.text)).toEqual(provenance.claims.map((claim) => claim.quote));
    expect(evidence.passages.map((passage) => passage.handle)).toEqual(
      provenance.claims.map((_, index) => `e${String(index + 1)}`),
    );
    const [entry] = provenance.citations;
    expect(evidence.handlesOfPart.get(entry!.partId)).toHaveLength(entry!.claimIds.length);
  });

  it('drops a cited claim the provenance does not hold', () => {
    const evidence = libraryEvidenceOf({
      claims: [
        {
          claimId: 'c1',
          statement: 'x',
          quote: 'A passage of a CI fixture.',
          sourceId: 's1',
          truthState: 'documented',
        },
      ],
      citations: [{ partId: 's1', claimIds: ['c1', 'missing'] }],
    });
    expect(evidence.handlesOfPart.get('s1')).toEqual(['e1']);
  });
});

describe('the checker role of a library Scroll (D-415)', () => {
  const sentences = [
    { number: 1, text: 'Here is why it matters.', cites: ['e1'] },
    { number: 2, text: 'Orrin’s axis leans by 31 degrees.', cites: ['e1'] },
  ];
  const passages = [
    {
      handle: 'e1',
      text: 'Orrin’s axis leans by 31 degrees, and the lean points the same way all year, so it matters.',
    },
    {
      handle: 'e2',
      text: 'Sunlight strikes the northern ground at a steep angle when the north leans toward the star.',
    },
  ];

  it('is a role of its own, in the background budget class, with the version derived from what decides its verdicts', () => {
    const role = librarySupportRole(sentences, passages);
    expect(role).toMatchObject({
      id: 'content.library-support-check',
      budgetClass: 'background',
      minContextItems: 2,
    });
    expect(role.id).toBe(LIBRARY_SUPPORT_ROLE_ID);
    expect(role.version).toBe(LIBRARY_SUPPORT_CHECK_VERSION);
    expect(role.version).toMatch(/^library-support-check\.[0-9a-f]{8}$/u);
  });

  it('keeps the ask check’s three verdicts and judgement rules, told the library’s rules, under an introduction of its own', () => {
    for (const verdict of ['"supported"', '"unsupported"', '"no_claim"'])
      expect(LIBRARY_SUPPORT_INSTRUCTIONS).toContain(verdict);
    expect(LIBRARY_SUPPORT_INSTRUCTIONS).toContain('explainer');
    expect(LIBRARY_SUPPORT_INSTRUCTIONS).not.toContain('short answer to a reader’s question');
    expect(LIBRARY_SUPPORT_INSTRUCTIONS).not.toBe(ASK_SUPPORT_INSTRUCTIONS);
    // One shared key word is enough for a paraphrase, as for an ask order; a short sentence is not "no fact" on its length.
    expect(LIBRARY_SUPPORT_INSTRUCTIONS).toContain(
      'at least one of the sentence’s own key words when the sentence has eight or fewer key words',
    );
    expect(LIBRARY_SUPPORT_INSTRUCTIONS).not.toContain('for a sentence of eight words or fewer with no number');
  });

  it('tells the checker that only the passages the sentence cites count, and that sharing no word is not "no fact"', () => {
    expect(LIBRARY_SUPPORT_INSTRUCTIONS).toContain('a passage the sentence cites');
    expect(LIBRARY_SUPPORT_INSTRUCTIONS).toContain('a passage it does not cite does not count');
    expect(LIBRARY_SUPPORT_INSTRUCTIONS).toContain('which are the passages the sentence cites');
    expect(LIBRARY_SUPPORT_INSTRUCTIONS).not.toContain('any passage listed, not only those the sentence cites');
    expect(LIBRARY_SUPPORT_INSTRUCTIONS).toContain('and for nothing else');
    expect(LIBRARY_SUPPORT_INSTRUCTIONS).not.toContain(
      'shares no key word with the passages it cites. A sentence that has a number',
    );
    // The ask check keeps its own rule and its own text.
    expect(ASK_SUPPORT_INSTRUCTIONS).toContain('any passage listed, not only those the sentence cites');
    expect(ASK_SUPPORT_INSTRUCTIONS).toContain('shares no key word with the passages it cites');
  });

  it('applies the library’s rules to a reply: a short sentence marked as stating no fact is set aside as unclear material, where an ask order’s rule would accept it, and a quote that keeps one key word of a paraphrase is accepted', () => {
    const reply = {
      sentences: [
        { n: 1, verdict: 'no_claim' },
        { n: 2, verdict: 'supported', quote: 'Orrin’s axis leans by 31 degrees' },
      ],
    };
    const library = librarySupportRole(sentences, passages).outputSchema.parse(reply);
    expect(library.sentences[0]).toMatchObject({ verdict: 'unsupported', code: 'no_claim_without_ground' });
    expect(library.sentences[1]).toMatchObject({ verdict: 'supported' });
    const ask = askOrderCheckerRole(sentences, passages, sentences).outputSchema.parse(reply);
    expect(ask.sentences[0]).toEqual({ number: 1, verdict: 'no_claim' });
    // A paraphrase that keeps one key word of its sentence: strict rules would set it aside, the library's accept it.
    const paraphrase = [{ number: 1, text: 'The tilt of Orrin never changes during the year.', cites: ['e1'] }];
    const kept = { sentences: [{ n: 1, verdict: 'supported', quote: 'the lean points the same way all year' }] };
    expect(librarySupportRole(paraphrase, passages).outputSchema.parse(kept).sentences[0]).toMatchObject({
      verdict: 'supported',
    });
    expect(askSupportRole(paraphrase, passages, paraphrase).outputSchema.parse(kept).sentences[0]).toMatchObject({
      verdict: 'unsupported',
      code: 'quote_not_about_sentence',
    });
  });

  it('does not let "no fact" rest on a sentence sharing no key word with its passages: that verdict is set aside and the sentence is unclear', () => {
    // A figure-free sentence of more than eight words that shares no key word with the passage it cites: an ask order's answer may call it a transition.
    const unshared = [
      { number: 1, text: 'Travellers pause briefly before turning over every page in sequence.', cites: ['e1'] },
    ];
    const reply = { sentences: [{ n: 1, verdict: 'no_claim' }] };
    // Beside two sentences that are quoted, so that a share of "no fact" verdicts does not set it aside for another reason.
    const beside = [
      ...unshared,
      { number: 2, text: 'Orrin’s axis leans by 31 degrees.', cites: ['e1'] },
      { number: 3, text: 'The lean points the same way all year.', cites: ['e1'] },
    ];
    const askReply = {
      sentences: [
        { n: 1, verdict: 'no_claim' },
        { n: 2, verdict: 'supported', quote: 'axis leans by 31 degrees' },
        { n: 3, verdict: 'supported', quote: 'the lean points the same way all year' },
      ],
    };
    expect(askSupportRole(beside, passages, beside).outputSchema.parse(askReply).sentences[0]).toEqual({
      number: 1,
      verdict: 'no_claim',
    });
    const library = librarySupportRole(unshared, passages).outputSchema.parse(reply);
    expect(library.sentences[0]).toMatchObject({ verdict: 'unsupported', code: 'no_claim_without_ground' });
    const [result] = resultsOf(
      unshared.map((entry) => ({ ...entry, part: 's1', field: 'paragraph' as const })),
      library.sentences,
      {
        quotes: new Map(),
        passageTexts: new Map(passages.map((passage) => [passage.handle, passage.text])),
      },
    );
    expect(result).toMatchObject({ outcome: 'unclear', code: 'no_claim_without_ground' });
    // A label that names what follows still passes as stating no fact, with its ground kept.
    const label = [{ number: 1, text: 'How a lamp turns', cites: ['e1'], label: true as const }];
    const labelled = librarySupportRole(label, passages).outputSchema.parse(reply);
    expect(labelled.sentences[0]).toEqual({ number: 1, verdict: 'no_claim' });
    expect(
      resultsOf(
        label.map((entry) => ({ ...entry, part: 'title', field: 'title' as const })),
        labelled.sentences,
        {
          quotes: new Map(),
          passageTexts: new Map(),
        },
      )[0],
    ).toMatchObject({ outcome: 'no_claim', ground: 'label' });
  });

  it('takes the quote from the passages the sentence’s own part cites: a quote from another stop’s passage is set aside, where an ask order’s answer would accept it', () => {
    const stop = [
      { number: 1, text: 'The north leans toward the star and gets steep sunlight.', cites: ['e2'] },
      { number: 2, text: 'The lean of Orrin points the same way all year.', cites: ['e1', 'e2'] },
    ];
    // The first sentence cites only e2, and the checker quotes e1, which another part cites.
    const reply = {
      sentences: [
        { n: 1, verdict: 'supported', quote: 'axis leans by 31 degrees, and the lean points the same way all year' },
        { n: 2, verdict: 'supported', quote: 'the lean points the same way all year' },
      ],
    };
    const library = librarySupportRole(stop, passages).outputSchema.parse(reply);
    expect(library.sentences[0]).toMatchObject({ verdict: 'unsupported', code: 'quote_not_in_cited_passages' });
    // The second sentence cites e1, so the same words support it.
    expect(library.sentences[1]).toMatchObject({ verdict: 'supported' });
    expect(askOrderCheckerRole(stop, passages, stop).outputSchema.parse(reply).sentences[0]).toMatchObject({
      verdict: 'supported',
    });
  });

  it('keeps the quote the checker gave for each supported sentence, even when code set the verdict aside, so a stricter rule can be applied later', () => {
    const reply = {
      sentences: [
        { n: 1, verdict: 'supported', quote: 'axis leans by 31 degrees, and the lean points the same way all year' },
        { n: 2, verdict: 'unsupported', kind: 'goes_beyond', problem: 'A passage says something narrower.' },
      ],
    };
    const stop = [
      { number: 1, text: 'The north leans toward the star and gets steep sunlight.', cites: ['e2'] },
      { number: 2, text: 'The lean of Orrin points the same way all year.', cites: ['e1'] },
    ];
    const answer = librarySupportRole(stop, passages).outputSchema.parse(reply);
    expect(answer.sentences[0]).toMatchObject({ verdict: 'unsupported', code: 'quote_not_in_cited_passages' });
    expect(answer.quotes).toEqual([[1, 'axis leans by 31 degrees, and the lean points the same way all year']]);
  });
});

describe('the context of a batch', () => {
  it('is the ask check’s two items when the cited passages fit one', () => {
    const sentences = [{ number: 1, text: 'A sentence of a CI fixture.', cites: ['e1'] }];
    const items = librarySupportContext(sentences, [{ handle: 'e1', text: 'A passage of a CI fixture.' }]);
    expect(items.map((item) => item.ref)).toEqual(['support:passages', 'support:sentences']);
    expect(items[0]!.text).toBe('[e1] A passage of a CI fixture.');
  });

  it('shows a batch only the passages its own sentences cite, since a quote may come from no other', () => {
    const passages = [
      { handle: 'e1', text: 'The first passage of a CI fixture.' },
      { handle: 'e2', text: 'The second passage of a CI fixture.' },
      { handle: 'e3', text: 'The third passage of a CI fixture.' },
    ];
    const batch = [
      { number: 11, text: 'A sentence about the first.', cites: ['e1'] },
      { number: 12, text: 'A sentence about the third.', cites: ['e3'] },
    ];
    const items = librarySupportContext(batch, passages);
    expect(items[0]!.text).toBe('[e1] The first passage of a CI fixture.\n[e3] The third passage of a CI fixture.');
    expect(items[0]!.text).not.toContain('e2');
  });

  it('splits the passages of a batch that cites many long ones into items the harness accepts, never in the middle of a passage', () => {
    const passages = Array.from({ length: 60 }, (_, index) => ({
      handle: `e${String(index + 1)}`,
      text: `${'passage '.repeat(70)}number ${String(index + 1)}.`,
    }));
    const answer = [
      { number: 1, text: 'A sentence of a CI fixture.', cites: passages.map((passage) => passage.handle) },
    ];
    const items = librarySupportContext(answer, passages);
    expect(items.length).toBeGreaterThan(2);
    expect(items.at(-1)!.ref).toBe('support:sentences');
    for (const item of items) expect(item.text.length).toBeLessThanOrEqual(MAX_CONTEXT_ITEM_CHARS);
    expect(new Set(items.map((item) => item.ref)).size).toBe(items.length);
    const lines = items.slice(0, -1).flatMap((item) => item.text.split('\n'));
    expect(lines).toEqual(passages.map((passage) => `[${passage.handle}] ${passage.text}`));
  });
});

describe('the bound of a check', () => {
  it('is every batch and the harness’s one repair, and the claim of its job is written out from the reasoning README’s rule', () => {
    expect(LIBRARY_SUPPORT_REQUEST_BOUND).toBe(LIBRARY_SUPPORT_MAX_BATCHES + 1);
    // 11 requests x (300 s request timeout + 20 s of waits) + 180 s for the database steps.
    expect(CHECK_LIBRARY_SUPPORT_CLAIM_SECONDS).toBe(LIBRARY_SUPPORT_REQUEST_BOUND * 320 + 180);
    expect(CHECK_LIBRARY_SUPPORT_CLAIM_SECONDS).toBe(3_700);
  });
});

describe('the version of the check is a hash of what decides its verdicts (D-415)', () => {
  const identity = {
    instructions: LIBRARY_SUPPORT_INSTRUCTIONS,
    rules: LIBRARY_CHECK_RULES,
    policy: LIBRARY_SUPPORT_POLICY,
    sources: readCheckSources(),
  };

  it('is the prefix and eight hex digits, short enough for the harness and the singleton key', () => {
    expect(LIBRARY_SUPPORT_CHECK_VERSION).toMatch(/^library-support-check\.[0-9a-f]{8}$/u);
    expect(LIBRARY_SUPPORT_CHECK_VERSION.length).toBeLessThanOrEqual(32);
  });

  it('is the version of the instructions, rules, policy and code this build holds, the same in every process', () => {
    expect(checkerVersionOf(identity)).toBe(LIBRARY_SUPPORT_CHECK_VERSION);
    expect(checkerVersionOf({ ...identity })).toBe(checkerVersionOf(identity));
  });

  it('changes with the instructions, the rules, the policy or any module whose code decides what the check says', () => {
    const base = checkerVersionOf(identity);
    expect(checkerVersionOf({ ...identity, instructions: `${identity.instructions} Be kinder.` })).not.toBe(base);
    expect(checkerVersionOf({ ...identity, rules: { ...LIBRARY_CHECK_RULES, oneKeyWordAbout: false } })).not.toBe(base);
    expect(checkerVersionOf({ ...identity, policy: { ...LIBRARY_SUPPORT_POLICY, maxUnclear: 1 } })).not.toBe(base);
    identity.sources.forEach((_, index) => {
      const edited = identity.sources.map((source, at) => (at === index ? `${source} const changed = true;` : source));
      expect(checkerVersionOf({ ...identity, sources: edited })).not.toBe(base);
    });
  });

  it('reads the ask check’s shared code the library check reuses, so a change to it is a new version', () => {
    expect(CHECK_SOURCE_MODULES).toContain('../domain/ask-support');
    expect(CHECK_SOURCE_MODULES).toContain('./ask-support');
    const sources = readCheckSources();
    expect(sources).toHaveLength(CHECK_SOURCE_MODULES.length);
    // The judge of each verdict and the grounds of "no fact" are in the text that is hashed.
    expect(sources[0]).toContain('judgeVerdicts');
    expect(sources[0]).toContain('noClaimGround');
    expect(sources[2]).toContain('askSupportInstructions');
    expect(sources.join(' ')).toContain('sentencesOfScroll');
    // A module that is not there is an error, never a version made of less.
    expect(() => readCheckSources(['./not-a-module'])).toThrow('LIBRARY_SUPPORT_SOURCE_MISSING');
  });

  it('does not change for a comment or the layout of a line, and does for the code', () => {
    const code = 'export const limit = 4; // four\nexport function f(a: number) {\n  return a + limit;\n}\n';
    const reworded =
      '/** The limit, reworded. */\nexport const limit = 4;\n\n  // a comment\nexport function f(a: number) { return a + limit; }';
    expect(normalisedSource(reworded)).toBe(normalisedSource(code.replace(' // four', '')));
    expect(normalisedSource(code.replace('a + limit', 'a - limit'))).not.toBe(normalisedSource(code));
  });
});

describe('what a scale, a chart and a fork add to the sentences (D-415, labelled CI fixtures)', () => {
  const { document, provenance } = orrin();
  const evidence = libraryEvidenceOf(provenance);
  const withInteractive = (interactive: unknown): ScrollDocumentV2 => {
    const [first, ...rest] = document.stops;
    if (first === undefined || first.kind !== 'read') throw new Error('CI expected a read stop');
    return { ...document, stops: [{ ...first, interactive } as typeof first, ...rest] };
  };
  const sentencesOf = (doc: ScrollDocumentV2) => {
    const listed = sentencesOfScroll(doc, evidence);
    if (listed.kind !== 'sentences') throw new Error('CI expected sentences');
    return listed.sentences;
  };

  it('reads each point of a scale as the words a reader sees, a label and its figure, against the passages its stop cites', () => {
    const scale = {
      type: 'scale',
      axis: 'linear',
      unit: 'million km',
      points: [
        { label: 'Mercury', value: 58 },
        { label: 'Earth', value: 150 },
        { label: 'Mars', value: 228 },
      ],
      here: 1,
    };
    const points = sentencesOf(withInteractive(scale)).filter((entry) => entry.field === 'point');
    expect(points.map((entry) => entry.text)).toEqual([
      'Mercury: 58 million km',
      'Earth: 150 million km',
      'Mars: 228 million km',
    ]);
    const stopId = document.stops[0]!.id;
    for (const point of points) {
      expect(point.part).toBe(stopId);
      expect(point.cites).toEqual(evidence.handlesOfPart.get(stopId));
    }
  });

  it('reads each point of a chart the same way, and a fork’s prompt and branches, but not a question', () => {
    const chart = {
      type: 'chart',
      shape: 'bars',
      unit: 'degrees',
      points: [
        { label: 'June', value: 31 },
        { label: 'March', value: 20 },
        { label: 'December', value: 4 },
      ],
    };
    const chartPoints = sentencesOf(withInteractive(chart)).filter((entry) => entry.field === 'point');
    expect(chartPoints.map((entry) => entry.text)).toEqual([
      'June: 31 degrees',
      'March: 20 degrees',
      'December: 4 degrees',
    ]);
    const fork = {
      type: 'fork',
      prompt: 'Orrin leans toward its star in June. Which way do you follow it?',
      branches: [
        { label: 'North', text: 'The north gets steep sunlight and long days.' },
        { label: 'South', text: 'The south gets shallow sunlight and short days.' },
      ],
    };
    const forked = sentencesOf(withInteractive(fork));
    expect(
      forked
        .filter((entry) => entry.field === 'prompt' && entry.part === document.stops[0]!.id)
        .map((entry) => entry.text),
    ).toEqual(['Orrin leans toward its star in June.']);
    expect(forked.filter((entry) => entry.field === 'fork').map((entry) => entry.text)).toEqual([
      'The north gets steep sunlight and long days.',
      'The south gets shallow sunlight and short days.',
    ]);
    expect(forked.some((entry) => entry.text.endsWith('?'))).toBe(false);
  });

  it('says what it does not read, in a line that begins "Not covered:", so the verdict is not taken for more than it is', () => {
    expect(NOT_COVERED_LINE.startsWith('Not covered: ')).toBe(true);
    for (const kind of [
      'questions put to the reader',
      'the options of a call',
      'the answer check, D-198',
      'a sort',
      'the misconception',
      'the Ask suggestions',
    ])
      expect(NOT_COVERED_LINE).toContain(kind);
    expect(NOT_COVERED_LINE).toBe(`Not covered: ${NOT_COVERED.join('; ')}.`);
    // A scale's and a chart's points are read now, so they are not listed as left out.
    expect(NOT_COVERED_LINE).not.toContain('figures');
  });
});
