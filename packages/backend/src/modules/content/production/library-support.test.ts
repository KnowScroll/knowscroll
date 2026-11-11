import { describe, expect, it } from 'vitest';
import { validateDocumentV2, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { ScrollProvenanceV2 } from '@knowscroll/scroll-model/internal';
import { MAX_CONTEXT_ITEM_CHARS } from '../../../reasoning/public.js';
import { LIBRARY_CHECK_RULES } from '../domain/library-support.js';
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
  libraryEvidenceOf,
  librarySupportContext,
  librarySupportRole,
  sentencesOfScroll,
  underCheck,
  type LibraryEvidence,
} from './library-support.js';
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
  ];

  it('is a role of its own, in the background budget class, with its own version', () => {
    const role = librarySupportRole(sentences, passages, sentences);
    expect(role).toMatchObject({
      id: 'content.library-support-check',
      version: 'library-support-check.v1',
      budgetClass: 'background',
      minContextItems: 2,
    });
    expect(role.id).toBe(LIBRARY_SUPPORT_ROLE_ID);
    expect(role.version).toBe(LIBRARY_SUPPORT_CHECK_VERSION);
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
    expect(LIBRARY_CHECK_RULES).toEqual({ shortNoClaim: false, oneKeyWordAbout: true });
  });

  it('applies the library’s rules to a reply: a short sentence marked as stating no fact is set aside as unclear material, where an ask order’s rule would accept it, and a quote that keeps one key word of a paraphrase is accepted', () => {
    const reply = {
      sentences: [
        { n: 1, verdict: 'no_claim' },
        { n: 2, verdict: 'supported', quote: 'Orrin’s axis leans by 31 degrees' },
      ],
    };
    const library = librarySupportRole(sentences, passages, sentences).outputSchema.parse(reply);
    expect(library.sentences[0]).toMatchObject({ verdict: 'unsupported', code: 'no_claim_without_ground' });
    expect(library.sentences[1]).toMatchObject({ verdict: 'supported' });
    const ask = askOrderCheckerRole(sentences, passages, sentences).outputSchema.parse(reply);
    expect(ask.sentences[0]).toEqual({ number: 1, verdict: 'no_claim' });
    // A paraphrase that keeps one key word of its sentence: strict rules would set it aside, the library's accept it.
    const paraphrase = [{ number: 1, text: 'The tilt of Orrin never changes during the year.', cites: ['e1'] }];
    const kept = { sentences: [{ n: 1, verdict: 'supported', quote: 'the lean points the same way all year' }] };
    expect(librarySupportRole(paraphrase, passages, paraphrase).outputSchema.parse(kept).sentences[0]).toMatchObject({
      verdict: 'supported',
    });
    expect(askSupportRole(paraphrase, passages, paraphrase).outputSchema.parse(kept).sentences[0]).toMatchObject({
      verdict: 'unsupported',
      code: 'quote_not_about_sentence',
    });
  });
});

describe('the context of a batch', () => {
  const sentences = [{ number: 1, text: 'A sentence of a CI fixture.', cites: ['e1'] }];

  it('is the ask check’s two items when the cited passages fit one', () => {
    const items = librarySupportContext(sentences, [{ handle: 'e1', text: 'A passage of a CI fixture.' }], sentences);
    expect(items.map((item) => item.ref)).toEqual(['support:passages', 'support:sentences']);
    expect(items[0]!.text).toBe('[e1] A passage of a CI fixture.');
  });

  it('splits the passages of a Scroll that cites many long ones into items the harness accepts, never in the middle of a passage', () => {
    const passages = Array.from({ length: 60 }, (_, index) => ({
      handle: `e${String(index + 1)}`,
      text: `${'passage '.repeat(70)}number ${String(index + 1)}.`,
    }));
    const answer = [
      { number: 1, text: 'A sentence of a CI fixture.', cites: passages.map((passage) => passage.handle) },
    ];
    const items = librarySupportContext(answer, passages, answer);
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
