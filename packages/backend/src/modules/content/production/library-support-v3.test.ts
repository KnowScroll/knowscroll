import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  beatsOfV3,
  describePicture,
  lightItem,
  parseDocumentV3,
  pickItems,
  scrubPositions,
  type ScrollDocumentV3,
} from '@knowscroll/scroll-model';
import { TAKEAWAY_PART_ID } from '@knowscroll/scroll-model/internal';
import { LIBRARY_FIELDS, LIBRARY_SUPPORT_POLICY } from '../domain/library-support.js';
import { MAX_VERSION_CHARS } from './library-support-version.js';
import {
  CHECK_SOURCE_MODULES,
  checkerVersionOf,
  normalisedSource,
  readCheckSources,
} from './library-support-version.js';
import {
  LIBRARY_SUPPORT_CHECK_VERSION,
  LIBRARY_SUPPORT_MAX_BATCHES,
  underCheck,
  type LibraryEvidence,
} from './library-support.js';
import { LIBRARY_CHECKER_VERSIONS, checkerVersionOfDocument } from './library-support-kinds.js';
import {
  CHECK_SOURCE_MODULES_V3,
  LIBRARY_SUPPORT_V3_BATCH_SENTENCES,
  LIBRARY_SUPPORT_V3_CHECK_VERSION,
  LIBRARY_SUPPORT_V3_INSTRUCTIONS,
  LIBRARY_SUPPORT_V3_VERSION_PREFIX,
  NOT_COVERED_V3,
  librarySupportRoleV3,
  sentencesOfScrollV3,
} from './library-support-v3.js';

/** scroll-model's labelled document v3 CI fixtures (invented, never product content). */
function fixture(name: 'seasons-v3-ci' | 'fence-v3-ci' | 'broad-street-v3-ci'): ScrollDocumentV3 {
  const stored = JSON.parse(
    readFileSync(new URL(`../../../../../scroll-model/fixtures/documents/${name}.json`, import.meta.url), 'utf8'),
  ) as unknown;
  const parsed = parseDocumentV3(stored);
  if (parsed.kind !== 'valid') throw new Error('CI expected a valid fixture');
  return parsed.document;
}

/**
 * The evidence of a document as its provenance gives it: each beat, aside and picture and the takeaway cite their own passage (`e1`, `e2` and so on, in
 * the order the parts are listed), so a sentence's cites say which part it stands under.
 */
function evidenceOf(document: ScrollDocumentV3, without: readonly string[] = []): LibraryEvidence {
  const parts = [
    ...beatsOfV3({ sections: document.sections }).map((beat) => beat.id),
    ...document.asides.map((aside) => aside.id),
    ...document.pictures.map((picture) => picture.id),
    TAKEAWAY_PART_ID,
  ];
  const handlesOfPart = new Map(
    parts.flatMap((part, index) => (without.includes(part) ? [] : [[part, [`e${String(index + 1)}`]] as const])),
  );
  return {
    passages: parts.map((part, index) => ({ handle: `e${String(index + 1)}`, text: `A passage for ${part}.` })),
    handlesOfPart,
    cited: [...new Set([...handlesOfPart.values()].flat())],
  };
}

const names = ['seasons-v3-ci', 'fence-v3-ci', 'broad-street-v3-ci'] as const;

describe('the sentences of a document v3 Scroll that the support check reads (D-435, labelled CI fixtures)', () => {
  it.each(names)('lists %s in reading order: the title and the dek first, the takeaway last', (name) => {
    const document = fixture(name);
    const listed = sentencesOfScrollV3(document, evidenceOf(document));
    if (listed.kind !== 'sentences') throw new Error('CI expected sentences');
    const { sentences } = listed;
    expect(sentences.map((sentence) => sentence.number)).toEqual(sentences.map((_, index) => index + 1));
    expect(sentences[0]).toMatchObject({ part: 'title', field: 'title', label: true, text: document.title });
    expect(sentences[1]).toMatchObject({ part: 'dek', field: 'dek' });
    expect(sentences.at(-1)).toMatchObject({ part: TAKEAWAY_PART_ID, field: 'caption' });
    const beatOrder = beatsOfV3(document).map((beat) => sentences.findIndex((sentence) => sentence.part === beat.id));
    expect(beatOrder).toEqual([...beatOrder].sort((a, b) => a - b));
  });

  it.each(names)(
    'reads every beat’s paragraph and plainer words, each section’s title and the whole takeaway in %s',
    (name) => {
      const document = fixture(name);
      const listed = sentencesOfScrollV3(document, evidenceOf(document));
      if (listed.kind !== 'sentences') throw new Error('CI expected sentences');
      const joined = (part: string, field: string) =>
        listed.sentences
          .filter((sentence) => sentence.part === part && sentence.field === field)
          .map((sentence) => sentence.text)
          .join(' ');
      for (const section of document.sections) {
        expect(listed.sentences.find((sentence) => sentence.part === section.id)).toMatchObject({
          field: 'heading',
          label: true,
          text: section.title,
        });
        for (const beat of section.beats) {
          // A question put to the reader is no claim of the Scroll's own, so what is read is the text less its questions.
          const words = (text: string) => text.replaceAll(/[^\p{L}\p{N}]+/gu, '');
          const field = beat.kind === 'quote' ? 'line' : 'paragraph';
          if (!beat.text.includes('?')) expect(words(joined(beat.id, field))).toBe(words(beat.text));
          if (!beat.simple.includes('?')) expect(words(joined(beat.id, 'simple'))).toBe(words(beat.simple));
        }
      }
      expect(
        listed.sentences
          .filter((sentence) => sentence.part === TAKEAWAY_PART_ID)
          .map((s) => s.text)
          .join(' '),
      ).toBe(document.takeaway.replaceAll(/\s+/gu, ' '));
    },
  );

  it('lists a quotation as a line and says nothing of who it is credited to', () => {
    const document = fixture('fence-v3-ci');
    const quote = beatsOfV3(document).find((beat) => beat.kind === 'quote');
    if (quote?.kind !== 'quote') throw new Error('CI expected a quote beat');
    const listed = sentencesOfScrollV3(document, evidenceOf(document));
    if (listed.kind !== 'sentences') throw new Error('CI expected sentences');
    expect(listed.sentences.some((sentence) => sentence.part === quote.id && sentence.field === 'line')).toBe(true);
    // The credit (who, where and when) is shown beside the quotation but is not a sentence of the Scroll's own to check.
    expect(listed.sentences.map((sentence) => sentence.text)).not.toContain(quote.cite.who);
  });

  it('puts each aside after the beat it sits beside, with the aside’s own passages', () => {
    const document = fixture('seasons-v3-ci');
    const evidence = evidenceOf(document);
    const listed = sentencesOfScrollV3(document, evidence);
    if (listed.kind !== 'sentences') throw new Error('CI expected sentences');
    for (const aside of document.asides) {
      const anchored = listed.sentences.findIndex((sentence) => sentence.part === aside.anchorBeat);
      const title = listed.sentences.findIndex((sentence) => sentence.part === aside.id);
      expect(title).toBeGreaterThan(anchored);
      expect(listed.sentences[title]).toMatchObject({
        field: 'aside-title',
        label: true,
        cites: evidence.handlesOfPart.get(aside.id),
      });
      expect(listed.sentences.some((sentence) => sentence.part === aside.id && sentence.field === 'aside-text')).toBe(
        true,
      );
    }
  });

  it.each(names)(
    'gives each sentence the passages its own part cites, the title and the dek everything the Scroll cites, in %s',
    (name) => {
      const document = fixture(name);
      const evidence = evidenceOf(document);
      const listed = sentencesOfScrollV3(document, evidence);
      if (listed.kind !== 'sentences') throw new Error('CI expected sentences');
      for (const sentence of listed.sentences.filter((entry) => entry.part === 'title' || entry.part === 'dek'))
        expect(sentence.cites).toEqual(evidence.cited);
      for (const sentence of listed.sentences.filter((entry) => entry.part !== 'title' && entry.part !== 'dek')) {
        expect(sentence.cites.length).toBeGreaterThan(0);
        if (sentence.field === 'heading') continue;
        expect(sentence.cites).toEqual(evidence.handlesOfPart.get(sentence.part));
      }
      // A section's title rests on the passages its beats rest on and no others.
      for (const section of document.sections)
        expect(listed.sentences.find((sentence) => sentence.part === section.id)!.cites).toEqual([
          ...new Set(section.beats.flatMap((beat) => evidence.handlesOfPart.get(beat.id) ?? [])),
        ]);
    },
  );

  it.each(names)(
    'reads the words of each picture in every state a reader can see it in, once each, against the picture’s own passages, in %s',
    (name) => {
      const document = fixture(name);
      const evidence = evidenceOf(document);
      const listed = sentencesOfScrollV3(document, evidence);
      if (listed.kind !== 'sentences') throw new Error('CI expected sentences');
      for (const picture of document.pictures) {
        const words = listed.sentences.filter((sentence) => sentence.part === picture.id);
        expect(words.length).toBeGreaterThan(0);
        for (const sentence of words) {
          expect(sentence.field).toBe('point');
          expect(sentence.cites).toEqual(evidence.handlesOfPart.get(picture.id));
        }
        const texts = words.map((sentence) => sentence.text);
        expect(new Set(texts).size).toBe(texts.length);
        // Each state a beat shows the picture in is in the words.
        for (const beat of beatsOfV3(document)) {
          if (beat.show?.picture !== picture.id) continue;
          const described = describePicture(picture, beat.show.state);
          for (const sentence of described.split(/(?<=\.)\s+/u))
            expect(joinedOf(texts)).toContain(sentence.trim().slice(0, 20));
        }
      }
    },
  );

  it('reads the states a scrub, a pick and a switch lead to as well as the state the beat shows', () => {
    const seasons = fixture('seasons-v3-ci');
    const evidence = evidenceOf(seasons);
    const listed = sentencesOfScrollV3(seasons, evidence);
    if (listed.kind !== 'sentences') throw new Error('CI expected sentences');
    const wordsOf = (pictureId: string) =>
      listed.sentences.filter((sentence) => sentence.part === pictureId).map((sentence) => sentence.text);
    const scrub = beatsOfV3(seasons).find((beat) => beat.kind === 'plain' && beat.control?.kind === 'scrub');
    const pick = beatsOfV3(seasons).find((beat) => beat.kind === 'plain' && beat.control?.kind === 'pick');
    if (scrub?.kind !== 'plain' || scrub.control?.kind !== 'scrub' || scrub.show === undefined)
      throw new Error('CI expected a scrub');
    if (pick?.show === undefined) throw new Error('CI expected a pick');
    const scrubbed = seasons.pictures.find((picture) => picture.id === scrub.show!.picture)!;
    const stops = scrubPositions(scrubbed, scrub.show.state, scrub.control.along);
    expect(stops.length).toBeGreaterThan(1);
    for (const stop of stops) {
      const lit = describePicture(scrubbed, stop.state).split('Standing out: ')[1]?.split('.')[0];
      if (lit !== undefined) expect(wordsOf(scrubbed.id).join(' ')).toContain(lit);
    }
    const picked = seasons.pictures.find((picture) => picture.id === pick.show!.picture)!;
    for (const item of pickItems(picked)) expect(wordsOf(picked.id).join(' ')).toContain(item.note!.split('.')[0]!);

    const broad = fixture('broad-street-v3-ci');
    const flip = beatsOfV3(broad).find((beat) => beat.kind === 'plain' && beat.control?.kind === 'switch');
    if (flip?.kind !== 'plain' || flip.control?.kind !== 'switch' || flip.show === undefined)
      throw new Error('CI expected a switch');
    const flipped = broad.pictures.find((picture) => picture.id === flip.show!.picture)!;
    const flipListed = sentencesOfScrollV3(broad, evidenceOf(broad));
    if (flipListed.kind !== 'sentences') throw new Error('CI expected sentences');
    const flippedWords = flipListed.sentences
      .filter((sentence) => sentence.part === flipped.id)
      .map((sentence) => sentence.text);
    for (const sentence of describePicture(flipped, flip.control.to).split(/(?<=\.)\s+/u))
      expect(flippedWords.join(' ')).toContain(sentence.trim().slice(0, 20));
  });

  it('reads the words of a pick item the beat has not revealed yet, as the reader sees them once the item is chosen (D-438)', () => {
    const seasons = structuredClone(fixture('seasons-v3-ci'));
    const beats = seasons.sections.flatMap((section) => section.beats);
    const pick = beats.find((beat) => beat.kind === 'plain' && beat.control?.kind === 'pick');
    if (pick?.show === undefined) throw new Error('CI expected a pick');
    const picked = seasons.pictures.find((picture) => picture.id === pick.show!.picture)!;
    // No other beat lights an item of this picture, so only the pick can give the words of a lit item.
    for (const beat of beats) if (beat !== pick && beat.show?.picture === picked.id) beat.show.state = {};
    // The beat has revealed only the first point; choosing a later item reveals that item too.
    pick.show.state = { upTo: 1 };
    const listed = sentencesOfScrollV3(seasons, evidenceOf(seasons));
    if (listed.kind !== 'sentences') throw new Error('CI expected sentences');
    const words = listed.sentences.filter((sentence) => sentence.part === picked.id).map((sentence) => sentence.text);
    const items = pickItems(picked);
    expect(items.length).toBeGreaterThan(2);
    for (const item of items) {
      // "Standing out: Mars." is only in the words of a state that has revealed Mars and lit it.
      expect(words).toContain(`Standing out: ${item.label}.`);
      expect(describePicture(picked, lightItem(picked, { upTo: 1 }, item.id))).toContain(
        `Standing out: ${item.label}.`,
      );
    }
  });

  it('refuses, and sends no request, when a beat, an aside, a picture or the takeaway rests on no passage', () => {
    const document = fixture('seasons-v3-ci');
    for (const part of [beatsOfV3(document)[3]!.id, document.asides[0]!.id, document.pictures[0]!.id, TAKEAWAY_PART_ID])
      expect(sentencesOfScrollV3(document, evidenceOf(document, [part]))).toEqual({
        kind: 'refused',
        code: 'citations_missing',
      });
  });

  it('stores only fields the library’s result schema knows, so a stored v3 result reads back', () => {
    for (const name of names) {
      const document = fixture(name);
      const listed = sentencesOfScrollV3(document, evidenceOf(document));
      if (listed.kind !== 'sentences') throw new Error('CI expected sentences');
      for (const sentence of listed.sentences) expect(LIBRARY_FIELDS).toContain(sentence.field);
      for (const sentence of listed.sentences) expect(sentence.part.length).toBeLessThanOrEqual(64);
    }
  });

  it('leaves out the questions put to the reader, the misconception, the kicker, the labels of controls and the Ask suggestions', () => {
    for (const name of names) {
      const document = fixture(name);
      const listed = sentencesOfScrollV3(document, evidenceOf(document));
      if (listed.kind !== 'sentences') throw new Error('CI expected sentences');
      const texts = listed.sentences.map((sentence) => sentence.text);
      expect(texts.filter((text) => text.endsWith('?'))).toEqual([]);
      for (const suggestion of document.askSuggestions) expect(texts).not.toContain(suggestion);
      expect(texts).not.toContain(document.kicker);
      if (document.misconception.kind === 'myth') expect(texts).not.toContain(document.misconception.claim);
      for (const beat of beatsOfV3(document))
        if (beat.kind === 'plain' && beat.control !== undefined) expect(texts).not.toContain(beat.control.label);
    }
    expect(NOT_COVERED_V3.length).toBeGreaterThan(0);
  });

  it.each(names)('comes to a number of sentences one check can take: %s fits the bound of ten batches', (name) => {
    const document = fixture(name);
    const listed = sentencesOfScrollV3(document, evidenceOf(document));
    if (listed.kind !== 'sentences') throw new Error('CI expected sentences');
    expect(listed.sentences.length).toBeGreaterThan(80);
    expect(listed.sentences.length).toBeLessThanOrEqual(
      LIBRARY_SUPPORT_MAX_BATCHES * LIBRARY_SUPPORT_V3_BATCH_SENTENCES,
    );
  });

  it('is deterministic and is shown to the checker without where a sentence stands', () => {
    const document = fixture('seasons-v3-ci');
    const first = sentencesOfScrollV3(document, evidenceOf(document));
    expect(sentencesOfScrollV3(document, evidenceOf(document))).toEqual(first);
    if (first.kind !== 'sentences') throw new Error('CI expected sentences');
    for (const shown of underCheck(first.sentences)) {
      expect(shown).not.toHaveProperty('part');
      expect(shown).not.toHaveProperty('field');
    }
  });
});

const joinedOf = (texts: readonly string[]): string => texts.join(' ');

describe('the version of the v3 support check (D-435)', () => {
  it('is its own prefix and eight hex digits, short enough for the harness, and not the v2 check’s', () => {
    expect(LIBRARY_SUPPORT_V3_VERSION_PREFIX).toBe('support-check-v3.');
    expect(LIBRARY_SUPPORT_V3_CHECK_VERSION).toMatch(/^support-check-v3\.[0-9a-f]{8}$/u);
    expect(LIBRARY_SUPPORT_V3_CHECK_VERSION.length).toBeLessThanOrEqual(MAX_VERSION_CHARS);
    // The harness accepts a role or policy version of this pattern and no other.
    expect(LIBRARY_SUPPORT_V3_CHECK_VERSION).toMatch(/^[A-Za-z0-9._-]{1,32}$/u);
    expect(LIBRARY_SUPPORT_V3_CHECK_VERSION).not.toBe(LIBRARY_SUPPORT_CHECK_VERSION);
    expect(LIBRARY_SUPPORT_CHECK_VERSION).toMatch(/^library-support-check\.[0-9a-f]{8}$/u);
  });

  it('refuses a prefix that would pass the harness’s limit', () => {
    const identity = { instructions: '', rules: {}, policy: LIBRARY_SUPPORT_POLICY, sources: [] };
    expect(() => checkerVersionOf(identity, 'a'.repeat(25))).toThrow('LIBRARY_SUPPORT_VERSION_PREFIX_TOO_LONG');
    expect(checkerVersionOf(identity, 'a'.repeat(24)).length).toBe(MAX_VERSION_CHARS);
  });

  it('leaves the v2 check’s modules as they were: no v3 module is among them, so a stored v2 result stays current', () => {
    expect(CHECK_SOURCE_MODULES).toEqual([
      '../domain/ask-support',
      '../domain/library-support',
      './ask-support',
      './library-support',
      './library-support-step',
    ]);
    for (const module of CHECK_SOURCE_MODULES) expect(module).not.toMatch(/v3|kinds|check$/u);
    // The v2 version is the hash of exactly those modules, and the v3 modules are not hashed into it.
    expect(readCheckSources()).toHaveLength(CHECK_SOURCE_MODULES.length);
  });

  it('is a hash of the v3 check’s own modules: the v2 check’s shared code and its own two, not the v2 step', () => {
    expect(CHECK_SOURCE_MODULES_V3).toEqual([
      '../domain/ask-support',
      '../domain/library-support',
      './ask-support',
      './library-support',
      './library-support-v3',
      './library-support-v3-step',
    ]);
    const sources = readCheckSources(CHECK_SOURCE_MODULES_V3);
    expect(sources).toHaveLength(CHECK_SOURCE_MODULES_V3.length);
    const version = (changed: readonly string[]) =>
      checkerVersionOf(
        {
          instructions: LIBRARY_SUPPORT_V3_INSTRUCTIONS,
          rules: { same: true },
          policy: LIBRARY_SUPPORT_POLICY,
          sources: changed,
        },
        LIBRARY_SUPPORT_V3_VERSION_PREFIX,
      );
    expect(version(sources)).toBe(version(sources));
    // A change to the v3 sentences' module is a new version; rewording a comment in it is not.
    const edited = [...sources];
    edited[4] = `${edited[4]!} const changed = 1;`;
    expect(version(edited)).not.toBe(version(sources));
    expect(normalisedSource('// a comment\nconst a = 1; /* another */')).toBe(normalisedSource('const a = 1;'));
  });

  it('is told apart by document: a v2 document is read by the v2 check, a v3 by the v3 check, anything else by neither', () => {
    expect(LIBRARY_CHECKER_VERSIONS).toEqual({
      v2: LIBRARY_SUPPORT_CHECK_VERSION,
      v3: LIBRARY_SUPPORT_V3_CHECK_VERSION,
    });
    expect(checkerVersionOfDocument('scroll-document.v2')).toBe(LIBRARY_SUPPORT_CHECK_VERSION);
    expect(checkerVersionOfDocument('scroll-document.v3')).toBe(LIBRARY_SUPPORT_V3_CHECK_VERSION);
    expect(checkerVersionOfDocument('scroll-document.v1')).toBeUndefined();
    expect(checkerVersionOfDocument('reel-document.v1')).toBeUndefined();
  });

  it('asks the library checker’s role, in the background, under the v3 version and its own instructions', () => {
    const role = librarySupportRoleV3(
      [{ number: 1, text: 'A sentence.', cites: ['e1'] }],
      [{ handle: 'e1', text: 'A passage.' }],
    );
    expect(role).toMatchObject({
      id: 'content.library-support-check',
      version: LIBRARY_SUPPORT_V3_CHECK_VERSION,
      instructions: LIBRARY_SUPPORT_V3_INSTRUCTIONS,
      budgetClass: 'background',
    });
    expect(LIBRARY_SUPPORT_V3_INSTRUCTIONS).toContain('picture');
  });
});
