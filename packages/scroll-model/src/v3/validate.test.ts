import { describe, expect, it } from 'vitest';
import { filler } from '../test-support/v2-fixtures.js';
import { validDocumentV3, withV3 } from '../test-support/v3-fixtures.js';
import { countWords } from '../text.js';
import { SCROLL_DOCUMENT_V3_SCHEMA_VERSION, type Beat, type PlainBeat, type ScrollDocumentV3 } from './document.js';
import type { IssueV3 } from './issues.js';
import { LIMITS_V3 } from './limits.js';
import { computeIntegrityV3, takeawaySentenceCount, validateDocumentV3 } from './validate.js';

/*
 * The fixture's layout, which the paths below rely on:
 *   pictures.0 flow 'kettle-steps' (steps cold, heat, bubbles, boil, each with a note); pictures.1 statement 'boil-point' (part 'value')
 *   sections.0 beats 0..4 = beat-1..beat-5: beat-1 shows the flow (upTo 1); beat-2 links 'heating element' to 'heat';
 *     beat-3 shows it (upTo 2) with a scrub control; beat-5 shows it, lit 'bubbles', and links 'pocket of water vapour'
 *   sections.1 beats 0..4 = beat-6..beat-10: beat-6 shows the statement; beat-7 links 'fixed temperature' to 'value';
 *     beat-10 shows the flow again
 *   asides.0 limits on beat-5; asides.1 definition on beat-3
 */
const valid = validDocumentV3();

const issuesOf = (document: unknown, options?: { verify?: boolean }): readonly IssueV3[] => {
  const outcome = validateDocumentV3(document, options);
  return outcome.kind === 'invalid' ? outcome.issues : [];
};
const expectOnly = (document: unknown, ...issues: IssueV3[]): void => {
  expect(issuesOf(document)).toEqual(issues);
};
const expectIssue = (document: unknown, issue: IssueV3): void => {
  expect(issuesOf(document)).toContainEqual(issue);
};
const expectValid = (document: unknown): void => {
  expect(validateDocumentV3(document)).toMatchObject({ kind: 'valid' });
};

function beatAt(draft: ScrollDocumentV3, section: number, index: number): Beat {
  const beat = draft.sections[section]?.beats[index];
  if (beat === undefined) throw new Error(`no beat ${section}.${index}`);
  return beat;
}
function plainAt(draft: ScrollDocumentV3, section: number, index: number): PlainBeat {
  const beat = beatAt(draft, section, index);
  if (beat.kind !== 'plain') throw new Error('fixture beat is plain');
  return beat;
}
const setText = (draft: ScrollDocumentV3, section: number, index: number, words: number): void => {
  beatAt(draft, section, index).text = filler(words, section * 10 + index + 1);
};
const everyBeat = (draft: ScrollDocumentV3, change: (beat: Beat, index: number) => void): void => {
  draft.sections.flatMap((section) => section.beats).forEach(change);
};

describe('a valid document v3', () => {
  it('validates with no notice, whole, and with a hash that names it', () => {
    const outcome = validateDocumentV3(valid);
    expect(outcome).toEqual({ kind: 'valid', document: valid, notices: [] });
    expect(valid.integrity.sha256).toBe(computeIntegrityV3(valid));
    expect(valid.schemaVersion).toBe(SCROLL_DOCUMENT_V3_SCHEMA_VERSION);
  });

  it('survives a round trip through JSON', () => {
    expectValid(JSON.parse(JSON.stringify(valid)));
  });

  it('never throws on hostile input', () => {
    for (const input of [undefined, null, 5, 'text', [], {}, () => 1])
      expect(validateDocumentV3(input).kind).toBe('invalid');
  });
});

describe('size and schema', () => {
  it('refuses a document over the byte limit', () => {
    expectOnly({ ...valid, padding: 'x'.repeat(LIMITS_V3.documentBytes) }, { code: 'document_too_large', path: '$' });
  });

  it('refuses a value that is not JSON', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectOnly(cyclic, { code: 'document_not_object', path: '$' });
  });

  it('refuses a field the schema does not know, and a wrong version', () => {
    expect(issuesOf({ ...valid, prompt: 'secret' }).length).toBeGreaterThan(0);
    expect(issuesOf({ ...valid, schemaVersion: 'scroll-document.v2' }).length).toBeGreaterThan(0);
  });

  it('reports only schema findings when the shape is wrong, and each once', () => {
    const broken = withV3(valid, (draft) => {
      beatAt(draft, 0, 1).id = 'beat-1';
    });
    const shaped = { ...broken, kicker: '', dek: '' };
    const issues = issuesOf(shaped);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.code.startsWith('schema_'))).toBe(true);
    expect(new Set(issues.map((issue) => `${issue.code}@${issue.path}`)).size).toBe(issues.length);
  });
});

describe('ids are unique across sections, beats, asides and pictures', () => {
  it('refuses a beat that repeats a beat id, naming the second', () => {
    const document = withV3(valid, (draft) => {
      beatAt(draft, 0, 1).id = 'beat-1';
    });
    expectOnly(document, { code: 'id_duplicate', path: 'sections.0.beats.1.id' });
  });

  it('refuses an id that two kinds of thing share', () => {
    const sectionAsPicture = withV3(valid, (draft) => {
      const section = draft.sections[0];
      if (section) section.id = 'kettle-steps';
    });
    expectOnly(sectionAsPicture, { code: 'id_duplicate', path: 'sections.0.id' });
    const asideAsBeat = withV3(valid, (draft) => {
      const aside = draft.asides[1];
      if (aside) aside.id = 'beat-7';
    });
    expectOnly(asideAsBeat, { code: 'id_duplicate', path: 'asides.1.id' });
  });
});

describe('beats and their words', () => {
  it('refuses too few beats', () => {
    const document = withV3(valid, (draft) => {
      draft.sections.forEach((section) => (section.beats = section.beats.slice(0, 2)));
    });
    expectIssue(document, { code: 'beats_too_few', path: 'sections' });
  });

  it('refuses too many beats', () => {
    const document = withV3(valid, (draft) => {
      draft.sections.push({
        id: 'section-extra',
        title: 'Extra',
        beats: Array.from({ length: 5 }, (_, index) => ({
          kind: 'plain',
          id: `extra-${index + 1}`,
          text: filler(20, index + 1),
          simple: filler(8, index + 2),
          links: [],
        })),
      });
    });
    // The sections can hold eighteen beats and the measures list is bounded the same way, so fifteen honest beats
    // reach the rule.
    expect(issuesOf(document)).toEqual([{ code: 'beats_too_many', path: 'sections' }]);
  });

  it('accepts a beat of seventy words and refuses one of seventy-one', () => {
    const edge = withV3(valid, (draft) => setText(draft, 0, 3, LIMITS_V3.beatWords));
    expect(countWords(beatAt(edge, 0, 3).text)).toBe(70);
    expectValid(edge);
    const over = withV3(valid, (draft) => setText(draft, 0, 3, LIMITS_V3.beatWords + 1));
    expectOnly(over, { code: 'beat_too_long', path: 'sections.0.beats.3.text' });
  });

  it('accepts a first beat of forty-five words and refuses one of forty-six', () => {
    const edge = withV3(valid, (draft) => setText(draft, 0, 0, LIMITS_V3.firstBeatWords));
    expectValid(edge);
    const over = withV3(valid, (draft) => setText(draft, 0, 0, LIMITS_V3.firstBeatWords + 1));
    expectOnly(over, { code: 'first_beat_too_long', path: 'sections.0.beats.0.text' });
  });

  it('applies the first-beat limit to the first beat only', () => {
    const later = withV3(valid, (draft) => setText(draft, 1, 0, 60));
    expectValid(later);
  });

  it('accepts a plainer version of seventy words and refuses seventy-one', () => {
    const edge = withV3(valid, (draft) => {
      beatAt(draft, 0, 1).simple = filler(LIMITS_V3.beatWords, 3);
    });
    expectValid(edge);
    const over = withV3(valid, (draft) => {
      beatAt(draft, 0, 1).simple = filler(LIMITS_V3.beatWords + 1, 3);
    });
    expectOnly(over, { code: 'simple_too_long', path: 'sections.0.beats.1.simple' });
  });

  it('refuses a main text under 350 words', () => {
    const document = withV3(valid, (draft) => everyBeat(draft, (beat, index) => (beat.text = filler(30, index + 1))));
    expectIssue(document, { code: 'main_text_too_short', path: 'sections' });
  });

  it('accepts a main text of exactly 700 words and refuses one over it', () => {
    const edge = withV3(valid, (draft) => everyBeat(draft, (beat, index) => (beat.text = filler(70, index + 1))));
    expect(edge.measures.mainWords).toBe(700);
    expect(issuesOf(edge).map((issue) => issue.code)).not.toContain('main_text_too_long');
    const over = withV3(valid, (draft) => {
      everyBeat(draft, (beat, index) => (beat.text = filler(70, index + 1)));
      const section = draft.sections[0];
      section?.beats.push({ kind: 'plain', id: 'beat-11', text: filler(70, 11), simple: filler(8, 12), links: [] });
    });
    expectIssue(over, { code: 'main_text_too_long', path: 'sections' });
  });
});

describe('pictures and what beats show', () => {
  it('refuses a picture whose own data does not hang together', () => {
    const document = withV3(valid, (draft) => {
      const picture = draft.pictures[0];
      if (picture?.kind !== 'flow') throw new Error('fixture picture 0 is a flow');
      const step = picture.steps[3];
      if (step) step.id = 'cold';
    });
    expectIssue(document, { code: 'picture_ids_duplicate', path: 'pictures.0' });
  });

  it('refuses a show that names a picture the document does not declare', () => {
    const document = withV3(valid, (draft) => {
      const show = beatAt(draft, 0, 0).show;
      if (show) show.picture = 'nowhere';
    });
    // Beat-2's link leaned on the picture beat-1 showed; with that show unusable it has none to lean on.
    expectOnly(
      document,
      { code: 'show_picture_unknown', path: 'sections.0.beats.0.show.picture' },
      { code: 'link_without_picture', path: 'sections.0.beats.1.links.0' },
    );
  });

  it('refuses a state the picture cannot be in', () => {
    const beyondItems = withV3(valid, (draft) => {
      const show = beatAt(draft, 0, 4).show;
      if (show) show.state = { upTo: 5 };
    });
    expectOnly(beyondItems, { code: 'show_state_invalid', path: 'sections.0.beats.4.show.state' });
    const keyOfAnotherKind = withV3(valid, (draft) => {
      const show = beatAt(draft, 1, 0).show;
      if (show) show.state = { upTo: 1 };
    });
    expectOnly(keyOfAnotherKind, { code: 'show_state_invalid', path: 'sections.1.beats.0.show.state' });
    const unknownPart = withV3(valid, (draft) => {
      const show = beatAt(draft, 0, 4).show;
      if (show) show.state = { lit: ['nothing'] };
    });
    expectOnly(unknownPart, { code: 'show_state_invalid', path: 'sections.0.beats.4.show.state' });
  });

  it('refuses a declared picture that no beat shows', () => {
    const document = withV3(valid, (draft) => {
      delete beatAt(draft, 1, 0).show;
      beatAt(draft, 1, 1).links = [];
    });
    expectOnly(document, { code: 'picture_unshown', path: 'pictures.1' });
  });
});

describe('linked phrases', () => {
  it('names a part of the picture the beat itself shows', () => {
    // Fixture beat-5 shows the flow and links its own 'bubbles'.
    expect(plainAt(valid, 0, 4).links).toEqual([{ phrase: 'pocket of water vapour', part: 'bubbles' }]);
    expectValid(valid);
  });

  it('falls back to the last picture an earlier beat of the same section showed', () => {
    const document = withV3(valid, (draft) => {
      // beat-4 shows nothing; the flow on screen is the one beat-3 showed.
      beatAt(draft, 0, 3).links = [{ phrase: 'faint hiss', part: 'bubbles' }];
    });
    expectValid(document);
  });

  it('uses the picture of the latest show, not an earlier one', () => {
    const document = withV3(valid, (draft) => {
      // beat-7 follows beat-6's statement, so a flow part is not on screen there.
      beatAt(draft, 1, 1).links = [{ phrase: 'fixed temperature', part: 'heat' }];
    });
    expectOnly(document, { code: 'link_part_unknown', path: 'sections.1.beats.1.links.0.part' });
  });

  it('refuses a link with no picture on screen, and does not carry one over from the section before', () => {
    const document = withV3(valid, (draft) => {
      delete beatAt(draft, 1, 0).show;
      // Keep the statement shown somewhere so that only the link is wrong.
      beatAt(draft, 1, 2).show = { picture: 'boil-point', state: {} };
    });
    expectOnly(document, { code: 'link_without_picture', path: 'sections.1.beats.1.links.0' });
  });

  it('refuses a phrase that is not in the beat, and one that is in it twice', () => {
    const absent = withV3(valid, (draft) => {
      plainAt(draft, 0, 1).links = [{ phrase: 'kettle lid', part: 'heat' }];
    });
    expectOnly(absent, { code: 'link_phrase_not_once', path: 'sections.0.beats.1.links.0.phrase' });
    const twice = withV3(valid, (draft) => {
      plainAt(draft, 0, 1).links = [{ phrase: 'the', part: 'heat' }];
    });
    expectOnly(twice, { code: 'link_phrase_not_once', path: 'sections.0.beats.1.links.0.phrase' });
  });

  it('treats a phrase that overlaps itself as more than once', () => {
    const document = withV3(valid, (draft) => {
      const beat = plainAt(draft, 0, 1);
      beat.text = `${beat.text} Then baaab.`;
      beat.links = [{ phrase: 'aa', part: 'heat' }];
    });
    expectOnly(document, { code: 'link_phrase_not_once', path: 'sections.0.beats.1.links.0.phrase' });
  });

  it('refuses a part the picture on screen does not have', () => {
    const document = withV3(valid, (draft) => {
      plainAt(draft, 0, 1).links = [{ phrase: 'heating element', part: 'nothing' }];
    });
    expectOnly(document, { code: 'link_part_unknown', path: 'sections.0.beats.1.links.0.part' });
  });
});

describe('controls', () => {
  const withSwitch = (draft: ScrollDocumentV3, section: number, index: number, to: PlainBeat['show']): void => {
    plainAt(draft, section, index).control = { kind: 'switch', label: 'Show more', to: to?.state ?? {} };
  };

  it('allows two controls and refuses the third, on the one over', () => {
    const two = withV3(valid, (draft) => withSwitch(draft, 0, 0, { picture: 'kettle-steps', state: { upTo: 2 } }));
    expectValid(two);
    const three = withV3(valid, (draft) => {
      withSwitch(draft, 0, 0, { picture: 'kettle-steps', state: { upTo: 2 } });
      beatAt(draft, 1, 2).show = { picture: 'kettle-steps', state: { upTo: 2 } };
      withSwitch(draft, 1, 2, { picture: 'kettle-steps', state: { upTo: 3 } });
    });
    expectOnly(three, { code: 'control_budget_exceeded', path: 'sections.1.beats.2.control' });
  });

  it('needs a figure on its own beat', () => {
    const document = withV3(valid, (draft) => {
      delete beatAt(draft, 0, 2).show;
    });
    expectOnly(document, { code: 'control_without_show', path: 'sections.0.beats.2.control' });
  });

  it('refuses a switch to the state the beat already shows', () => {
    const document = withV3(valid, (draft) => withSwitch(draft, 0, 2, { picture: 'kettle-steps', state: { upTo: 2 } }));
    expectOnly(document, { code: 'control_unfit', path: 'sections.0.beats.2.control' });
  });

  it('refuses a pick on a picture with fewer than two notes, and accepts one with notes', () => {
    const lonely = withV3(valid, (draft) => {
      plainAt(draft, 1, 0).control = { kind: 'pick', label: 'Pick one' };
    });
    expectOnly(lonely, { code: 'control_unfit', path: 'sections.1.beats.0.control' });
    const noted = withV3(valid, (draft) => {
      plainAt(draft, 0, 4).control = { kind: 'pick', label: 'Pick a step' };
    });
    expectValid(noted);
  });

  it('refuses a scrub with nowhere to go', () => {
    const document = withV3(valid, (draft) => {
      const beat = plainAt(draft, 1, 0);
      beat.control = { kind: 'scrub', label: 'Step through', along: 'items' };
    });
    expectOnly(document, { code: 'control_unfit', path: 'sections.1.beats.0.control' });
  });
});

describe('asides', () => {
  it('refuses an aside beside a beat that does not exist', () => {
    const document = withV3(valid, (draft) => {
      const aside = draft.asides[1];
      if (aside) aside.anchorBeat = 'beat-99';
    });
    expectOnly(document, { code: 'aside_anchor_unknown', path: 'asides.1.anchorBeat' });
  });

  it('refuses a document with no limits aside', () => {
    const document = withV3(valid, (draft) => {
      const aside = draft.asides[0];
      if (aside) aside.kind = 'tangent';
    });
    expectOnly(document, { code: 'limits_aside_missing', path: 'asides' });
  });
});

describe('the takeaway', () => {
  const withTakeaway = (takeaway: string): ScrollDocumentV3 =>
    withV3(valid, (draft) => {
      draft.takeaway = takeaway;
    });

  it('accepts one, two and three sentences', () => {
    expectValid(withTakeaway('Heat goes in, and moving water carries it until the boil.'));
    expectValid(withTakeaway('Heat goes in at the base. Moving water carries it upward!'));
    expectValid(withTakeaway('Heat goes in at the base. Water carries it? Then the water boils…'));
  });

  it('refuses four sentences', () => {
    expectOnly(withTakeaway('Heat goes in. Water moves it. Bubbles form. Then it boils.'), {
      code: 'takeaway_sentences',
      path: 'takeaway',
    });
  });

  it('counts a takeaway with no ender as one sentence', () => {
    expect(takeawaySentenceCount('Heat goes in and water carries it')).toBe(1);
    expectValid(withTakeaway('Heat goes in and water carries it upward'));
  });

  it('counts sentences by their enders, as documented', () => {
    expect(takeawaySentenceCount('One. Two! Three? Four…')).toBe(4);
    expect(takeawaySentenceCount('It boils at 100.5 degrees at sea level.')).toBe(1);
    expect(takeawaySentenceCount('Wait... what?! Yes.')).toBe(3);
    expect(takeawaySentenceCount('One. Two. And a tail without an ender')).toBe(3);
    expect(takeawaySentenceCount('One.   Two.')).toBe(2);
  });
});

describe('stored measures, reading time and hash', () => {
  it('refuses measures that do not match the document', () => {
    const document = { ...valid, measures: { ...valid.measures, totalWeight: valid.measures.totalWeight + 1 } };
    // The hash covers the measures, so a stored value that is wrong breaks the hash too.
    expectOnly(
      document,
      { code: 'measures_mismatch', path: 'measures' },
      { code: 'integrity_mismatch', path: 'integrity' },
    );
  });

  it('refuses a hash that is not the document hash', () => {
    const document = { ...valid, integrity: { ...valid.integrity, sha256: 'a'.repeat(64) } };
    expectOnly(document, { code: 'integrity_mismatch', path: 'integrity' });
    const edited = { ...valid, title: 'How a kettle boils the water' };
    expectOnly(edited, { code: 'integrity_mismatch', path: 'integrity' });
  });

  it('skips all three when verify is off', () => {
    const tampered = {
      ...valid,
      measures: { ...valid.measures, totalWeight: valid.measures.totalWeight + 1 },
      integrity: { ...valid.integrity, sha256: 'a'.repeat(64) },
    };
    expect(validateDocumentV3(tampered, { verify: false }).kind).toBe('valid');
    expect(validateDocumentV3(tampered, { verify: true }).kind).toBe('invalid');
  });

  it('refuses a reading time over four minutes', () => {
    const document = withV3(valid, (draft) => {
      // Longer beats and four full asides, with the first beat (the cover's lede) and every link phrase left as it is.
      everyBeat(draft, (beat, index) => {
        if (index > 0) beat.text = `${beat.text} ${filler(15, index)}`;
      });
      draft.asides = ['beat-1', 'beat-2', 'beat-3', 'beat-4'].map((anchorBeat, index) => ({
        id: `aside-${index + 1}`,
        kind: index === 0 ? 'limits' : 'tangent',
        title: 'Side note',
        text: filler(75, index + 20),
        anchorBeat,
        collapsed: true,
      }));
    });
    expect(document.measures.readingSeconds).toBeGreaterThan(240);
    expectOnly(document, { code: 'reading_length_out_of_brief', path: 'measures.readingSeconds' });
  });

  it('refuses a reading time under two minutes', () => {
    const document = withV3(valid, (draft) => {
      everyBeat(draft, (beat, index) => (beat.text = filler(36, index + 1)));
      draft.pictures.splice(1);
      everyBeat(draft, (beat) => {
        if (beat.show?.picture === 'boil-point') delete beat.show;
        beat.links = beat.links.filter((link) => link.part !== 'value');
        if (beat.kind === 'plain') delete beat.control;
      });
      everyBeat(draft, (beat) => delete beat.show);
    });
    expect(document.measures.readingSeconds).toBeLessThan(120);
    expectIssue(document, { code: 'reading_length_out_of_brief', path: 'measures.readingSeconds' });
  });
});

describe('notices', () => {
  const myth = (reviewed: boolean) =>
    withV3(valid, (draft) => {
      draft.misconception = {
        kind: 'myth',
        claim: 'A kettle boils because the water gets angry.',
        source: { label: 'CI fixture label', reviewed },
      };
    });

  it('notes a myth whose source label has not been reviewed, and still admits the document', () => {
    expect(validateDocumentV3(myth(false))).toMatchObject({
      kind: 'valid',
      notices: [{ code: 'misconception_source_unreviewed', path: 'misconception.source' }],
    });
  });

  it('has no notice for a reviewed source', () => {
    expect(validateDocumentV3(myth(true))).toMatchObject({ kind: 'valid', notices: [] });
  });
});
