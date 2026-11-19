import { describe, expect, it } from 'vitest';
import type { Claim, ProductionRecord, Source } from '../../internal/provenance.js';
import { ScrollProvenanceV3, TAKEAWAY_PART_ID } from '../../internal/provenance-v3.js';
import { validDocumentV3 } from '../../test-support/v3-fixtures.js';
import { beatsOfV3, type ScrollDocumentV3 } from '../../v3/document.js';
import type { IssueV3 } from '../../v3/issues.js';
import { computeMeasuresV3 } from '../../v3/measures.js';
import { computeIntegrityV3, validateDocumentV3 } from '../../v3/validate.js';
import {
  compileEditorialV3,
  SCROLL_AUTHORING_V3_VERSION,
  type AuthoredBeatV3,
  type AuthoredScrollV3,
  type EditorialV3Outcome,
  type EditorialV3Stage,
} from './editorial.js';

/*
 * The authored Scroll is the kettle fixture (`validDocumentV3`) turned back into what a person writes: no ids, no
 * measures, no hash, asides named by the number of their beat, and every beat, aside, picture and the takeaway citing
 * claims. The layout the paths below rely on (beats counted from 0 in reading order across both sections):
 *   beats 0..9 = beat-1..beat-10; beat 3 (beat-4) shows nothing and links nothing, so a test may replace it freely
 *   pictures 0 flow 'kettle-steps', cites c-heat; pictures 1 statement 'boil-point' (part 'value'), cites c-boil
 *   asides 0 limits beside beat 5, cites c-steam; asides 1 definition beside beat 3, cites c-heat
 * Only c-boil holds a figure (100), the one figure the fixture's texts use (the 100°C of 'boil-point').
 */

const HEAT = 'The element of a kettle turns the electric current that passes through it into heat.';
const BOIL = 'Pure water boils at 100 degrees Celsius at standard sea level pressure.';
const STEAM = 'Many kettles switch themselves off when a bimetallic strip senses steam.';

const claim = (claimId: string, quote: string, sourceId: string): Claim => ({
  claimId,
  statement: quote,
  quote,
  sourceId,
  truthState: 'documented',
});
const source = (sourceId: string): Source => ({
  sourceId,
  title: `A fictional source called ${sourceId}`,
  url: `https://example.test/${sourceId}`,
  snapshotSha256: 'a'.repeat(64),
  retrievedAt: '2026-11-01T00:00:00.000Z',
});

const PUBLICATION = {
  assetId: 'fixture-kettle',
  revision: 1,
  language: 'en',
  explanationUnitId: 'fixture-kettle-unit',
} as const;
const PRODUCTION: ProductionRecord = { kind: 'fixture', label: 'editorial v3 unit test' };

interface Case {
  authored: AuthoredScrollV3;
  claims: Claim[];
  sources: Source[];
}

function authoredFrom(document: ScrollDocumentV3): AuthoredScrollV3 {
  const numberOf = new Map(beatsOfV3(document).map((beat, index) => [beat.id, index + 1]));
  const citedBy = (beatId: string): string[] => (beatId === 'beat-9' ? ['c-steam'] : ['c-heat']);
  const pictureCites: Record<string, string[]> = { 'kettle-steps': ['c-heat'], 'boil-point': ['c-boil'] };
  const asideCites: Record<string, string[]> = { 'aside-limits': ['c-steam'], 'aside-term': ['c-heat'] };
  return {
    schemaVersion: SCROLL_AUTHORING_V3_VERSION,
    theme: document.theme,
    kicker: document.kicker,
    title: document.title,
    dek: document.dek,
    shape: document.shape,
    framing: document.framing,
    misconception: document.misconception,
    pictures: document.pictures.map((picture) => ({ picture, cites: pictureCites[picture.id] ?? ['c-heat'] })),
    sections: document.sections.map((section) => ({
      title: section.title,
      beats: section.beats.map((beat): AuthoredBeatV3 => {
        const { id, ...own } = beat;
        return { ...own, cites: citedBy(id) };
      }),
    })),
    asides: document.asides.map((aside) => ({
      kind: aside.kind,
      title: aside.title,
      text: aside.text,
      beat: numberOf.get(aside.anchorBeat) ?? 1,
      collapsed: aside.collapsed,
      cites: asideCites[aside.id] ?? ['c-heat'],
    })),
    takeaway: { text: document.takeaway, cites: ['c-heat', 'c-boil'] },
    askSuggestions: document.askSuggestions,
  };
}

/** A valid case, plus one claim and one source that nothing cites. */
function baseCase(): Case {
  return {
    authored: authoredFrom(validDocumentV3()),
    claims: [
      claim('c-heat', HEAT, 'src-a'),
      claim('c-boil', BOIL, 'src-b'),
      claim('c-steam', STEAM, 'src-a'),
      claim('c-spare', 'A passage that no part of the Scroll cites.', 'src-spare'),
    ],
    sources: [source('src-a'), source('src-b'), source('src-spare')],
  };
}

function compile(change: (draft: Case) => void = () => undefined): EditorialV3Outcome {
  const draft = baseCase();
  change(draft);
  return compileEditorialV3({
    authored: draft.authored,
    publication: PUBLICATION,
    claims: draft.claims,
    sources: draft.sources,
    production: PRODUCTION,
  });
}

function compiled(change?: (draft: Case) => void) {
  const outcome = compile(change);
  if (outcome.kind !== 'compiled') throw new Error(`refused at ${outcome.stage}: ${JSON.stringify(outcome.issues)}`);
  return outcome;
}

function refused(change: (draft: Case) => void): { stage: EditorialV3Stage; issues: readonly IssueV3[] } {
  const outcome = compile(change);
  if (outcome.kind !== 'refused') throw new Error('expected a refusal');
  return { stage: outcome.stage, issues: outcome.issues };
}

/** The beat at `index` of the whole Scroll, counted from 0 in reading order. */
function beatAt(draft: Case, index: number): AuthoredBeatV3 {
  const beat = draft.authored.sections.flatMap((section) => section.beats)[index];
  if (beat === undefined) throw new Error(`no beat ${index}`);
  return beat;
}

/** Puts `beat` in place of the beat at `index`. */
function replaceBeat(draft: Case, index: number, beat: AuthoredBeatV3): void {
  let seen = 0;
  for (const section of draft.authored.sections) {
    if (index < seen + section.beats.length) {
      section.beats[index - seen] = beat;
      return;
    }
    seen += section.beats.length;
  }
  throw new Error(`no beat ${index}`);
}

const quoteBeat = (text: string, cites: string[]): AuthoredBeatV3 => ({
  kind: 'quote',
  text,
  simple: 'A plainer way to read the quotation above.',
  links: [],
  cite: { who: 'A. Writer', work: 'Notes on kettles' },
  cites,
});

function setBeatText(draft: Case, index: number, change: (text: string) => string): void {
  const beat = beatAt(draft, index);
  beat.text = change(beat.text);
}

function claimOf(draft: Case, claimId: string): Claim {
  const found = draft.claims.find((candidate) => candidate.claimId === claimId);
  if (found === undefined) throw new Error(`no claim ${claimId}`);
  return found;
}

function setQuote(draft: Case, claimId: string, quote: string): void {
  const claim = claimOf(draft, claimId);
  claim.quote = quote;
  claim.statement = quote;
}

describe('compileEditorialV3: a Scroll that compiles', () => {
  it('assigns section, beat and aside ids in reading order', () => {
    const { document } = compiled();
    expect(document.sections.map((section) => section.id)).toEqual(['s1', 's2']);
    expect(beatsOfV3(document).map((beat) => beat.id)).toEqual([
      'b1',
      'b2',
      'b3',
      'b4',
      'b5',
      'b6',
      'b7',
      'b8',
      'b9',
      'b10',
    ]);
    expect(document.asides.map((aside) => aside.id)).toEqual(['a1', 'a2']);
  });

  it('puts each aside beside the beat its number names', () => {
    const { document } = compiled();
    expect(document.asides.map((aside) => aside.anchorBeat)).toEqual(['b5', 'b3']);
  });

  it('carries over what the writer wrote and nothing the writer did not', () => {
    const { document } = compiled();
    const fixture = validDocumentV3();
    expect(document.pictures).toEqual(fixture.pictures);
    expect(document.title).toBe(fixture.title);
    expect(document.takeaway).toBe(fixture.takeaway);
    expect(JSON.stringify(document)).not.toContain('cites');
    expect(document.assetId).toBe(PUBLICATION.assetId);
    expect(document.explanationUnitId).toBe(PUBLICATION.explanationUnitId);
    expect(document.series).toBeUndefined();
  });

  it('sets measures and a hash that the validator recomputes and accepts', () => {
    const { document } = compiled();
    expect(computeMeasuresV3(document)).toEqual(document.measures);
    expect(computeIntegrityV3(document)).toBe(document.integrity.sha256);
    expect(validateDocumentV3(JSON.parse(JSON.stringify(document)) as unknown)).toMatchObject({ kind: 'valid' });
  });

  it('records a citation for every beat, aside, picture and the takeaway', () => {
    const { provenance } = compiled();
    expect(ScrollProvenanceV3.safeParse(provenance).success).toBe(true);
    const parts = provenance.citations.map((entry) => entry.partId);
    expect(parts).toEqual([
      'b1',
      'b2',
      'b3',
      'b4',
      'b5',
      'b6',
      'b7',
      'b8',
      'b9',
      'b10',
      'a1',
      'a2',
      'kettle-steps',
      'boil-point',
      TAKEAWAY_PART_ID,
    ]);
    expect(provenance.citations.every((entry) => entry.claimIds.length > 0)).toBe(true);
    const byPart = new Map(provenance.citations.map((entry) => [entry.partId, entry.claimIds]));
    expect(byPart.get('b9')).toEqual(['c-steam']);
    expect(byPart.get('a1')).toEqual(['c-steam']);
    expect(byPart.get('boil-point')).toEqual(['c-boil']);
    expect(byPart.get(TAKEAWAY_PART_ID)).toEqual(['c-heat', 'c-boil']);
  });

  it('names a claim once where a part cites it twice', () => {
    const { provenance } = compiled((draft) => {
      beatAt(draft, 0).cites = ['c-heat', 'c-heat'];
    });
    expect(provenance.citations.find((entry) => entry.partId === 'b1')?.claimIds).toEqual(['c-heat']);
  });

  it('ties the provenance to the document and the publication', () => {
    const { document, provenance } = compiled();
    expect(provenance.documentSha256).toBe(document.integrity.sha256);
    expect(provenance.assetId).toBe(PUBLICATION.assetId);
    expect(provenance.revision).toBe(PUBLICATION.revision);
    expect(provenance.production).toEqual(PRODUCTION);
    expect(provenance.checks).toEqual([
      { name: 'evidence', version: 'scroll-checks-v3.v1', verdict: 'pass', reasonCodes: [] },
    ]);
  });

  it('keeps only the claims and the sources the Scroll cites', () => {
    const { provenance } = compiled();
    expect(provenance.claims.map((entry) => entry.claimId)).toEqual(['c-heat', 'c-boil', 'c-steam']);
    expect(provenance.sources.map((entry) => entry.sourceId)).toEqual(['src-a', 'src-b']);
  });

  it('drops a claim once nothing cites it, and its source with it', () => {
    const { provenance } = compiled((draft) => {
      beatAt(draft, 8).cites = ['c-heat'];
      const aside = draft.authored.asides[0];
      if (aside !== undefined) aside.cites = ['c-heat'];
    });
    expect(provenance.claims.map((entry) => entry.claimId)).toEqual(['c-heat', 'c-boil']);
    expect(provenance.sources.map((entry) => entry.sourceId)).toEqual(['src-a', 'src-b']);
  });

  it('compiles the same input to the same bytes, so a repeated import changes nothing', () => {
    const first = compiled();
    const second = compiled();
    expect(second.document.integrity.sha256).toBe(first.document.integrity.sha256);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('gives another hash to another text', () => {
    const first = compiled();
    const second = compiled((draft) => {
      draft.authored.askSuggestions = ['Why does a kettle click when it is done?'];
    });
    expect(second.document.integrity.sha256).not.toBe(first.document.integrity.sha256);
  });

  it('accepts a figure written with or without a thousands separator', () => {
    compiled((draft) => {
      setQuote(draft, 'c-heat', `${HEAT} A common kettle draws about 1,000 watts.`);
      setBeatText(draft, 1, (text) => `${text} It draws 1000 watts.`);
    });
  });

  it('accepts a figure the header uses when some cited passage holds it', () => {
    compiled((draft) => {
      draft.authored.dek = 'Heat goes in at the bottom, and the water boils at 100 degrees.';
    });
  });
});

describe('compileEditorialV3: stage authoring', () => {
  const stageOf = (change: (draft: Case) => void) => {
    const result = refused(change);
    expect(result.issues.length).toBeGreaterThan(0);
    return result.stage;
  };

  it('refuses something that is not an object', () => {
    const outcome = compileEditorialV3({
      authored: null,
      publication: PUBLICATION,
      claims: [],
      sources: [],
      production: PRODUCTION,
    });
    expect(outcome).toMatchObject({ kind: 'refused', stage: 'authoring' });
  });

  it('refuses a schema version that is not scroll-authoring.v3', () => {
    expect(
      stageOf((draft) => {
        (draft.authored as { schemaVersion: string }).schemaVersion = 'scroll-authoring.v2';
      }),
    ).toBe('authoring');
  });

  it('refuses a beat that cites nothing', () => {
    expect(
      stageOf((draft) => {
        beatAt(draft, 0).cites = [];
      }),
    ).toBe('authoring');
  });

  it('refuses a beat without its cites', () => {
    expect(
      stageOf((draft) => {
        delete (beatAt(draft, 0) as { cites?: string[] }).cites;
      }),
    ).toBe('authoring');
  });

  it('refuses a field it does not know, such as an id the writer must not set', () => {
    expect(
      stageOf((draft) => {
        (beatAt(draft, 0) as unknown as { id: string }).id = 'b1';
      }),
    ).toBe('authoring');
  });

  it('refuses an aside that is not placed by a beat number', () => {
    expect(
      stageOf((draft) => {
        const aside = draft.authored.asides[0];
        if (aside !== undefined) (aside as { beat: unknown }).beat = 'b5';
      }),
    ).toBe('authoring');
  });

  it('refuses a section with a single beat', () => {
    expect(
      stageOf((draft) => {
        const first = draft.authored.sections[0];
        if (first !== undefined) first.beats = first.beats.slice(0, 1);
      }),
    ).toBe('authoring');
  });

  it('is judged before the evidence: a bad shape with an unknown cite stops at the shape', () => {
    const result = refused((draft) => {
      beatAt(draft, 0).cites = ['c-missing'];
      draft.authored.askSuggestions = [];
    });
    expect(result.stage).toBe('authoring');
  });
});

describe('compileEditorialV3: stage evidence', () => {
  describe('authoring_cite_unknown', () => {
    it('names the beat that cites a claim nobody wrote', () => {
      const result = refused((draft) => {
        beatAt(draft, 2).cites = ['c-heat', 'c-missing'];
      });
      expect(result).toEqual({ stage: 'evidence', issues: [{ code: 'authoring_cite_unknown', path: 'beats.2' }] });
    });

    it.each([
      ['an aside', (draft: Case) => (draft.authored.asides[1]!.cites = ['c-missing']), 'asides.1'],
      ['a picture', (draft: Case) => (draft.authored.pictures[0]!.cites = ['c-missing']), 'pictures.0'],
      ['the takeaway', (draft: Case) => (draft.authored.takeaway.cites = ['c-missing']), 'takeaway'],
    ])('names %s that cites a claim nobody wrote', (_name, change, path) => {
      const result = refused(change);
      expect(result.stage).toBe('evidence');
      expect(result.issues).toContainEqual({ code: 'authoring_cite_unknown', path });
    });
  });

  describe('authoring_number_not_in_evidence', () => {
    it('refuses a figure in a beat that no cited claim holds', () => {
      const result = refused((draft) => {
        setBeatText(draft, 3, (text) => `${text} It takes about 7 minutes.`);
      });
      expect(result).toEqual({
        stage: 'evidence',
        issues: [{ code: 'authoring_number_not_in_evidence', path: 'beats.3' }],
      });
    });

    it('refuses a figure that only another part cites', () => {
      const result = refused((draft) => {
        setBeatText(draft, 3, (text) => `${text} It boils at 100 degrees.`);
      });
      expect(result.issues).toEqual([{ code: 'authoring_number_not_in_evidence', path: 'beats.3' }]);
    });

    it('accepts the same figure once the beat cites the claim that holds it', () => {
      compiled((draft) => {
        setBeatText(draft, 3, (text) => `${text} It boils at 100 degrees.`);
        beatAt(draft, 3).cites = ['c-boil'];
      });
    });

    it('refuses a figure in a picture label', () => {
      const result = refused((draft) => {
        const picture = draft.authored.pictures[1]?.picture;
        if (picture?.kind === 'statement' && picture.statement.form === 'number')
          picture.statement.label = 'Boiling point at 1 atmosphere';
      });
      expect(result.issues).toEqual([{ code: 'authoring_number_not_in_evidence', path: 'pictures.1' }]);
    });

    it('refuses a figure in a picture note', () => {
      const result = refused((draft) => {
        const picture = draft.authored.pictures[0]?.picture;
        const step = picture?.kind === 'flow' ? picture.steps[0] : undefined;
        if (step !== undefined) step.note = 'The water waits there for 3 minutes.';
      });
      expect(result.issues).toEqual([{ code: 'authoring_number_not_in_evidence', path: 'pictures.0' }]);
    });

    it('refuses a figure in an aside and in the takeaway', () => {
      const aside = refused((draft) => {
        const first = draft.authored.asides[0];
        if (first !== undefined) first.text = `${first.text} About 40 percent differ.`;
      });
      expect(aside.issues).toEqual([{ code: 'authoring_number_not_in_evidence', path: 'asides.0' }]);
      const takeaway = refused((draft) => {
        draft.authored.takeaway.text = 'A kettle boils water in about 3 minutes, and moving water carries the heat.';
      });
      expect(takeaway.issues).toEqual([{ code: 'authoring_number_not_in_evidence', path: 'takeaway' }]);
    });

    it.each([
      ['the title', (draft: Case) => (draft.authored.title = 'How a kettle boils water in 3 steps')],
      [
        'the dek',
        (draft: Case) => (draft.authored.dek = 'Heat goes in at the bottom, and the water boils in 3 steps.'),
      ],
      ['the kicker', (draft: Case) => (draft.authored.kicker = 'Part 2')],
      ['a section title', (draft: Case) => (draft.authored.sections[0]!.title = 'Heat goes in for 3 minutes')],
      ['an ask suggestion', (draft: Case) => (draft.authored.askSuggestions = ['Why does it take 3 minutes?'])],
    ])('refuses a figure in %s that no cited claim holds', (_name, change) => {
      const result = refused(change);
      expect(result).toEqual({
        stage: 'evidence',
        issues: [{ code: 'authoring_number_not_in_evidence', path: 'header' }],
      });
    });
  });

  describe('quote_not_in_evidence', () => {
    it('refuses a quote beat whose words are in no cited passage', () => {
      const result = refused((draft) => {
        replaceBeat(draft, 3, quoteBeat('Water boils when it is hot enough and not before then.', ['c-boil']));
      });
      expect(result).toEqual({ stage: 'evidence', issues: [{ code: 'quote_not_in_evidence', path: 'beats.3' }] });
    });

    it('refuses a quote beat whose passage is cited by another part only', () => {
      const result = refused((draft) => {
        replaceBeat(draft, 3, quoteBeat(BOIL, ['c-heat']));
      });
      expect(result.issues).toContainEqual({ code: 'quote_not_in_evidence', path: 'beats.3' });
    });

    it('accepts a quote beat that matches a cited passage word for word', () => {
      const { document } = compiled((draft) => {
        replaceBeat(draft, 3, quoteBeat(BOIL, ['c-boil']));
      });
      expect(beatsOfV3(document)[3]?.kind).toBe('quote');
    });

    it('accepts a quote beat that is part of a longer cited passage', () => {
      compiled((draft) => {
        setQuote(draft, 'c-boil', `${BOIL} The pressure drops as the air thins.`);
        replaceBeat(draft, 3, quoteBeat(BOIL, ['c-boil']));
      });
    });

    describe('a statement picture of form quote', () => {
      const asQuotePicture =
        (text: string) =>
        (draft: Case): void => {
          draft.authored.pictures[1] = {
            picture: {
              id: 'boil-point',
              kind: 'statement',
              title: 'Where water boils',
              statement: { form: 'quote', text, who: 'A. Writer', work: 'Notes on kettles' },
            },
            cites: ['c-boil'],
          };
          // The picture no longer has a `value` part, so the beats that name it name its `quote`.
          const showing = beatAt(draft, 5);
          if (showing.show !== undefined) showing.show = { picture: 'boil-point', state: { lit: ['quote'] } };
          const linking = beatAt(draft, 6);
          if (linking.links[0] !== undefined) linking.links[0].part = 'quote';
        };

      it('refuses a quotation that is in no cited passage', () => {
        const result = refused(asQuotePicture('Water boils when it is hot enough and not before then.'));
        expect(result).toEqual({ stage: 'evidence', issues: [{ code: 'quote_not_in_evidence', path: 'pictures.1' }] });
      });

      it('accepts a quotation that matches a cited passage', () => {
        const { document } = compiled(asQuotePicture(BOIL));
        const picture = document.pictures[1];
        expect(picture?.kind === 'statement' && picture.statement.form).toBe('quote');
      });
    });

    it('treats the year given with a quotation as a figure that a cited passage must hold', () => {
      const withYear = (year: string) => (draft: Case) => {
        const beat = quoteBeat(BOIL, ['c-boil']);
        if (beat.kind === 'quote') beat.cite.year = year;
        replaceBeat(draft, 3, beat);
      };
      expect(refused(withYear('1901')).issues).toEqual([{ code: 'authoring_number_not_in_evidence', path: 'beats.3' }]);
      compiled(withYear('100'));
    });

    it('compares curly and straight quotes as equal, in both directions', () => {
      const straight = 'It is called "the boiling point of water" and it is 100 degrees Celsius at sea level.';
      const curly = 'It is called “the boiling point of water” and it is 100 degrees Celsius at sea level.';
      compiled((draft) => {
        setQuote(draft, 'c-boil', curly);
        replaceBeat(draft, 3, quoteBeat(straight, ['c-boil']));
      });
      compiled((draft) => {
        setQuote(draft, 'c-boil', straight);
        replaceBeat(draft, 3, quoteBeat(curly, ['c-boil']));
      });
      compiled((draft) => {
        setQuote(draft, 'c-boil', 'Water’s boiling point is 100 degrees Celsius at the sea’s level, nothing less.');
        replaceBeat(
          draft,
          3,
          quoteBeat("Water's boiling point is 100 degrees Celsius at the sea's level, nothing less.", ['c-boil']),
        );
      });
    });

    it('compares dashes and runs of spaces as one', () => {
      compiled((draft) => {
        setQuote(draft, 'c-boil', 'Water boils at 100 degrees Celsius — at sea level.');
        replaceBeat(draft, 3, quoteBeat('Water boils at 100 degrees   Celsius – at sea level.', ['c-boil']));
      });
    });
  });

  describe('copied_passage', () => {
    const NINE_WORDS = 'pure water boils at 100 degrees Celsius at standard';

    it('refuses nine words copied from a cited passage into a plain beat', () => {
      const result = refused((draft) => {
        setBeatText(draft, 3, (text) => `${text} Remember that ${NINE_WORDS} sea level pressure.`);
        beatAt(draft, 3).cites = ['c-boil'];
      });
      expect(result).toEqual({ stage: 'evidence', issues: [{ code: 'copied_passage', path: 'beats.3' }] });
    });

    it('allows eight words copied', () => {
      compiled((draft) => {
        setBeatText(
          draft,
          3,
          (text) => `${text} Remember that water boils at 100 degrees Celsius at standard heights.`,
        );
        beatAt(draft, 3).cites = ['c-boil'];
      });
    });

    it('refuses the copy in an aside', () => {
      const result = refused((draft) => {
        const aside = draft.authored.asides[1];
        if (aside !== undefined) {
          aside.text = `${aside.text} Remember that ${NINE_WORDS} sea level pressure.`;
          aside.cites = ['c-boil'];
        }
      });
      expect(result.issues).toEqual([{ code: 'copied_passage', path: 'asides.1' }]);
    });

    it('does not refuse the same nine words in a quote beat', () => {
      compiled((draft) => {
        replaceBeat(draft, 3, quoteBeat(BOIL, ['c-boil']));
      });
    });

    it('still counts the words of a quote beat that surround the quotation', () => {
      // A quote beat is exempt for its own text only; its plainer version is the writer's own words.
      const result = refused((draft) => {
        const beat = quoteBeat(BOIL, ['c-boil']);
        beat.simple = `So ${BOIL}`;
        replaceBeat(draft, 3, beat);
      });
      expect(result.issues).toEqual([{ code: 'copied_passage', path: 'beats.3' }]);
    });
  });

  describe('authoring_reference_unknown', () => {
    it('refuses a claim whose source is missing, by the claim it is', () => {
      const result = refused((draft) => {
        claimOf(draft, 'c-steam').sourceId = 'src-missing';
      });
      expect(result).toEqual({
        stage: 'evidence',
        issues: [{ code: 'authoring_reference_unknown', path: 'claims.2.sourceId' }],
      });
    });

    it('refuses it even when no part cites that claim', () => {
      const result = refused((draft) => {
        claimOf(draft, 'c-spare').sourceId = 'src-missing';
      });
      expect(result.issues).toEqual([{ code: 'authoring_reference_unknown', path: 'claims.3.sourceId' }]);
    });
  });

  describe('id_duplicate', () => {
    it('refuses a picture called takeaway, the part id of the end summary', () => {
      const result = refused((draft) => {
        const picture = draft.authored.pictures[1]?.picture;
        if (picture !== undefined) picture.id = TAKEAWAY_PART_ID;
      });
      expect(result).toEqual({ stage: 'evidence', issues: [{ code: 'id_duplicate', path: 'pictures.1.picture.id' }] });
    });
  });

  it('collects the findings of several parts in one refusal, in reading order of the rules', () => {
    const result = refused((draft) => {
      beatAt(draft, 0).cites = ['c-missing'];
      setBeatText(draft, 3, (text) => `${text} It takes about 7 minutes.`);
      claimOf(draft, 'c-spare').sourceId = 'src-missing';
    });
    expect(result.stage).toBe('evidence');
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { code: 'authoring_cite_unknown', path: 'beats.0' },
        { code: 'authoring_number_not_in_evidence', path: 'beats.3' },
        { code: 'authoring_reference_unknown', path: 'claims.3.sourceId' },
      ]),
    );
  });
});

describe('compileEditorialV3: stage document', () => {
  it('refuses a link phrase that does not occur in its beat', () => {
    const result = refused((draft) => {
      const beat = beatAt(draft, 1);
      if (beat.links[0] !== undefined) beat.links[0].phrase = 'cooling fin';
    });
    expect(result).toEqual({
      stage: 'document',
      issues: [{ code: 'link_phrase_not_once', path: 'sections.0.beats.1.links.0.phrase' }],
    });
  });

  it('refuses an aside beside a beat the Scroll does not have', () => {
    const result = refused((draft) => {
      const aside = draft.authored.asides[1];
      if (aside !== undefined) aside.beat = 14;
    });
    expect(result).toEqual({
      stage: 'document',
      issues: [{ code: 'aside_anchor_unknown', path: 'asides.1.anchorBeat' }],
    });
  });

  it('refuses a Scroll with no limits aside', () => {
    const result = refused((draft) => {
      const aside = draft.authored.asides[0];
      if (aside !== undefined) aside.kind = 'definition';
    });
    expect(result).toEqual({ stage: 'document', issues: [{ code: 'limits_aside_missing', path: 'asides' }] });
  });

  it('refuses a takeaway of four sentences', () => {
    const result = refused((draft) => {
      draft.authored.takeaway.text = 'A kettle makes heat. The water moves it. The water boils. The kettle stops.';
    });
    expect(result).toEqual({ stage: 'document', issues: [{ code: 'takeaway_sentences', path: 'takeaway' }] });
  });

  it('is judged after the evidence: a bad cite and a bad link stop at the evidence', () => {
    const result = refused((draft) => {
      beatAt(draft, 1).cites = ['c-missing'];
      const beat = beatAt(draft, 4);
      if (beat.links[0] !== undefined) beat.links[0].phrase = 'cooling fin';
    });
    expect(result.stage).toBe('evidence');
    expect(result.issues).toEqual([{ code: 'authoring_cite_unknown', path: 'beats.1' }]);
  });
});
