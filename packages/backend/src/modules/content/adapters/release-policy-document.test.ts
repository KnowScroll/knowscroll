import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalSha256, type ScrollDocumentV3 } from '@knowscroll/scroll-model';
import { seedSnapshot } from '../domain/catalogue/seed.js';
import { LIBRARY_SYSTEMS } from '../domain/library/index.js';
import {
  assessRisk,
  categoriesOfText,
  decideAutoRelease,
  proseOf,
  type AutoReleaseFacts,
} from '../domain/release-policy.js';
import { NON_PROSE_KEYS, NON_PROSE_KEYS_V3 } from '../domain/release-sensitive-data.js';
import { policyDocumentOf } from './release-policy-document.js';

const FIXTURES = new URL('../../../../../scroll-model/fixtures/documents/', import.meta.url);

/** One of scroll-model's labelled CI documents (invented, never product content). */
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8')) as unknown;
const v3Names = ['seasons-v3-ci', 'fence-v3-ci', 'broad-street-v3-ci'] as const;

const catalogue = seedSnapshot(LIBRARY_SYSTEMS, canonicalSha256);

/** A clone of the document with `text` put at `path` of its own fields. */
function planted(document: unknown, path: readonly (string | number)[], text: string): unknown {
  const clone = JSON.parse(JSON.stringify(document)) as Record<string | number, unknown>;
  let node = clone;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  node[path.at(-1)!] = text;
  return clone;
}

describe('what the release policy reads of a document v3 (D-435, labelled CI fixtures)', () => {
  it.each(v3Names)('finds %s readable, and its words are every field a reader reads', (name) => {
    const document = fixture(name) as ScrollDocumentV3;
    const read = policyDocumentOf(document);
    expect(read.readable).toBe(true);
    for (const text of [document.kicker, document.title, document.dek, document.takeaway, ...document.askSuggestions])
      expect(read.prose).toContain(text);
    if (document.misconception.kind === 'myth') expect(read.prose).toContain(document.misconception.claim);
    for (const section of document.sections) {
      expect(read.prose).toContain(section.title);
      for (const beat of section.beats) {
        expect(read.prose).toContain(beat.text);
        expect(read.prose).toContain(beat.simple);
        for (const link of beat.links) expect(read.prose).toContain(link.phrase);
        if (beat.kind === 'quote') expect(read.prose).toContain(beat.cite.who);
        if (beat.kind === 'plain' && beat.control !== undefined) expect(read.prose).toContain(beat.control.label);
      }
    }
    for (const aside of document.asides)
      for (const text of [aside.title, aside.text]) expect(read.prose).toContain(text);
    for (const picture of document.pictures) {
      expect(read.prose).toContain(picture.title);
      if (picture.caption !== undefined) expect(read.prose).toContain(picture.caption);
    }
  });

  it('leaves out identity, versions, measures, the hash and every id one part gives another', () => {
    const document = fixture('seasons-v3-ci') as ScrollDocumentV3;
    const { prose } = policyDocumentOf(document);
    for (const technical of [
      document.assetId,
      document.schemaVersion,
      document.explanationUnitId,
      document.integrity.sha256,
      document.limitsVersion,
    ])
      expect(prose).not.toContain(technical);
    // Each reference key holds an id of a part, never words: a sensitive word or a year in one is not read as prose.
    for (const key of [
      'anchorBeat',
      'picture',
      'part',
      'row',
      'column',
      'point',
      'nearest',
      'among',
      'from',
      'to',
      'lit',
      'region',
    ])
      expect(NON_PROSE_KEYS_V3.has(key)).toBe(true);
    // They are not in the list a v1 or v2 document is read with: those documents have keys of the same names that hold words.
    for (const key of ['part', 'from', 'to', 'picture', 'lit']) expect(NON_PROSE_KEYS.has(key)).toBe(false);
    expect(
      proseOf(
        {
          anchorBeat: 'vaccine',
          show: { picture: 'surgery', state: { lit: ['cancer'], region: 'election' } },
          links: [{ phrase: 'a phrase', part: 'poison' }],
          cells: [{ row: 'dose', column: '2030' }],
          marks: [{ point: '2031', label: 'A mark' }],
          regions: [{ nearest: 'court', among: ['war', 'church'] }],
          routes: [{ from: 'virus', to: 'tumour' }],
          control: { kind: 'switch', label: 'Flip it', to: { lit: ['disease'] } },
        },
        NON_PROSE_KEYS_V3,
      ),
    ).toBe('a phrase\nA mark\nswitch\nFlip it');
  });

  it.each([
    ['the kicker', ['kicker'], 'The legal side'],
    ['the title', ['title'], 'Dosage and the seasons'],
    ['the dek', ['dek'], 'A look at the election of a season.'],
    ['the takeaway', ['takeaway'], 'Ask your doctor about it. Then take the medicine your doctor gives you and rest.'],
    ['a section’s title', ['sections', 0, 'title'], 'The court of the seasons'],
    [
      'a beat’s text',
      ['sections', 0, 'beats', 2, 'text'],
      'Take a vaccine in winter. When it is summer in Delhi it is winter in Sydney. One planet, one distance, two opposite seasons at once. Distance cannot do that.',
    ],
    ['a beat’s plainer words', ['sections', 1, 'beats', 0, 'simple'], 'Is it a crime in 2030?'],
    ['an aside', ['asides', 0, 'text'], 'Mind the hazard.'],
    ['a picture’s title', ['pictures', 0, 'title'], 'A weapon drawn'],
    ['an item of a picture', ['pictures', 0, 'items', 0, 'label'], 'Cancer'],
    ['an Ask suggestion', ['askSuggestions', 1], 'Is a divorce legal?'],
    ['the misconception', ['misconception', 'claim'], 'Poison makes winter.'],
  ] as const)('finds a sensitive word in %s', (_name, path, text) => {
    const document = fixture('seasons-v3-ci');
    const read = policyDocumentOf(planted(document, path, text));
    expect(read.readable).toBe(true);
    expect(categoriesOfText(read.prose).length).toBeGreaterThan(0);
  });

  it.each(['seasons-v3-ci', 'fence-v3-ci'])(
    'matches nothing in %s, so a clean document v3 is not held for its words',
    (name) => {
      expect(categoriesOfText(policyDocumentOf(fixture(name)).prose)).toEqual([]);
    },
  );

  it('finds the words of a document v3 about an epidemic: broad-street-v3-ci is about cholera, so it waits for a person', () => {
    expect(categoriesOfText(policyDocumentOf(fixture('broad-street-v3-ci')).prose)).toContain('medicine');
  });

  it('calls a document it cannot judge unreadable: a v1 Scroll, a reel, a damaged v3 and anything else', () => {
    expect(policyDocumentOf(fixture('attention-slowly'))).toEqual({ readable: false, prose: '' });
    const damaged = planted(fixture('seasons-v3-ci'), ['sections'], 'not a list');
    expect(policyDocumentOf(damaged)).toEqual({ readable: false, prose: '' });
    for (const other of [null, {}, 'text', 7, { schemaVersion: 'reel-document.v1' }])
      expect(policyDocumentOf(other)).toEqual({ readable: false, prose: '' });
  });
});

describe('what the release policy reads of a document v2 is as it was (D-418, D-435)', () => {
  /** The scan before D-435: the same walk over the keys the list held then. */
  const BEFORE = new Set([
    'schemaVersion',
    'limitsVersion',
    'assetId',
    'explanationUnitId',
    'id',
    'stop',
    'anchorStop',
    'revealStage',
    'smallPrintAside',
    'measures',
    'integrity',
  ]);
  function proseBefore(value: unknown): string {
    const strings: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'string') strings.push(node);
      else if (Array.isArray(node)) for (const item of node) walk(item);
      else if (typeof node === 'object' && node !== null)
        for (const [key, child] of Object.entries(node)) if (!BEFORE.has(key)) walk(child);
    };
    walk(value);
    return strings.join('\n');
  }

  const v2Names = readdirSync(FIXTURES)
    .map((file) => file.replace(/\.json$/u, ''))
    .filter((name) => !name.includes('v3'));

  it.each(v2Names)('gives %s the same words as before the document v3 keys were added', (name) => {
    const document = fixture(name);
    expect(proseOf(document)).toBe(proseBefore(document));
  });

  it('is why the references of a document v3 are a list of their own: a v1 document has keys of the same names that hold words', () => {
    for (const name of ['attention-slowly', 'spring-neap-tides']) {
      const document = fixture(name);
      expect(proseOf(document, NON_PROSE_KEYS_V3)).not.toBe(proseOf(document));
    }
  });

  it('judges a document v2 readable, with its words', () => {
    const document = fixture('seasons-stage-ci') as { title: string; stops: { simple: string }[] };
    const read = policyDocumentOf(document);
    expect(read.readable).toBe(true);
    expect(read.prose).toContain(document.title);
    expect(read.prose).toBe(proseBefore(document));
  });
});

describe('the policy’s decision for a document v3 (D-435)', () => {
  /** The facts of a document v3 that passes every check, with the words of a real fixture. */
  function factsOfV3(
    overrides: Partial<AutoReleaseFacts> = {},
    document: unknown = fixture('seasons-v3-ci'),
  ): AutoReleaseFacts {
    const read = policyDocumentOf(document);
    return {
      assetStatus: 'held',
      topicId: 'earth.seasons',
      topicApproved: true,
      risk: assessRisk({ catalogue, topicId: 'earth.seasons', text: read.prose, raised: [] }),
      documentReadable: read.readable,
      coverageMapped: true,
      answerCheck: 'passed',
      supportCheck: { kind: 'checked', verdict: 'passed' },
      ...overrides,
    };
  }

  it('releases a document v3 when every check passes, as it releases a v2', () => {
    expect(decideAutoRelease(factsOfV3())).toEqual({ kind: 'release' });
  });

  it('holds a document v3 for one failing check at a time, each with its own code', () => {
    const hold = (facts: AutoReleaseFacts) => decideAutoRelease(facts);
    expect(hold(factsOfV3({ assetStatus: 'admitted' }))).toEqual({ kind: 'hold', reason: 'replaces_served' });
    expect(hold(factsOfV3({ topicId: null }))).toEqual({ kind: 'hold', reason: 'no_topic' });
    expect(hold(factsOfV3({ topicApproved: false }))).toEqual({ kind: 'hold', reason: 'topic_not_approved' });
    expect(hold(factsOfV3({ coverageMapped: false }))).toEqual({ kind: 'hold', reason: 'unmapped' });
    expect(hold(factsOfV3({ answerCheck: 'none' }))).toEqual({ kind: 'hold', reason: 'answer_check_not_passed' });
    expect(hold(factsOfV3({ answerCheck: 'repaired' }))).toEqual({ kind: 'hold', reason: 'answer_check_not_passed' });
    expect(hold(factsOfV3({ supportCheck: { kind: 'none' } }))).toEqual({ kind: 'hold', reason: 'no_support_check' });
    expect(hold(factsOfV3({ supportCheck: { kind: 'stale' } }))).toEqual({
      kind: 'hold',
      reason: 'stale_support_check',
    });
    expect(hold(factsOfV3({ supportCheck: { kind: 'unchecked' } }))).toEqual({
      kind: 'hold',
      reason: 'support_unchecked',
    });
    expect(hold(factsOfV3({ supportCheck: { kind: 'checked', verdict: 'flagged' } }))).toEqual({
      kind: 'hold',
      reason: 'support_flagged',
    });
  });

  it('holds a document v3 that does not parse as unreadable, and one that names a sensitive word as sensitive', () => {
    expect(decideAutoRelease(factsOfV3({}, { schemaVersion: 'scroll-document.v3' }))).toEqual({
      kind: 'hold',
      reason: 'unreadable',
    });
    const dosing = planted(
      fixture('seasons-v3-ci'),
      ['sections', 0, 'beats', 2, 'text'],
      'Take the right dose in winter. When it is summer in Delhi it is winter in Sydney. One planet, one distance, two opposite seasons at once. Distance cannot do that.',
    );
    expect(decideAutoRelease(factsOfV3({}, dosing))).toEqual({ kind: 'hold', reason: 'sensitive' });
    const recent = planted(fixture('seasons-v3-ci'), ['dek'], 'What the sky does in 2030 and after it.');
    expect(decideAutoRelease(factsOfV3({}, recent))).toEqual({ kind: 'hold', reason: 'sensitive' });
  });
});
