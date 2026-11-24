import { describe, expect, it } from 'vitest';
import { ScrollProvenanceV3, TAKEAWAY_PART_ID } from '../../internal/provenance-v3.js';
import {
  BOIL,
  compileInputFor,
  HEAT,
  STEAM,
  validReply,
  type Mutable,
} from '../../test-support/written-v3-fixtures.js';
import type { IssueV3 } from '../../v3/issues.js';
import { computeMeasuresV3 } from '../../v3/measures.js';
import { computeIntegrityV3, validateDocumentV3 } from '../../v3/validate.js';
import { REPAIR_HINTS_V3 } from './reasons.js';
import { compileWrittenV3, compileWrittenProseV3, type WrittenCompileOutcome } from './written.js';
import { mergeStagingV3 } from './written-merge.js';
import { WrittenScrollV3, type WrittenItemV3, type WrittenProseV3, type WrittenStagingV3 } from './written-schema.js';

/*
 * The kettle Scroll as the model writes it (`test-support/written-v3-fixtures.ts`). Items, counted from 0:
 *   0 section, 1..3 paragraphs (3 scrubs), 4 aside (definition), 5 and 6 paragraphs (6 links 'Bubbles'), 7 aside (limits),
 *   8 section, 9 paragraph showing picture 2 (statement 'value'), 10 links 'value', 11..13 paragraphs.
 * Picture 1 is the flow 'Cold water' / 'Heat in' / 'Bubbles' / 'Full boil'. Handles: e1 heat, e2 boil, e3 steam.
 */

type Change = (reply: WrittenScrollV3, input: Mutable) => void;

function compile(change: Change = () => undefined): WrittenCompileOutcome {
  const reply = validReply();
  return compileWrittenV3(compileInputFor(reply, (input) => change(input.reply, input)));
}

function compiled(change?: Change) {
  const outcome = compile(change);
  if (outcome.kind !== 'compiled') throw new Error(`refused: ${JSON.stringify(outcome.issues)}`);
  return outcome;
}

/** Every code a refusal in this file carried, so the last test can ask that each has a repair hint. */
const seenCodes = new Set<string>();

function refused(change: Change): readonly IssueV3[] {
  const outcome = compile(change);
  if (outcome.kind !== 'refused') throw new Error('expected a refusal');
  for (const issue of outcome.issues) seenCodes.add(issue.code);
  return outcome.issues;
}

type Para = Extract<WrittenItemV3, { type: 'para' }>;

function para(reply: WrittenScrollV3, index: number): Para {
  const item = reply.items[index];
  if (item?.type !== 'para') throw new Error(`item ${index} is not a paragraph`);
  return item;
}

const at = (code: IssueV3['code'], path: string): IssueV3 => ({ code, path });

/** An `authoring_number_not_in_evidence` finding of the model writer's strict compile at `path`: it carries the detail for the repair notes (D-444). */
const numberAt = (path: string): unknown =>
  expect.objectContaining({ code: 'authoring_number_not_in_evidence', path, detail: expect.any(String) as unknown });

/** A `copied_passage` finding at `path` that names `field` of the item and quotes the research's words. */
const copiedAt = (path: string, field = 'text'): unknown =>
  expect.objectContaining({
    code: 'copied_passage',
    path,
    detail: expect.stringContaining(`in the ${field}: "a long page about the history of the teapot`) as unknown,
  });

describe('compileWrittenV3: a reply that compiles', () => {
  it('parses with the reply schema, and compiles to a document the validator accepts', () => {
    expect(WrittenScrollV3.safeParse(validReply()).success).toBe(true);
    const { document } = compiled();
    expect(validateDocumentV3(JSON.parse(JSON.stringify(document)) as unknown)).toMatchObject({ kind: 'valid' });
    expect(computeMeasuresV3(document)).toEqual(document.measures);
    expect(computeIntegrityV3(document)).toBe(document.integrity.sha256);
  });

  it('assigns every id: sections, beats, asides, pictures and their parts', () => {
    const { document } = compiled();
    expect(document.sections.map((section) => section.id)).toEqual(['s1', 's2']);
    expect(document.sections.flatMap((section) => section.beats.map((beat) => beat.id))).toEqual([
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
    expect(document.asides.map((aside) => [aside.id, aside.anchorBeat])).toEqual([
      ['a1', 'b3'],
      ['a2', 'b5'],
    ]);
    expect(document.pictures.map((picture) => picture.id)).toEqual(['p1', 'p2']);
    const flow = document.pictures[0];
    expect(flow?.kind === 'flow' ? flow.steps.map((step) => step.id) : []).toEqual([
      'p1-s1',
      'p1-s2',
      'p1-s3',
      'p1-s4',
    ]);
  });

  it('turns picture numbers and labels into the ids code assigned', () => {
    const { document } = compiled();
    const beats = document.sections.flatMap((section) => section.beats);
    expect(beats[0]?.show).toEqual({ picture: 'p1', state: { upTo: 1 } });
    expect(beats[4]?.show).toEqual({ picture: 'p1', state: { upTo: 3, lit: ['p1-s3'] } });
    expect(beats[4]?.links).toEqual([{ phrase: 'pocket of water vapour', part: 'p1-s3' }]);
    expect(beats[5]?.show).toEqual({ picture: 'p2', state: { lit: ['value'] } });
    expect(beats[6]?.links).toEqual([{ phrase: 'fixed temperature', part: 'value' }]);
  });

  it('records provenance and the claims each part rests on, under the document ids', () => {
    const { provenance, citations, document } = compiled();
    expect(ScrollProvenanceV3.safeParse(provenance).success).toBe(true);
    expect(provenance.documentSha256).toBe(document.integrity.sha256);
    expect(citations['b9']).toEqual(['c-steam']);
    expect(citations['a2']).toEqual(['c-steam']);
    expect(citations['p2']).toEqual(['c-boil']);
    expect(citations[TAKEAWAY_PART_ID]).toEqual(['c-heat', 'c-boil']);
    expect(provenance.claims.map((claim) => claim.claimId)).toEqual(['c-heat', 'c-boil', 'c-steam']);
  });

  it('compiles the same reply to the same bytes', () => {
    expect(JSON.stringify(compiled())).toBe(JSON.stringify(compiled()));
  });

  it('keeps no handle, id of the model or cite in the stored document', () => {
    expect(JSON.stringify(compiled().document)).not.toContain('cites');
  });
});

describe('compileWrittenV3: the new codes, each at the model’s own item', () => {
  it('section_first_missing: the first item is not a section', () => {
    const issues = refused((reply) => {
      reply.items.shift();
    });
    expect(issues).toContainEqual(at('section_first_missing', 'items.0'));
  });

  it('aside_without_beat: an aside before any paragraph', () => {
    const issues = refused((reply) => {
      const [first, ...rest] = reply.items;
      if (first === undefined) return;
      reply.items = [
        first,
        { type: 'aside', kind: 'tangent', title: 'Early', text: 'An aside with nothing to follow.', cites: ['e1'] },
        ...rest,
      ];
    });
    expect(issues).toContainEqual(at('aside_without_beat', 'items.1'));
  });

  it('picture_label_duplicate: two steps with one label, at the second', () => {
    const issues = refused((reply) => {
      const flow = reply.pictures[0];
      if (flow?.kind !== 'flow' || flow.steps[2] === undefined) return;
      flow.steps[2].label = 'Heat in';
    });
    expect(issues).toContainEqual(at('picture_label_duplicate', 'pictures.0.steps.2.label'));
  });

  it('grid cells may repeat a text, but a link or a lit that names such a cell is refused at the reference', () => {
    const repeated = (reply: WrittenScrollV3) => {
      reply.pictures[1] = {
        kind: 'grid',
        title: 'Two kettles',
        cites: ['e2'],
        columns: [{ label: 'Small' }, { label: 'Large' }],
        rows: [{ label: 'Boils fast' }],
        cells: [
          { row: 'Boils fast', column: 'Small', text: 'Yes' },
          { row: 'Boils fast', column: 'Large', text: 'Yes' },
        ],
      };
    };
    const unnamed = compile((reply) => {
      repeated(reply);
      para(reply, 10).links = [];
    });
    expect(unnamed.kind === 'refused' ? unnamed.issues.map((issue) => issue.code) : []).not.toContain(
      'picture_label_duplicate',
    );
    const named = refused((reply) => {
      repeated(reply);
      const link = para(reply, 10).links?.[0];
      if (link !== undefined) link.part = 'Yes';
    });
    expect(named).toContainEqual(at('picture_label_duplicate', 'items.10.links.0.part'));
  });

  it('picture_kind_unplanned: a picture of another kind than the plan names, and too few pictures', () => {
    const wrong = compileWrittenV3({ ...compileInputFor(validReply()), plannedKinds: ['flow', 'chart'] });
    expect(wrong).toMatchObject({ kind: 'refused' });
    expect(wrong.kind === 'refused' ? wrong.issues : []).toContainEqual(at('picture_kind_unplanned', 'pictures.1'));
    const short = compileWrittenV3({ ...compileInputFor(validReply()), plannedKinds: ['flow', 'statement', 'grid'] });
    expect(short.kind === 'refused' ? short.issues : []).toContainEqual(at('picture_kind_unplanned', 'pictures'));
    expect(compileWrittenV3({ ...compileInputFor(validReply()), plannedKinds: ['flow', 'statement'] }).kind).toBe(
      'compiled',
    );
  });

  it('first_beat_points_back: the first paragraph opens with a pointer, in any case', () => {
    for (const opening of ['This kettle', 'it', 'BUT a kettle']) {
      const issues = refused((reply) => {
        para(reply, 1).text =
          `${opening} starts working the moment it is switched on, long before anything can be seen.`;
      });
      expect(issues).toContainEqual(at('first_beat_points_back', 'items.1.text'));
    }
  });

  it('first_beat_points_back: a later paragraph may open with a pointer', () => {
    compiled((reply) => {
      para(reply, 2).text = `This ${para(reply, 2).text}`;
    });
  });

  it('machine_phrase: a stock phrase in a paragraph, a simple text, an aside and the dek', () => {
    const issues = refused((reply) => {
      para(reply, 2).text = `${para(reply, 2).text} It is important to note that the element glows.`;
      para(reply, 3).simple = 'Let’s dive into how the strip bends, a testament to simple design.';
      reply.dek = 'We delve into how a kettle moves heat through water without any stirring.';
      const aside = reply.items[7];
      if (aside?.type === 'aside') aside.text = 'This plays a crucial role in the limits of the picture.';
    });
    expect(issues).toContainEqual(at('machine_phrase', 'items.2.text'));
    expect(issues).toContainEqual(at('machine_phrase', 'items.3.simple'));
    expect(issues).toContainEqual(at('machine_phrase', 'dek'));
    expect(issues).toContainEqual(at('machine_phrase', 'items.7.text'));
  });

  it('machine_phrase: only whole words, so a longer word is not a match', () => {
    compiled((reply) => {
      reply.askSuggestions = [
        'Is the tapestryless wall of a kettle hotter?',
        'Why does water boil faster in a smaller pot?',
      ];
    });
  });

  it('takeaway_repeats_dek: the same words again, and nearly the same', () => {
    const same = refused((reply) => {
      reply.takeaway.text = `${reply.dek.toUpperCase().slice(0, -1)}!`;
    });
    expect(same).toContainEqual(at('takeaway_repeats_dek', 'takeaway'));
    const near = refused((reply) => {
      reply.takeaway.text = 'Heat goes in at the bottom, and the water does the rest of the work by moving around.';
    });
    expect(near).toContainEqual(at('takeaway_repeats_dek', 'takeaway'));
  });
});

describe('compileWrittenV3: references, handles and structure', () => {
  it('authoring_cite_unknown: a handle that was not offered, on a beat, an aside, a picture and the takeaway', () => {
    const issues = refused((reply) => {
      para(reply, 2).cites = ['e1', 'e9'];
      const aside = reply.items[4];
      if (aside?.type === 'aside') aside.cites = ['e44'];
      const picture = reply.pictures[1];
      if (picture !== undefined) picture.cites = ['e8'];
      reply.takeaway.cites = ['e1', 'e7'];
    });
    for (const path of ['items.2', 'items.4', 'pictures.1', 'takeaway'])
      expect(issues).toContainEqual(at('authoring_cite_unknown', path));
  });

  it('authoring_too_few_cites: fewer distinct passages than asked', () => {
    expect(
      refused((_reply, input) => {
        input.minDistinctCitations = 4;
      }),
    ).toContainEqual(at('authoring_too_few_cites', '$'));
  });

  it('show_picture_unknown: a picture number the reply has no picture for', () => {
    const issues = refused((reply) => {
      const beat = para(reply, 1);
      if (beat.show !== undefined) beat.show.picture = 3;
    });
    expect(issues).toContainEqual(at('show_picture_unknown', 'items.1.show.picture'));
  });

  it('show_state_invalid: a lit label the picture does not have, and a region it does not have', () => {
    const issues = refused((reply) => {
      const beat = para(reply, 6);
      if (beat.show !== undefined) beat.show.lit = ['Bubbles', 'Boiling'];
      const control = para(reply, 3);
      control.control = { kind: 'switch', label: 'Flip it', to: { upTo: 1, lit: ['Nowhere'] } };
    });
    expect(issues).toContainEqual(at('show_state_invalid', 'items.6.show.lit.1'));
    expect(issues).toContainEqual(at('show_state_invalid', 'items.3.control.to.lit.0'));
  });

  it('a link whose label is not a part of the picture on screen is left out, with a notice and no issue', () => {
    const outcome = compiled((reply) => {
      para(reply, 6).links = [{ phrase: 'pocket of water vapour', part: 'Vapour' }];
    });
    expect(outcome.notices).toEqual([at('link_part_unknown', 'items.6.links.0.part')]);
    expect(outcome.document.sections.flatMap((section) => section.beats)[4]?.links).toEqual([]);
  });

  it('a link in a section whose picture has not been shown yet is left out, with a notice and no issue', () => {
    const outcome = compiled((reply) => {
      // The paragraph that opened the second section's picture moves to the next one, so the section starts without it.
      const beat = para(reply, 9);
      const next = para(reply, 10);
      next.show = beat.show;
      delete beat.show;
      beat.links = [{ phrase: 'vapour pressure', part: 'value' }];
    });
    expect(outcome.notices).toEqual([at('link_without_picture', 'items.9.links.0')]);
  });

  it('a link may name a part of the picture an earlier beat of the section showed', () => {
    compiled((reply) => {
      // Item 2 shows nothing; picture 1 is on screen from item 1.
      para(reply, 2).links = [{ phrase: 'heating element', part: 'Heat in' }];
    });
  });

  it('picture_ref_unknown: a grid cell or a chart mark that names a part that is not there', () => {
    const issues = refused((reply) => {
      reply.pictures[1] = {
        kind: 'grid',
        title: 'Two kettles',
        cites: ['e2'],
        columns: [{ label: 'Small' }, { label: 'Large' }],
        rows: [{ label: 'Fast' }],
        cells: [
          { row: 'Fast', column: 'Small', text: 'Quick' },
          { row: 'Slow', column: 'Large', text: 'Longer' },
        ],
      };
    });
    expect(issues).toContainEqual(at('picture_ref_unknown', 'pictures.1.cells.1.row'));
  });

  it('control_unfit: a pick on a picture without notes, found by the document and given at the paragraph', () => {
    const issues = refused((reply) => {
      para(reply, 3).control = { kind: 'pick', label: 'Pick a step' };
      const flow = reply.pictures[0];
      if (flow?.kind === 'flow') for (const step of flow.steps) delete step.note;
    });
    expect(issues).toContainEqual(at('control_unfit', 'items.3.control'));
  });

  it('too much structure is cut from the validated copy with a finding; too little has findings and no document rules', () => {
    const many = refused((reply) => {
      const section = reply.items[0];
      if (section !== undefined) reply.items.push(section, section, section);
    });
    expect(many).toContainEqual(at('schema_too_big', 'items'));
    const none = refused((reply) => {
      reply.items = reply.items.filter((item) => item.type !== 'aside');
    });
    expect(none).toContainEqual(at('limits_aside_missing', 'items'));
    const small = refused((reply) => {
      reply.items = reply.items.slice(0, 8);
    });
    expect(small).toContainEqual(at('schema_too_small', 'items'));
  });
});

describe('compileWrittenV3: the document’s own findings, at the model’s items', () => {
  it('maps a word-limit finding to the beat it is about', () => {
    const issues = refused((reply) => {
      para(reply, 10).text = Array.from({ length: 80 }, () => 'word').join(' ');
    });
    expect(issues).toContainEqual(at('beat_too_long', 'items.10.text'));
  });

  it('maps a first-beat length finding, a missing limits aside and an unshown picture', () => {
    const issues = refused((reply) => {
      para(reply, 1).text = Array.from({ length: 60 }, (_, index) => `word${'abcdefghij'[index % 10]}`).join(' ');
      delete para(reply, 9).show;
      delete para(reply, 10).links;
      reply.items = reply.items.filter((item) => item.type !== 'aside' || item.kind !== 'limits');
    });
    expect(issues).toContainEqual(at('first_beat_too_long', 'items.1.text'));
    expect(issues).toContainEqual(at('limits_aside_missing', 'items'));
    expect(issues).toContainEqual(at('picture_unshown', 'pictures.1'));
  });

  it('reports the length of the essay, which belongs to no one item, at items', () => {
    const issues = refused((reply) => {
      for (const item of reply.items) if (item.type === 'para') item.text = item.text.split(' ').slice(0, 20).join(' ');
    });
    expect(issues).toContainEqual(at('main_text_too_short', 'items'));
  });
});

describe('compileWrittenV3: strict figures (D-208, D-302)', () => {
  const withKilowatts = (input: Mutable) => {
    input.passages['c-heat'] = `${HEAT} Typical elements draw 2 to 3 kilowatts.`;
  };

  it('accepts a range stated whole, and a figure a passage states', () => {
    compiled((reply, input) => {
      withKilowatts(input);
      para(reply, 2).text = `${para(reply, 2).text} Typical elements draw 2 to 3 kilowatts.`
        .split(' ')
        .slice(0, 69)
        .join(' ');
    });
  });

  it('refuses one end of a range on its own, which the editorial rule accepts', () => {
    const issues = refused((reply, input) => {
      withKilowatts(input);
      para(reply, 2).text =
        `${para(reply, 2).text.split(' ').slice(0, 40).join(' ')} Typical elements draw 3 kilowatts.`;
    });
    expect(issues).toContainEqual(numberAt('items.2'));
  });

  it('refuses "a million" when no cited passage has those words', () => {
    const issues = refused((reply) => {
      para(reply, 2).text =
        `${para(reply, 2).text.split(' ').slice(0, 40).join(' ')} A million kettles are sold in a week.`;
    });
    expect(issues).toContainEqual(numberAt('items.2'));
  });

  it('reads the dek, a section title and an ask suggestion as prose too, each at its own path', () => {
    const issues = refused((reply) => {
      reply.dek = 'Heat goes in at the bottom, and a million kettles do it every day without a word.';
      const section = reply.items[8];
      if (section?.type === 'section') section.title = 'Boiling at 99 degrees';
      reply.askSuggestions = ['Is it true that 212 degrees is the boiling point?'];
    });
    expect(issues).toContainEqual(numberAt('dek'));
    expect(issues).toContainEqual(numberAt('items.8.title'));
    expect(issues).toContainEqual(numberAt('askSuggestions.0'));
  });

  describe('a chart value', () => {
    const withChart = (unit: string | undefined, passage: string) => (reply: WrittenScrollV3, input: Mutable) => {
      input.passages['c-boil'] = passage;
      reply.pictures[1] = {
        kind: 'chart',
        title: 'People near kettles',
        cites: ['e2'],
        form: 'bars',
        ...(unit === undefined ? {} : { unit }),
        values: 'shown',
        points: [
          { label: 'Town', value: '8.3' },
          { label: 'City', value: '9.1' },
        ],
        marks: [],
      };
      const show = para(reply, 9);
      show.show = { picture: 2, upTo: 1 };
      delete para(reply, 10).links;
    };

    it('passes when the unit opens with the magnitude word the passage writes after the figure', () => {
      compiled(withChart('million people', `${BOIL} Some 8.3 million people and 9.1 million people live nearby.`));
    });

    it('fails when the passage writes the figure with no magnitude word', () => {
      const issues = refused(withChart('million people', `${BOIL} Some 8.3 people and 9.1 people live nearby.`));
      expect(issues).toContainEqual(numberAt('pictures.1.points.0.value'));
    });

    it('fails when the unit has no magnitude word but the passage writes one', () => {
      const issues = refused(
        withChart('people', `${BOIL} Some 8.3 million people and 9.1 million people live nearby.`),
      );
      expect(issues).toContainEqual(numberAt('pictures.1.points.1.value'));
    });

    it('passes a figure the passage writes bare, with a unit that has no magnitude word', () => {
      compiled(withChart('people', `${BOIL} Some 8.3 people and 9.1 people live nearby.`));
    });

    it('compiles a chart with its marks, and a chart with an empty list of marks', () => {
      const marked = (marks: { point: string; label: string }[]) => (reply: WrittenScrollV3, input: Mutable) => {
        withChart('people', `${BOIL} Some 8.3 people and 9.1 people live nearby.`)(reply, input);
        const chart = reply.pictures[1];
        if (chart?.kind !== 'chart') throw new Error('CI expected the chart');
        chart.marks = marks;
      };
      const outcome = compiled(marked([{ point: 'City', label: 'The larger one' }]));
      const chart = outcome.document.pictures[1];
      expect(chart?.kind === 'chart' && chart.marks.map((mark) => mark.label)).toEqual(['The larger one']);
      compiled(marked([]));
    });

    it('refuses a chart written without its "marks" at the reply shape, before any compile (D-441)', () => {
      const reply = JSON.parse(JSON.stringify(validReply())) as { pictures: Record<string, unknown>[] };
      reply.pictures[1] = {
        kind: 'chart',
        title: 'People near kettles',
        cites: ['e2'],
        form: 'bars',
        unit: 'people',
        values: 'shown',
        points: [
          { label: 'Town', value: '8.3' },
          { label: 'City', value: '9.1' },
        ],
      };
      const parsed = WrittenScrollV3.safeParse(reply);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['pictures.1.marks']);
    });

    it('refuses a value no cited passage states at all, at the value', () => {
      const issues = refused(withChart('people', `${BOIL} Some 8.3 people live nearby.`));
      expect(issues).toContainEqual(numberAt('pictures.1.points.1.value'));
    });

    it('passes a negative value the passage writes with the Unicode minus, and refuses one it writes without a sign', () => {
      const negative = (passage: string) => (reply: WrittenScrollV3, input: Mutable) => {
        withChart('millivolts', passage)(reply, input);
        const chart = reply.pictures[1];
        if (chart?.kind !== 'chart') throw new Error('CI expected the chart');
        // A bar cannot go below zero, so a figure below zero is a line.
        chart.form = 'line';
        chart.points = [
          { label: 'Rest', value: '-70' },
          { label: 'Threshold', value: '-55' },
        ];
      };
      compiled(negative(`${BOIL} At rest the cell sits at \u221270 millivolts, and fires at \u221255 millivolts.`));
      compiled(negative(`${BOIL} At rest the cell sits at -70 millivolts, and fires at -55 millivolts.`));
      const issues = refused(negative(`${BOIL} At rest the cell sits at 70 millivolts, and fires at 55 millivolts.`));
      expect(issues).toContainEqual(numberAt('pictures.1.points.0.value'));
    });

    it('reads a value the model writes with the Unicode minus as the stored hyphen-minus', () => {
      const reply = validReply();
      reply.pictures[1] = {
        kind: 'chart',
        title: 'Two voltages',
        cites: ['e2'],
        form: 'line',
        values: 'shown',
        points: [
          { label: 'Rest', value: '\u221270' },
          { label: 'Threshold', value: '\u221255' },
        ],
        marks: [],
      };
      const parsed = WrittenScrollV3.parse(JSON.parse(JSON.stringify(reply)));
      const chart = parsed.pictures[1];
      expect(chart?.kind === 'chart' && chart.points.map((point) => point.value)).toEqual(['-70', '-55']);
    });

    it('refuses a unit the passage never names, at the unit', () => {
      const issues = refused(withChart('light years', `${BOIL} Some 8.3 people and 9.1 people live nearby.`));
      expect(issues).toContainEqual(numberAt('pictures.1.unit'));
    });
  });
});

describe('compileWrittenV3: a copied_passage finding says what was copied (D-441)', () => {
  /** Ten words, as the research writes them, of the heating passage, the steam passage and the page. */
  const HEAT_RUN = 'The element of a kettle turns the electric current that';
  const STEAM_RUN = 'Many kettles switch themselves off when a bimetallic strip senses';
  const PAGE_RUN = 'A long page about the history of the teapot and';
  const quoted = (run: string): string => run.toLowerCase();

  const copies = (change: Change): readonly IssueV3[] =>
    refused(change).filter((issue) => issue.code === 'copied_passage');

  it('names the paragraph text and quotes the run, as the research writes it in lower case', () => {
    const found = copies((reply) => {
      para(reply, 11).text = `${para(reply, 11).text} Note that ${HEAT_RUN} into the cold.`;
    });
    expect(found).toEqual([
      {
        code: 'copied_passage',
        path: 'items.11',
        detail: `Nine or more words in a row match the research, in the text: "${quoted(HEAT_RUN)}". Rewrite them in your own words, with a different sentence structure.`,
      },
    ]);
  });

  it('names the simpler text when the copy is there and the text is clean', () => {
    const found = copies((reply) => {
      para(reply, 11).simple = `${para(reply, 11).simple} Also ${STEAM_RUN} the steam.`;
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: 'items.11' });
    expect(found[0]?.detail).toBe(
      `Nine or more words in a row match the research, in the simpler text: "${quoted(STEAM_RUN)}". Rewrite them in your own words, with a different sentence structure.`,
    );
  });

  it('names a picture caption, at the picture', () => {
    const found = copies((reply) => {
      const picture = reply.pictures[0];
      if (picture === undefined) throw new Error('no picture');
      picture.caption = `${PAGE_RUN} the samovar`;
    });
    expect(found).toEqual([
      {
        code: 'copied_passage',
        path: 'pictures.0',
        detail: `Nine or more words in a row match the research, in the caption: "${quoted(PAGE_RUN)} the samovar". Rewrite them in your own words, with a different sentence structure.`,
      },
    ]);
  });

  it('names a step of a picture by its place in the list', () => {
    const found = copies((reply) => {
      const picture = reply.pictures[0];
      if (picture?.kind !== 'flow') throw new Error('the first picture is a flow');
      const step = picture.steps[1];
      if (step === undefined) throw new Error('no second step');
      step.note = HEAT_RUN;
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: 'pictures.0' });
    expect(found[0]?.detail).toContain(`in the step 2 note: "${quoted(HEAT_RUN)}"`);
  });

  it('quotes every run of an item up to four, so a model told of a copy is told of all of its places in it (D-444)', () => {
    const found = copies((reply) => {
      para(reply, 11).text = `Start. ${HEAT_RUN} here. Then ${STEAM_RUN} there. Last, ${PAGE_RUN} again.`;
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toBe(
      `Nine or more words in a row match the research, in the text: "${quoted(HEAT_RUN)}"; in the text: "${quoted(STEAM_RUN)}"; in the text: "${quoted(PAGE_RUN)}". Rewrite them in your own words, with a different sentence structure.`,
    );
  });

  it('quotes at most fifteen words of a run, ending in an ellipsis', () => {
    const found = copies((reply) => {
      para(reply, 11).text =
        `${para(reply, 11).text} ${PAGE_RUN} the samovar, with nothing in it that the essay repeats.`;
    });
    expect(found[0]?.detail).toContain(
      '"a long page about the history of the teapot and the samovar with nothing in …"',
    );
  });

  it('has no copied_passage finding on a reply without a copy', () => {
    const outcome = compile();
    expect(outcome.kind).toBe('compiled');
    expect(outcome.kind === 'refused' ? outcome.issues.map((issue) => issue.code) : []).not.toContain('copied_passage');
  });
});

describe('compileWrittenV3: the copy rule against every research text', () => {
  const NINE = 'a long page about the history of the teapot and the';

  it('refuses nine words copied from a page the passages came from, in a paragraph', () => {
    const issues = refused((reply) => {
      para(reply, 11).text = `${para(reply, 11).text} Remember ${NINE} samovar.`;
    });
    expect(issues).toContainEqual(copiedAt('items.11'));
  });

  it('refuses the same words in the title, the dek, a section title and an ask suggestion', () => {
    const issues = refused((reply) => {
      reply.title = `A kettle: ${NINE}`;
      reply.dek = `Heat goes in, and ${NINE} samovar.`;
      const section = reply.items[8];
      if (section?.type === 'section') section.title = NINE.split(' ').slice(0, 9).join(' ');
      reply.askSuggestions = [`Is it true that ${NINE} samovar?`];
    });
    for (const path of ['title', 'dek', 'items.8.title', 'askSuggestions.0'])
      expect(issues).toContainEqual(copiedAt(path));
  });

  it('lets a quotation copy, because a quotation is the passage', () => {
    compiled((reply) => {
      const quote: WrittenItemV3 = {
        type: 'quote',
        text: 'The element of a kettle turns the electric current that passes through it into heat.',
        simple: 'The hot part of a kettle makes heat from electricity.',
        who: 'A. Writer',
        cites: ['e1'],
      };
      const old = para(reply, 2);
      reply.items[2] = { ...quote, ...(old.show === undefined ? {} : { show: old.show }) };
    });
  });

  it('refuses a quotation that is not word for word in a cited passage', () => {
    const issues = refused((reply) => {
      reply.items[2] = {
        type: 'quote',
        text: 'The element of a kettle turns current into some heat.',
        simple: 'The hot part of a kettle makes heat from electricity.',
        who: 'A. Writer',
        cites: ['e1'],
      };
    });
    expect(issues).toContainEqual(at('quote_not_in_evidence', 'items.2'));
  });
});

describe('compileWrittenV3: every finding at once', () => {
  it('reports three problems in three places together, and does not stop at the first stage', () => {
    const issues = refused((reply) => {
      para(reply, 2).cites = ['e1', 'e9'];
      const control = para(reply, 3);
      control.control = { kind: 'switch', label: 'Flip it', to: { upTo: 1, lit: ['Nowhere'] } };
      const aside = reply.items[7];
      if (aside?.type === 'aside') aside.text = 'This plays a crucial role in the limits of the picture.';
      para(reply, 10).text = Array.from({ length: 80 }, () => 'word').join(' ');
    });
    expect(issues).toContainEqual(at('authoring_cite_unknown', 'items.2'));
    expect(issues).toContainEqual(at('show_state_invalid', 'items.3.control.to.lit.0'));
    expect(issues).toContainEqual(at('machine_phrase', 'items.7.text'));
    expect(issues).toContainEqual(at('beat_too_long', 'items.10.text'));
  });

  it('reports no duplicate for one cause', () => {
    const issues = refused((reply) => {
      const beat = para(reply, 3);
      if (beat.show !== undefined) beat.show.lit = ['Nowhere'];
    });
    const keys = issues.map((issue) => `${issue.code}@${issue.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(issues.filter((issue) => issue.code === 'show_state_invalid')).toHaveLength(1);
  });
});

describe('arm (b): the merge and the prose compile', () => {
  /** Splits the whole reply into the two arm (b) replies, the way a model would have written them. */
  function split(reply: WrittenScrollV3): { prose: WrittenProseV3; staging: WrittenStagingV3 } {
    let number = 0;
    const stage: WrittenStagingV3['stage'] = [];
    const items = reply.items.map((item): WrittenProseV3['items'][number] => {
      if (item.type === 'section' || item.type === 'aside') return item;
      number += 1;
      const { show, links, ...rest } = item;
      const control = 'control' in rest ? rest.control : undefined;
      const emphasis = 'emphasis' in rest ? rest.emphasis : undefined;
      if (show !== undefined || links !== undefined || control !== undefined || emphasis !== undefined)
        stage.push({
          para: number,
          ...(show === undefined ? {} : { show }),
          ...(links === undefined ? {} : { links }),
          ...(control === undefined ? {} : { control }),
          ...(emphasis === undefined ? {} : { emphasis }),
        });
      const {
        control: _control,
        emphasis: _emphasis,
        ...plain
      } = rest as typeof rest & { control?: unknown; emphasis?: unknown };
      return plain;
    });
    const { pictures, items: _items, ...essay } = reply;
    return { prose: { ...essay, items }, staging: { pictures, stage } };
  }

  it('merges the prose and the staging into the reply of arm (a), and both compile alike', () => {
    const reply = validReply();
    const { prose, staging } = split(reply);
    const merged = mergeStagingV3(prose, staging);
    expect(merged.issues).toEqual([]);
    expect(JSON.stringify(compileWrittenV3(compileInputFor(merged.reply)))).toBe(
      JSON.stringify(compileWrittenV3(compileInputFor(reply))),
    );
    expect(compileWrittenV3(compileInputFor(merged.reply)).kind).toBe('compiled');
  });

  it('does not change a word of the prose', () => {
    const { prose, staging } = split(validReply());
    const merged = mergeStagingV3(prose, staging).reply;
    const words = (items: readonly { type: string; text?: string }[]) => items.map((item) => item.text);
    expect(words(merged.items)).toEqual(words(prose.items));
  });

  it('accepts the prose alone, with no finding about a picture', () => {
    const { prose } = split(validReply());
    const input = compileInputFor(validReply());
    const { reply: _reply, plannedKinds: _planned, ...rest } = input;
    expect(compileWrittenProseV3(prose, rest)).toEqual({ kind: 'accepted' });
  });

  it('judges the prose on its own citations: the placeholder picture lends it no passage', () => {
    const { prose } = split(validReply());
    // The prose cites e2 and e3 only; the heating passage (e1) alone states the figure in the dek.
    for (const item of prose.items)
      if (item.type !== 'section') item.cites = item.cites.map((cite) => (cite === 'e1' ? 'e2' : cite));
    prose.takeaway.cites = ['e2'];
    prose.dek = 'Why a kettle element draws 3 kilowatts, and where the heat goes.';
    const input = compileInputFor(validReply(), (mutable) => {
      mutable.passages['c-heat'] = `${HEAT} A typical element draws 3 kilowatts.`;
    });
    const { reply: _reply, plannedKinds: _planned, ...rest } = input;
    const outcome = compileWrittenProseV3(prose, rest);
    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' ? outcome.issues : []).toContainEqual(numberAt('dek'));
  });

  it('refuses prose for its own problems and names none about pictures', () => {
    const { prose } = split(validReply());
    const first = prose.items[1];
    if (first?.type === 'para')
      first.text = 'This starts by pointing back, and it goes on a while longer for the reader.';
    const aside = prose.items[7];
    if (aside?.type === 'aside') aside.text = 'We delve into what this picture leaves out of the essay.';
    const input = compileInputFor(validReply());
    const { reply: _reply, plannedKinds: _planned, ...rest } = input;
    const outcome = compileWrittenProseV3(prose, rest);
    expect(outcome.kind).toBe('refused');
    const issues = outcome.kind === 'refused' ? outcome.issues : [];
    expect(issues).toContainEqual(at('first_beat_points_back', 'items.1.text'));
    expect(issues).toContainEqual(at('machine_phrase', 'items.7.text'));
    expect(
      issues.some((issue) => /^(picture_|show_|link_|control_)/u.test(issue.code) || issue.path.startsWith('pictures')),
    ).toBe(false);
  });
});

describe('compileWrittenV3: a link that cannot be placed is left out', () => {
  /*
   * Item 6 (picture 1 on screen) carries three links: the good one, then a phrase that overlaps it, then one that occurs
   * twice. Item 5 (no show of its own; picture 1 stays on screen) carries an absent phrase and an unknown label. Item 9
   * has no picture on screen once the second picture's show moves to item 10.
   */
  const TWICE = 'water';
  const withBadLinks: Change = (reply) => {
    para(reply, 6).links = [
      { phrase: 'pocket of water vapour', part: 'Bubbles' },
      { phrase: 'water vapour', part: 'Bubbles' },
      { phrase: TWICE, part: 'Heat in' },
    ];
    para(reply, 5).links = [
      { phrase: 'a phrase the paragraph never says', part: 'Heat in' },
      { phrase: 'temperature climbs', part: 'Nowhere' },
    ];
    const beat = para(reply, 9);
    const next = para(reply, 10);
    next.show = beat.show;
    delete beat.show;
    beat.links = [{ phrase: 'vapour pressure', part: 'value' }];
  };

  it('keeps only the good link and lists each dropped link by code and path, at the model’s own item', () => {
    const outcome = compiled(withBadLinks);
    const beats = outcome.document.sections.flatMap((section) => section.beats);
    expect(beats[3]?.links).toEqual([]);
    expect(beats[4]?.links).toEqual([{ phrase: 'pocket of water vapour', part: 'p1-s3' }]);
    expect(beats[5]?.links).toEqual([]);
    expect(outcome.notices).toEqual([
      at('link_phrase_not_once', 'items.5.links.0.phrase'),
      at('link_part_unknown', 'items.5.links.1.part'),
      at('link_phrases_overlap', 'items.6.links.1.phrase'),
      at('link_phrase_not_once', 'items.6.links.2.phrase'),
      at('link_without_picture', 'items.9.links.0'),
    ]);
  });

  it('compiles a document the validator accepts, and the validator is as strict as before about a dangling link', () => {
    const outcome = compiled(withBadLinks);
    const stored = JSON.parse(JSON.stringify(outcome.document)) as unknown;
    expect(validateDocumentV3(stored)).toMatchObject({ kind: 'valid', notices: [] });
    // A link the compile left out, put back on the document, is refused by the validator.
    const document = JSON.parse(JSON.stringify(outcome.document)) as {
      sections: { beats: { links: { phrase: string; part: string }[] }[] }[];
    };
    const beat = document.sections[0]?.beats[4];
    if (beat === undefined) throw new Error('the fixture has this beat');
    beat.links.push({ phrase: TWICE, part: 'p1-s2' });
    const result = validateDocumentV3(document, { verify: false });
    expect(result.kind === 'invalid' ? result.issues.map((issue) => issue.code) : []).toContain('link_phrase_not_once');
  });

  it('a link that overlaps a link that was itself left out is kept: a dropped link holds no words', () => {
    const outcome = compiled((reply) => {
      para(reply, 6).links = [
        { phrase: 'a phrase the paragraph never says', part: 'Bubbles' },
        { phrase: 'pocket of water vapour', part: 'Bubbles' },
      ];
    });
    expect(outcome.notices).toEqual([at('link_phrase_not_once', 'items.6.links.0.phrase')]);
    expect(outcome.document.sections.flatMap((section) => section.beats)[4]?.links).toEqual([
      { phrase: 'pocket of water vapour', part: 'p1-s3' },
    ]);
  });

  it('judges a quotation’s links by the quotation’s own words', () => {
    const outcome = compiled((reply) => {
      const beat = para(reply, 2);
      reply.items[2] = {
        type: 'quote',
        text: HEAT,
        simple: beat.simple,
        who: 'A fixture author',
        cites: ['e1'],
        links: [
          { phrase: 'electric current', part: 'Heat in' },
          { phrase: 'not in the quotation at all', part: 'Heat in' },
        ],
      };
    });
    expect(outcome.notices).toEqual([at('link_phrase_not_once', 'items.2.links.1.phrase')]);
    expect(outcome.document.sections.flatMap((section) => section.beats)[1]?.links).toEqual([
      { phrase: 'electric current', part: 'p1-s2' },
    ]);
  });

  it('keeps a label that names two parts an issue, next to links that are only left out', () => {
    const issues = refused((reply) => {
      reply.pictures[1] = {
        kind: 'grid',
        title: 'Two kettles',
        cites: ['e2'],
        columns: [{ label: 'Small' }, { label: 'Large' }],
        rows: [{ label: 'Boils fast' }],
        cells: [
          { row: 'Boils fast', column: 'Small', text: 'Yes' },
          { row: 'Boils fast', column: 'Large', text: 'Yes' },
        ],
      };
      // Two cells say "Yes": a link to "Yes" names no one part. The other link only misses, and is left out.
      para(reply, 10).links = [
        { phrase: 'fixed temperature', part: 'Yes' },
        { phrase: 'a phrase the paragraph never says', part: 'Small' },
      ];
    });
    expect(issues).toContainEqual(at('picture_label_duplicate', 'items.10.links.0.part'));
    expect(issues.some((issue) => issue.path.startsWith('items.10.links.1'))).toBe(false);
  });

  it('records no notice for a reply whose links all fit', () => {
    expect(compiled().notices).toEqual([]);
  });

  it('still refuses the whole reply for another finding, and then carries no notices', () => {
    const outcome = compile((reply, input) => {
      withBadLinks(reply, input);
      para(reply, 2).cites = ['e1', 'e9'];
    });
    expect(outcome.kind).toBe('refused');
    const issues = outcome.kind === 'refused' ? outcome.issues : [];
    expect(issues).toContainEqual(at('authoring_cite_unknown', 'items.2'));
    expect(issues.some((issue) => issue.code.startsWith('link_'))).toBe(false);
  });
});

describe('repair hints', () => {
  it('has a hint for every code the findings above carried', () => {
    expect(seenCodes.size).toBeGreaterThan(15);
    for (const code of seenCodes) expect(REPAIR_HINTS_V3[code], code).toBeDefined();
  });
});

describe('compileWrittenV3: a figure finding says where the figure is (D-444)', () => {
  const issuesOfNumber = (change: Change): readonly IssueV3[] =>
    refused(change).filter((issue) => issue.code === 'authoring_number_not_in_evidence');

  it('miscited: the figure is in a passage the part does not cite, and the detail names it', () => {
    const found = issuesOfNumber((reply, input) => {
      input.passages['c-steam'] = `${input.passages['c-steam'] ?? ''} Typical elements draw 3 kilowatts.`;
      para(reply, 2).text =
        `${para(reply, 2).text.split(' ').slice(0, 40).join(' ')} Typical elements draw 3 kilowatts.`;
    });
    expect(found).toEqual([
      {
        code: 'authoring_number_not_in_evidence',
        path: 'items.2',
        detail: 'In the text, "3" is not in the passages this part cites, but e3 states it that way: cite e3.',
      },
    ]);
  });

  it('absent: no offered passage has the figure, and the detail says it is not in the research', () => {
    const found = issuesOfNumber((reply) => {
      para(reply, 2).text = `${para(reply, 2).text.split(' ').slice(0, 40).join(' ')} Kettles sold last year: 4821.`;
    });
    expect(found).toEqual([
      {
        code: 'authoring_number_not_in_evidence',
        path: 'items.2',
        detail:
          'In the text, "4821" is in none of the offered passages, so it is not in the research: take it out, or use a figure a passage states.',
      },
    ]);
  });

  it('written another way: the cited passage has the digits as one end of a range, and the detail quotes the research’s words', () => {
    const found = issuesOfNumber((reply, input) => {
      input.passages['c-heat'] = `${HEAT} Typical elements draw 2 to 3 kilowatts.`;
      para(reply, 2).text =
        `${para(reply, 2).text.split(' ').slice(0, 40).join(' ')} Typical elements draw 3 kilowatts.`;
    });
    expect(found).toEqual([
      {
        code: 'authoring_number_not_in_evidence',
        path: 'items.2',
        detail:
          'In the text, "3" is in e1, but only as one end of a range ("… draw 2 to 3 kilowatts."): a range counts only whole, so write both ends together, in the order the passage does, or say the figure in words.',
      },
    ]);
  });

  it('written another way: a magnitude word, and a simpler text that holds the same figure is named with the text', () => {
    const found = issuesOfNumber((reply, input) => {
      input.passages['c-heat'] = `${HEAT} About 8.3 million kettles were sold.`;
      const item = para(reply, 2);
      item.text = `${item.text.split(' ').slice(0, 40).join(' ')} About 8.3 kettles were sold.`;
      item.simple = `${item.simple} About 8.3 kettles were sold.`;
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toBe(
      'In the text and the simpler text, "8.3" is in e1, but with the word "million" after it ("… into heat. About 8.3 million kettles …"): write it with that word, or say it in words.',
    );
  });

  it('names the second end of a range as the other end of the first, once', () => {
    const found = issuesOfNumber((reply, input) => {
      input.passages['c-heat'] = `${HEAT} The share went from 17% in 1801 to 54% in 1891.`;
      const item = para(reply, 2);
      item.text = `${item.text.split(' ').slice(0, 40).join(' ')} By 1891 it was 54%, up from 17% in 1801.`;
    });
    expect(found).toHaveLength(1);
    const detail = found[0]?.detail ?? '';
    expect(detail).toContain('"54" is in e1, but only as one end of a range ("… in 1801 to 54% in 1891.")');
    expect(detail).toContain('"1801" is the other end of the same range: write the two together.');
  });

  it('keeps the rule: a chart of the two ends of "from 17% in 1801 to 54% in 1891" is refused for its label and its value, and the detail says why (the planned industrial-towns chart, D-444)', () => {
    const found = issuesOfNumber((reply, input) => {
      input.passages['c-steam'] = `${STEAM} The share living in larger cities rose from 17% in 1801 to 54% in 1891.`;
      reply.pictures[1] = {
        kind: 'chart',
        title: 'The share in larger cities',
        cites: ['e3'],
        form: 'line',
        unit: '%',
        values: 'shown',
        points: [
          { label: '1801', value: '17' },
          { label: '1891', value: '54' },
        ],
        marks: [],
      };
      para(reply, 9).show = { picture: 2, upTo: 1 };
      delete para(reply, 10).links;
    });
    expect(found.map((issue) => issue.path)).toEqual(['pictures.1', 'pictures.1.points.1.value']);
    expect(found[0]?.detail).toContain('In the point 1 label, "1801" is in e3, but only as one end of a range');
    expect(found[1]?.detail).toContain(
      'a chart value that ends a range passes only when the other end ("1801") is also one of the chart\'s values; if the other end is not something the chart plots (a year, a count), leave this point out and say the figure in words',
    );
  });

  it('keeps the rule, and so a chart of those figures passes only by plotting the year as a value, which the detail does not offer (D-444)', () => {
    const outcome = compile((reply, input) => {
      input.passages['c-steam'] = `${STEAM} The share living in larger cities rose from 17% in 1801 to 54% in 1891.`;
      reply.pictures[1] = {
        kind: 'chart',
        title: 'The share in larger cities',
        cites: ['e3'],
        form: 'bars',
        unit: '%',
        values: 'shown',
        points: [
          { label: 'Early', value: '17' },
          { label: 'Year', value: '1801' },
          { label: 'Late', value: '54' },
        ],
        marks: [],
      };
      para(reply, 9).show = { picture: 2, upTo: 1 };
      delete para(reply, 10).links;
    });
    expect(outcome.kind).toBe('compiled');
  });

  describe('a chart', () => {
    const chart =
      (unit: string, passage: string, cites = ['e2']) =>
      (reply: WrittenScrollV3, input: Mutable) => {
        input.passages['c-boil'] = BOIL;
        input.passages['c-steam'] = passage;
        reply.pictures[1] = {
          kind: 'chart',
          title: 'People near kettles',
          cites,
          form: 'bars',
          unit,
          values: 'shown',
          points: [
            { label: 'Town', value: '8.3' },
            { label: 'City', value: '9.1' },
          ],
          marks: [],
        };
        para(reply, 9).show = { picture: 2, upTo: 1 };
        delete para(reply, 10).links;
      };
    const detailAt = (outcome: readonly IssueV3[], path: string): string | undefined =>
      outcome.find((issue) => issue.path === path)?.detail;

    it('a point value that a cited passage writes with a magnitude word the unit lacks is told what the unit must open with', () => {
      const found = issuesOfNumber(
        chart('people', `${HEAT} Some 8.3 million people and 9.1 million people live nearby.`, ['e3']),
      );
      expect(detailAt(found, 'pictures.1.points.0.value')).toBe(
        'The value of point 1, "8.3", is in e3, but with the word "million" after it ("… into heat. Some 8.3 million people …"): the unit must open with "million", and the value stays as the passage writes it.',
      );
    });

    it('a point value in a passage the chart does not cite is told which passage to cite', () => {
      const found = issuesOfNumber(chart('people', `${STEAM} Some 8.3 people and 9.1 people live nearby.`));
      expect(detailAt(found, 'pictures.1.points.0.value')).toBe(
        'The value of point 1, "8.3", is not in the passages this chart cites, but e3 states it that way: cite e3.',
      );
    });

    it('a point value that no passage has at all is told it is not in the research', () => {
      const found = issuesOfNumber(chart('people', `${STEAM} Some 7 people live nearby.`));
      expect(detailAt(found, 'pictures.1.points.1.value')).toBe(
        'The value of point 2, "9.1", is in none of the offered passages, so it is not in the research: leave the point out, or use a figure a passage states.',
      );
    });

    it('a value that ends a range the chart does not hold whole is told the other end must be a value of the chart', () => {
      const found = issuesOfNumber(
        chart('people', `${STEAM} Some 7 to 8.3 people and 9.1 people live nearby.`, ['e3']),
      );
      expect(detailAt(found, 'pictures.1.points.0.value')).toBe(
        'The value of point 1, "8.3", is in e3, but only as one end of a range ("… Some 7 to 8.3 people and …"): a chart value that ends a range passes only when the other end ("7") is also one of the chart\'s values; if the other end is not something the chart plots (a year, a count), leave this point out and say the figure in words.',
      );
    });

    it('a unit is told apart from a value: the detail of the unit names the word no cited passage writes, and the value’s detail is not there', () => {
      const found = issuesOfNumber(
        chart('light years', `${STEAM} Some 8.3 people and 9.1 people live nearby.`, ['e3']),
      );
      expect(detailAt(found, 'pictures.1.unit')).toBe(
        'The unit "light years" has words that no passage this chart cites writes: "light", "year". Use a unit made of the words of a cited passage; the unit is not a figure and the values do not change.',
      );
      expect(detailAt(found, 'pictures.1.points.0.value')).toBeUndefined();
    });

    it('a unit with a sign the passages write ("%") is pointed at the sign', () => {
      const found = issuesOfNumber(chart('percent', `${STEAM} Some 8.3% and 9.1% live nearby.`, ['e3']));
      expect(detailAt(found, 'pictures.1.unit')).toContain('(the passages write the sign "%")');
    });
  });

  it('a Scroll whose figures are stated has no figure finding, and a refusal for something else carries none', () => {
    compiled();
    const found = refused((reply) => {
      reply.items = reply.items.slice(0, 8);
    });
    expect(found.some((issue) => issue.code === 'authoring_number_not_in_evidence')).toBe(false);
    expect(found.some((issue) => issue.detail !== undefined && issue.code !== 'copied_passage')).toBe(false);
  });

  it('a figure of the dek is judged against every passage the Scroll cites, and the detail says which one states it', () => {
    const found = issuesOfNumber((reply, input) => {
      input.passages['c-heat'] = `${HEAT} A typical element draws 3 kilowatts.`;
      reply.dek = 'Why a kettle element draws 3 kilowatts, and where the heat goes.';
      for (const item of reply.items)
        if (item.type !== 'section') item.cites = item.cites.map((cite) => (cite === 'e1' ? 'e2' : cite));
      reply.takeaway.cites = ['e2'];
      for (const picture of reply.pictures) picture.cites = ['e2'];
    });
    expect(found.find((issue) => issue.path === 'dek')?.detail).toBe(
      'In the text, "3" is in e1, which no part of the Scroll cites: cite e1 in a part of the Scroll, or take the figure out of this text.',
    );
  });
});
