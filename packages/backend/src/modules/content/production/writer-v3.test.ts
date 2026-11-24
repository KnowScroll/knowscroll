import { describe, expect, it } from 'vitest';
import { PROVENANCE_V3_LIMITS } from '@knowscroll/scroll-model/internal';
import {
  WrittenProseV3,
  WrittenScrollV3,
  WrittenStagingV3,
  writtenReferenceV3,
} from '@knowscroll/scroll-model/producer';
import { MAX_INSTRUCTION_CHARS, MAX_REPAIR_NOTES_CHARS } from '../../../reasoning/public.js';
import { RECIPES } from '../domain/library/index.js';
import { CITATIONS_TOO_MANY } from './citation-limits.js';
import { evidencePassages } from './evidence.js';
import { fixtureResearchPageV2 } from './spike-v2/writer-v2.fixture.js';
import { SPIKE_TOPICS_V3, spikePlanV3, type SpikeTopicV3 } from './spike-v3/plans.js';
import { fixtureProseV3, fixtureReplyV3, fixtureStagingV3 } from './spike-v3/writer-v3.fixture.js';
import {
  compileGeneratedScrollV3,
  compileStagedScrollV3,
  stagerContextItems,
  stagerRoleV3,
  STAGER_V3_VERSION,
  writerContextV3,
  writerRoleV3One,
  writerRoleV3Prose,
  WRITER_V3A_VERSION,
  WRITER_V3B_VERSION,
  type WriterV3Context,
} from './writer-v3.js';
import { writerInstructionsV3 } from './writer-v3-instructions.js';

// CI fixtures only: an invented planet, never product content (see `spike-v3/writer-v3.fixture.ts`).
const passages = evidencePassages([fixtureResearchPageV2]);
const context = (key: SpikeTopicV3 = 'seasons'): WriterV3Context =>
  writerContextV3(RECIPES.seasons, 1, spikePlanV3(key), passages, [fixtureResearchPageV2]);
const production = { kind: 'fixture', label: 'CI fixture' } as const;

/** A reply, a prose or a staging as plain data, so a test can break one thing in it. */
interface Draft {
  [key: string]: unknown;
  title: string;
  items: Record<string, unknown>[];
  pictures: Record<string, unknown>[];
  stage: Record<string, unknown>[];
}

/** The fixture as plain data with one edit. */
function edited(source: unknown, edit: (draft: Draft) => void): Draft {
  const draft = JSON.parse(JSON.stringify(source)) as Draft;
  edit(draft);
  return draft;
}

/** Changes some keys of one item (or picture, or stage entry) of a list. */
const patch = (list: Record<string, unknown>[], index: number, change: Record<string, unknown>): void => {
  list[index] = { ...list[index], ...change };
};

/** Paragraph item 13 of the fixture essay, the one about the equator; a test copies the research into it. */
const EQUATOR_ITEM = 13;
const COPIED_SENTENCE =
  'Near the equator the noon sun stays high in every season, so the tropics change far less across the year than the poles do.';

/** What the harness would hand the repair: the finding codes (a fixed catalogue) and the writer's own paths. */
function findingsOf(result: {
  success: boolean;
  error?: { issues: readonly { code: string; path: PropertyKey[]; params?: unknown }[] };
}) {
  return (result.error?.issues ?? []).map((issue) => ({
    code: issue.code === 'custom' ? (issue.params as { safeCode?: string } | undefined)?.safeCode : issue.code,
    path: issue.path.join('.'),
  }));
}

describe('the fixture replies', () => {
  it('compile for the seasons plan: three sections, two pictures of the planned kinds, strict figures', () => {
    const outcome = compileGeneratedScrollV3(fixtureReplyV3(), context(), production);
    expect(outcome.kind).toBe('compiled');
    if (outcome.kind !== 'compiled') return;
    expect(outcome.document.sections).toHaveLength(3);
    expect(outcome.document.pictures.map((picture) => picture.kind)).toEqual(['statement', 'grid']);
    expect(outcome.document.measures.mainWords).toBeGreaterThanOrEqual(350);
    expect(outcome.document.shape).toBe('argument');
    expect(outcome.document.kicker).toBe('A closer look');
    expect(outcome.document.theme.family).toBe('worlds');
    expect(outcome.document.assetId).toBe(RECIPES.seasons.assetId);
    expect(Object.keys(outcome.citations)).toContain('takeaway');
    expect(outcome.provenance.production).toEqual(production);
  });

  it('split into prose and staging, put together again, make the same document', () => {
    const whole = compileGeneratedScrollV3(fixtureReplyV3(), context(), production);
    const staged = compileStagedScrollV3(fixtureProseV3(), fixtureStagingV3(), context(), production);
    expect(staged.kind).toBe('compiled');
    expect(staged.kind === 'compiled' && whole.kind === 'compiled' && staged.document).toEqual(
      whole.kind === 'compiled' ? whole.document : undefined,
    );
  });

  it('keep a cell text that repeats, since only a reference to it is refused', () => {
    const reply = fixtureReplyV3();
    const grid = reply.pictures[1];
    const texts = grid?.kind === 'grid' ? grid.cells.map((cell) => cell.text) : [];
    expect(new Set(texts).size).toBeLessThan(texts.length);
  });
});

describe('the three roles', () => {
  it('are named, versioned and limited as the spike plan says', () => {
    const one = writerRoleV3One(context());
    const prose = writerRoleV3Prose(context());
    const stager = stagerRoleV3(context(), fixtureProseV3());
    expect([one.id, one.version]).toEqual(['content.scroll-writer', 'scroll-writer-v3a.v2']);
    expect([prose.id, prose.version]).toEqual(['content.scroll-writer', 'scroll-writer-v3b.v2']);
    expect([stager.id, stager.version]).toEqual(['content.scroll-stager', 'scroll-stager-v3.v2']);
    expect([WRITER_V3A_VERSION, WRITER_V3B_VERSION, STAGER_V3_VERSION]).toEqual([
      one.version,
      prose.version,
      stager.version,
    ]);
    for (const role of [one, prose, stager]) {
      expect(role.maxOutputTokens).toBe(16_000);
      expect(role.effort).toBe('medium');
      expect(role.repairWithPreviousAnswer).toBe(true);
      expect(role.version).toMatch(/^[A-Za-z0-9._-]{1,32}$/u);
    }
  });

  it('send a catalogue the harness accepts: lower-case codes, short fixed hints, at most 128, and a hint per name', () => {
    for (const role of [
      writerRoleV3One(context()),
      writerRoleV3Prose(context()),
      stagerRoleV3(context(), fixtureProseV3()),
    ]) {
      const catalogue = role.safeCustomIssues ?? {};
      const codes = Object.keys(catalogue);
      expect(codes.length).toBeLessThanOrEqual(128);
      for (const code of codes) {
        expect(code).toMatch(/^[a-z][a-z0-9_]{0,63}$/u);
        expect(catalogue[code]?.length).toBeGreaterThan(0);
        expect(catalogue[code]?.length).toBeLessThanOrEqual(256);
      }
      expect(codes).toEqual(expect.arrayContaining(['source_name_nasa', CITATIONS_TOO_MANY, 'copied_passage']));
      expect(catalogue[CITATIONS_TOO_MANY]).toContain(String(PROVENANCE_V3_LIMITS.claims));
    }
  });

  it('fit the harness limit on instructions, for every spike plan and every step', () => {
    for (const key of SPIKE_TOPICS_V3) {
      const roles = [
        writerRoleV3One(context(key)),
        writerRoleV3Prose(context(key)),
        stagerRoleV3(context(key), fixtureProseV3()),
      ];
      for (const role of roles) {
        expect(role.instructions.length, `${key} ${role.version}`).toBeLessThanOrEqual(MAX_INSTRUCTION_CHARS);
        expect(role.instructions.length).toBeGreaterThan(1000);
      }
    }
  });

  it('tell the writer of a picture that a chart always has its "marks", in the instructions and in the shape (D-440)', () => {
    for (const role of [writerRoleV3One(context()), stagerRoleV3(context(), fixtureProseV3())]) {
      expect(role.instructions, role.version).toContain('A chart always has a "marks" list');
      expect(role.instructions, role.version).toContain('"marks": [] when no point needs one');
      expect(role.instructions, role.version).toContain('"marks" is ALWAYS written');
    }
    expect(writerRoleV3Prose(context()).instructions).not.toContain('"marks"');
  });

  it('give each step its own instructions: the prose has no picture rules, the staging has no essay rules', () => {
    const plan = spikePlanV3('seasons');
    const one = writerRoleV3One(context()).instructions;
    const prose = writerRoleV3Prose(context()).instructions;
    const stager = stagerRoleV3(context(), fixtureProseV3()).instructions;
    expect(one).toBe(writerInstructionsV3('one', plan, writtenReferenceV3('one')));
    expect(one).toContain('PICTURES.');
    expect(prose).not.toContain('PICTURES.');
    expect(prose).toContain('THE ESSAY.');
    expect(stager).toContain('PICTURES.');
    expect(stager).not.toContain('THE ESSAY.');
    expect(stager).toContain('You may not change');
  });
});

describe('arm a: the whole Scroll in one reply', () => {
  const role = writerRoleV3One(context());

  it('accepts the fixture reply', () => {
    expect(role.outputSchema.safeParse(fixtureReplyV3()).success).toBe(true);
  });

  it('accepts a reply whose only fault is a link that cannot be placed, so it needs no repair, and lists the link as a notice', () => {
    const misplaced = edited(fixtureReplyV3(), (draft) => {
      // Item 2 shows nothing of its own; picture 1 is on screen from item 1, with the part "value" and no part "Nowhere".
      const words = String(draft.items[2]?.text).split(' ').slice(0, 3).join(' ');
      patch(draft.items, 2, {
        links: [
          { phrase: words, part: 'Nowhere' },
          { phrase: 'a phrase this paragraph never says', part: 'value' },
        ],
      });
    });
    expect(findingsOf(role.outputSchema.safeParse(misplaced))).toEqual([]);
    const outcome = compileGeneratedScrollV3(misplaced as never, context(), production);
    expect(outcome.kind === 'compiled' ? outcome.notices : undefined).toEqual([
      { code: 'link_part_unknown', path: 'items.2.links.0.part' },
      { code: 'link_phrase_not_once', path: 'items.2.links.1.phrase' },
    ]);
  });

  it('refuses a reply that breaks several rules at once, each finding at the model’s own item, with fixed codes', () => {
    const broken = edited(fixtureReplyV3(), (draft) => {
      patch(draft.items, 1, { text: `This ${String(draft.items[1]?.text)}` });
      patch(draft.items, 2, { cites: ['e99'] });
      patch(draft.items, 6, { show: { picture: 3 } });
    });
    const result = role.outputSchema.safeParse(broken);
    expect(result.success).toBe(false);
    const found = findingsOf(result);
    expect(found).toEqual(
      expect.arrayContaining([
        { code: 'first_beat_points_back', path: 'items.1.text' },
        { code: 'authoring_cite_unknown', path: 'items.2' },
        { code: 'show_picture_unknown', path: 'items.6.show.picture' },
      ]),
    );
    for (const { code } of found) expect(role.safeCustomIssues).toHaveProperty([code ?? '']);
  });

  it('refuses the planned kinds in the wrong order, at the picture', () => {
    const swapped = edited(fixtureReplyV3(), (draft) => {
      draft.pictures.reverse();
    });
    const found = findingsOf(role.outputSchema.safeParse(swapped));
    expect(found.map((finding) => finding.code)).toContain('picture_kind_unplanned');
  });

  it('refuses a source’s name anywhere a reader reads: a title, an item and a picture', () => {
    const named = edited(fixtureReplyV3(), (draft) => {
      draft.title = 'What NASA says about why Orrin has seasons';
      patch(draft.items, 2, { text: `${String(draft.items[2]?.text)} Read spaceplace.nasa.gov for more.` });
      patch(draft.pictures, 0, { title: 'NASA’s number for the lean' });
    });
    const found = findingsOf(role.outputSchema.safeParse(named));
    expect(found).toEqual(
      expect.arrayContaining([
        { code: 'source_name_nasa', path: 'title' },
        { code: 'source_name_nasa', path: 'items.2' },
        { code: 'source_name_nasa', path: 'pictures.0' },
      ]),
    );
  });

  it('refuses a paragraph copied from the research and says which words, for the repair', () => {
    const copied = edited(fixtureReplyV3(), (draft) => {
      patch(draft.items, EQUATOR_ITEM, { text: COPIED_SENTENCE });
    });
    expect(findingsOf(role.outputSchema.safeParse(copied))).toContainEqual({
      code: 'copied_passage',
      path: `items.${String(EQUATOR_ITEM)}`,
    });
    const notes = role.repairNotes?.(JSON.stringify(copied));
    expect(notes).toContain(
      `items[${String(EQUATOR_ITEM)}]: Nine or more words in a row match the research, in the text: "near the equator the noon sun stays high`,
    );
    expect(role.repairNotes?.('not json')).toBeUndefined();
    expect(role.repairNotes?.(JSON.stringify(fixtureReplyV3()))).toBeUndefined();
    expect(role.repairNotes?.(JSON.stringify({ title: 'not a reply' }))).toBeUndefined();
  });

  it('refuses a reply whose only fault is a copied run, sends the harness the fixed hint, and the repair notes carry the part and the quoted words (D-440)', () => {
    const copied = edited(fixtureReplyV3(), (draft) => {
      patch(draft.items, EQUATOR_ITEM, { simple: `${COPIED_SENTENCE} Say it twice.` });
    });
    const found = findingsOf(role.outputSchema.safeParse(copied));
    expect(found).toEqual([{ code: 'copied_passage', path: `items.${String(EQUATOR_ITEM)}` }]);
    // What the harness hands the repair for the finding is the role's one fixed hint: it cannot carry the words.
    expect(role.safeCustomIssues?.['copied_passage']).toContain('The repair notes');
    const notes = role.repairNotes?.(JSON.stringify(copied)) ?? '';
    expect(notes.length).toBeLessThanOrEqual(MAX_REPAIR_NOTES_CHARS);
    expect(notes).toContain(
      `items[${String(EQUATOR_ITEM)}]: Nine or more words in a row match the research, in the simpler text: "near the equator the noon sun stays high in every season so the tropics change …". Rewrite them in your own words, with a different sentence structure.`,
    );
    // Only the research's words and the place are named; nothing of what the model wrote besides.
    expect(notes).not.toContain('Say it twice');
  });

  it('names a copy in a picture caption, with the part and the words', () => {
    const copied = edited(fixtureReplyV3(), (draft) => {
      patch(draft.pictures, 1, { caption: COPIED_SENTENCE });
    });
    const notes = role.repairNotes?.(JSON.stringify(copied)) ?? '';
    expect(notes).toContain(
      'pictures[1]: Nine or more words in a row match the research, in the caption: "near the equator',
    );
  });

  it('still names a copy in a reply the shape refused first (a chart without its marks), which the compile never read', () => {
    const copied = edited(fixtureReplyV3(), (draft) => {
      patch(draft.items, EQUATOR_ITEM, { text: COPIED_SENTENCE });
      draft.pictures[0] = {
        kind: 'chart',
        title: 'A chart',
        cites: ['e1'],
        form: 'bars',
        values: 'shown',
        points: [
          { label: 'A', value: '1' },
          { label: 'B', value: '2' },
        ],
      };
    });
    // The shape finding is all the model is told by the first answer's findings: the copy rule did not run behind it.
    const codes = findingsOf(role.outputSchema.safeParse(copied)).map((finding) => finding.code);
    expect(codes).not.toContain('copied_passage');
    expect(role.repairNotes?.(JSON.stringify(copied))).toContain(
      `items[${String(EQUATOR_ITEM)}]: Nine or more words in a row match the research, in the text: "near the equator`,
    );
  });

  it('names a repeated cell text as fine and a link to it as refused, at the link', () => {
    const linked = edited(fixtureReplyV3(), (draft) => {
      patch(draft.items, 7, { links: [{ phrase: 'spread thin', part: 'Short cool days' }] });
    });
    const found = findingsOf(writerRoleV3One(context()).outputSchema.safeParse(linked));
    expect(found).toContainEqual({ code: 'picture_label_duplicate', path: 'items.7.links.0.part' });
  });
});

describe('arm b, first step: the prose', () => {
  const role = writerRoleV3Prose(context());

  it('accepts the fixture prose, which has no picture, show, link or control', () => {
    expect(role.outputSchema.safeParse(fixtureProseV3()).success).toBe(true);
  });

  it('refuses a reply that carries a picture: the prose shape has no such key', () => {
    const withPictures = { ...fixtureProseV3(), pictures: fixtureReplyV3().pictures };
    expect(findingsOf(role.outputSchema.safeParse(withPictures)).map((finding) => finding.code)).toContain(
      'unrecognized_keys',
    );
  });

  it('runs the prose checks and none about pictures', () => {
    const prose = edited(fixtureProseV3(), (draft) => {
      patch(draft.items, 3, { cites: ['e99'] });
      patch(draft.items, 2, {
        text: 'It is important to note that the orbit is nearly a circle, so distance cannot be the lever.',
      });
    });
    const found = findingsOf(role.outputSchema.safeParse(prose));
    expect(found).toEqual(
      expect.arrayContaining([
        { code: 'authoring_cite_unknown', path: 'items.3' },
        { code: 'machine_phrase', path: 'items.2.text' },
      ]),
    );
    expect(found.filter((finding) => /^(picture_|show_|link_|control_)/u.test(finding.code ?? ''))).toEqual([]);
  });

  it('gives the copy notes of a refused prose', () => {
    const prose = edited(fixtureProseV3(), (draft) => {
      patch(draft.items, EQUATOR_ITEM, { text: COPIED_SENTENCE });
    });
    expect(role.repairNotes?.(JSON.stringify(prose))).toContain(
      `items[${String(EQUATOR_ITEM)}]: Nine or more words in a row match the research, in the text: "near the equator`,
    );
    expect(role.repairNotes?.(JSON.stringify(fixtureProseV3()))).toBeUndefined();
  });
});

describe('arm b, second step: the staging', () => {
  const role = stagerRoleV3(context(), fixtureProseV3());

  it('accepts the fixture staging over the prose it was written for', () => {
    expect(role.outputSchema.safeParse(fixtureStagingV3()).success).toBe(true);
  });

  it('reports each finding where the staging model wrote the cause: a stage entry or a picture', () => {
    const staging = edited(fixtureStagingV3(), (draft) => {
      patch(draft.stage, 1, { show: { picture: 3 } });
      patch(draft.stage, 2, { links: [{ phrase: 'not in this paragraph', part: 'Northern half' }] });
      patch(draft.stage, 3, { para: 12 });
    });
    const found = findingsOf(role.outputSchema.safeParse(staging));
    expect(found).toEqual(
      expect.arrayContaining([
        { code: 'show_picture_unknown', path: 'stage.1.show.picture' },
        { code: 'stage_para_unknown', path: 'stage.3.para' },
      ]),
    );
    expect(found.some((finding) => finding.path.startsWith('items'))).toBe(false);
  });

  it('refuses a paragraph staged twice and a control on a quotation', () => {
    const beats = fixtureProseV3().items.filter((item) => item.type === 'para' || item.type === 'quote');
    const quoteNumber = beats.findIndex((item) => item.type === 'quote') + 1;
    const staging = edited(fixtureStagingV3(), (draft) => {
      draft.stage.push({ ...draft.stage[0] });
      draft.stage.push({ para: quoteNumber, control: { kind: 'pick', label: 'Pick one' } });
    });
    const found = findingsOf(role.outputSchema.safeParse(staging));
    const last = staging.stage.length - 1;
    expect(found).toEqual(
      expect.arrayContaining([
        { code: 'stage_para_repeated', path: `stage.${String(last - 1)}.para` },
        { code: 'control_unfit', path: `stage.${String(last)}.control` },
      ]),
    );
  });

  it('refuses a picture that no paragraph shows, at the staging reply’s own list', () => {
    const staging = edited(fixtureStagingV3(), (draft) => {
      draft.stage = draft.stage.filter((entry) => (entry.show as { picture?: number } | undefined)?.picture !== 2);
    });
    const found = findingsOf(role.outputSchema.safeParse(staging));
    expect(found.map((finding) => finding.code)).toContain('picture_unshown');
  });

  it('refuses a source’s name in a picture, at the picture', () => {
    const staging = edited(fixtureStagingV3(), (draft) => {
      patch(draft.pictures, 0, { title: 'NASA’s lean of the axis' });
    });
    expect(findingsOf(role.outputSchema.safeParse(staging))).toContainEqual({
      code: 'source_name_nasa',
      path: 'pictures.0',
    });
  });

  it('has no repair notes: there is no copied prose to point at', () => {
    expect(role.repairNotes).toBeUndefined();
  });

  it('is shown the numbered prose, the passages and the plan, as data, in that order', () => {
    const items = stagerContextItems(context(), fixtureProseV3(), 'seasons');
    expect(items.map((item) => item.kind)).toEqual(['written_prose', 'public_research_passages', 'scroll_plan']);
    expect(items[0]?.text).toContain('P1 ');
    expect(items[0]?.text).toContain('(quotation, An invented field guide)');
    expect(items[1]?.text).toContain('[e1]');
    expect(items[2]?.text).toContain('Shape: argument');
    expect(items[2]?.text).toContain('1. a statement:');
    expect(items[2]?.text).toContain('2. a grid:');
    expect(stagerContextItems(context('dns-lookup'), fixtureProseV3(), 'dns-lookup')[2]?.text).toContain(
      'choose one to three kinds',
    );
  });
});

describe('compile for one job', () => {
  it('lets the pictures the plan leaves to the writer be any kind', () => {
    expect(compileGeneratedScrollV3(fixtureReplyV3(), context('dns-lookup'), production).kind).toBe('compiled');
  });

  it('is deterministic, and its schema never throws on the shapes it is given', () => {
    const first = compileGeneratedScrollV3(fixtureReplyV3(), context(), production);
    const second = compileGeneratedScrollV3(fixtureReplyV3(), context(), production);
    expect(first).toEqual(second);
    expect(WrittenScrollV3.safeParse({}).success).toBe(false);
    expect(WrittenProseV3.safeParse({}).success).toBe(false);
    expect(WrittenStagingV3.safeParse({}).success).toBe(false);
  });
});
