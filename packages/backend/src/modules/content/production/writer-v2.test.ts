import { describe, expect, it } from 'vitest';
import { kitDefinition, kitKeys, LIMITS_V2 } from '@knowscroll/scroll-model';
import { AuthoredScrollV2 } from '@knowscroll/scroll-model/producer';
import { evidencePassages } from './evidence.js';
import { spikeRecipeV2 } from './spike-v2/topics.js';
import { extractResearch } from '../../../infrastructure/research/public-pages.js';
import { FIXTURE_SOURCE_V2, fixtureAuthoredV2, fixtureResearchPageV2 } from './spike-v2/writer-v2.fixture.js';
import { WRITER_PROMPT_VERSION } from './writer.js';
import {
  compileGeneratedScrollV2,
  publicationV2,
  writerInstructionsV2,
  writerRoleV2,
  WRITER_V2_PROMPT_VERSION,
  type WriterV2Context,
} from './writer-v2.js';

const passages = evidencePassages([fixtureResearchPageV2]);
const context = (key: 'seasons' | 'dns-lookup' = 'seasons'): WriterV2Context => ({
  publication: publicationV2(key),
  recipe: spikeRecipeV2(key),
  passages,
  pages: [fixtureResearchPageV2],
});

/** The fixture with an edit, parsed again so only schema-valid input reaches the compile. */
function changed(
  edit: (draft: { items: Record<string, unknown>[]; [key: string]: unknown }) => void,
): AuthoredScrollV2 {
  const draft = JSON.parse(JSON.stringify(fixtureAuthoredV2())) as { items: Record<string, unknown>[] };
  edit(draft);
  return AuthoredScrollV2.parse(draft);
}

describe('the v21 writer', () => {
  it('has its own version and leaves the v1 writer’s alone', () => {
    expect(WRITER_V2_PROMPT_VERSION).toBe('scroll-writer.v21');
    expect(WRITER_PROMPT_VERSION).toBe('scroll-writer.v13');
    expect(writerRoleV2(context()).version).toBe('scroll-writer.v21');
    expect(writerRoleV2(context()).id).toBe('content.scroll-writer');
  });

  it('tells the writer, for every recipe, to keep calls to what the pages state and to give an effect its size', () => {
    for (const key of ['seasons', 'tides', 'stars-fusion', 'black-hole-horizon', 'dns-lookup'] as const) {
      const text = writerInstructionsV2(spikeRecipeV2(key));
      expect(text, key).toContain('a fact the passages do not state must never be the subject of a call');
      expect(text, key).toContain('never “slightly” or “a little”');
    }
  });

  it('compiles the recorded fixture answer for a stage recipe with a myth', () => {
    const outcome = compileGeneratedScrollV2(fixtureAuthoredV2(), context());
    expect(outcome.kind).toBe('compiled');
    if (outcome.kind !== 'compiled') return;
    expect(outcome.document.stage?.states.length).toBeGreaterThanOrEqual(3);
    expect(outcome.document.measures.readingMinutes).toBeGreaterThanOrEqual(3);
    expect(outcome.document.misconception.kind).toBe('myth');
    // The fixture's labelled source is the seasons recipe's, not the fixture's.
    expect(outcome.document.misconception.kind === 'myth' && outcome.document.misconception.source.label).toContain(
      'Private Universe',
    );
  });

  it('accepts an answer that follows the prompt literally: a two-option myth call with the guess second, no stage on any call', () => {
    const answer = fixtureAuthoredV2();
    const first = answer.items.find((item) => item.type === 'call_it');
    expect(first?.options).toHaveLength(2);
    expect(JSON.stringify(answer)).not.toContain('commonGuess');
    expect(
      answer.items.every((item) => item.type === 'stop' || item.type === 'aside' || item.stage === undefined),
    ).toBe(true);
    const outcome = compileGeneratedScrollV2(answer, context());
    expect(outcome.kind).toBe('compiled');
    if (outcome.kind !== 'compiled') return;
    const call = outcome.document.stops.find((stop) => stop.kind === 'call_it');
    if (call?.kind !== 'call_it') throw new Error('expected a Call it');
    // The second authored option is the one the misconception names, wherever the shuffle put it.
    expect(call.commonGuess?.option).toBe(call.options.indexOf(first?.options[1] ?? ''));
    expect(call.options[call.answer]).toBe(first?.options[0]);
    expect(writerRoleV2(context()).outputSchema.safeParse(answer).success).toBe(true);
  });

  it('refuses the shapes the v14 prompt allowed: a number for the guess and a tilt chosen by the writer', () => {
    const withGuess = JSON.parse(JSON.stringify(fixtureAuthoredV2())) as { items: Record<string, unknown>[] };
    withGuess.items[1] = { ...withGuess.items[1], commonGuess: 2 };
    expect(AuthoredScrollV2.safeParse(withGuess).success).toBe(false);
    const withAxis = JSON.parse(JSON.stringify(fixtureAuthoredV2())) as { items: Record<string, unknown>[] };
    withAxis.items[0] = { ...withAxis.items[0], stage: { view: 'sun-earth', axis: 'sideways' } };
    // The shape allows a few words by key; the recipe's kit has no "axis" word, so the compile refuses it.
    const refused = compileGeneratedScrollV2(AuthoredScrollV2.parse(withAxis), context());
    expect(refused.kind === 'refused' && refused.issues).toContainEqual({
      code: 'stage_choice_invalid',
      path: 'items.0.stage',
    });
  });

  it('keeps asides, stages and the misconception to what the recipe decided', () => {
    const plain = compileGeneratedScrollV2(fixtureAuthoredV2(), context('dns-lookup'));
    expect(plain.kind === 'refused' && plain.issues.map((issue) => issue.code)).toContain('stage_unexpected');
  });

  it('refuses a reader name of a source the Scroll rests on, at the writer’s item', () => {
    const named = changed((draft) => {
      draft.items[2] = {
        ...draft.items[2],
        text: 'NASA says the orbit is almost a circle, and so the nearest and farthest points hardly matter.',
      };
    });
    const outcome = compileGeneratedScrollV2(named, context());
    expect(outcome.kind === 'refused' && outcome.issues).toEqual(
      expect.arrayContaining([{ code: 'source_name_nasa', path: 'items.2' }]),
    );
  });

  it('refuses a stop copied from the research and says which words, for the repair', () => {
    const copied = changed((draft) => {
      draft.items[2] = {
        ...draft.items[2],
        text: 'Near the equator the noon sun stays high in every season, so the tropics change far less across the year than the poles do.',
      };
    });
    const refused = compileGeneratedScrollV2(copied, context());
    expect(refused.kind === 'refused' && refused.issues).toContainEqual({ code: 'copied_passage', path: 'items.2' });
    const role = writerRoleV2(context());
    const notes = role.repairNotes?.(JSON.stringify(copied));
    expect(notes).toContain('items[2] copies:');
    expect(notes).toContain('near the equator the noon sun stays high');
    expect(role.repairNotes?.('not json')).toBeUndefined();
    expect(role.repairNotes?.(JSON.stringify(fixtureAuthoredV2()))).toBeUndefined();
  });
});

describe('the v15 writer role', () => {
  it('accepts the fixture answer and refuses a broken one with fixed codes only', () => {
    const role = writerRoleV2(context());
    expect(role.outputSchema.safeParse(fixtureAuthoredV2()).success).toBe(true);
    const broken = changed((draft) => {
      draft.items[3] = { ...draft.items[3], cites: ['e99'], text: Array.from({ length: 70 }, () => 'word').join(' ') };
    });
    const result = role.outputSchema.safeParse(broken);
    expect(result.success).toBe(false);
    const safeCodes = (result.error?.issues ?? []).flatMap((issue) =>
      issue.code === 'custom' ? [(issue.params as { safeCode?: string } | undefined)?.safeCode] : [],
    );
    expect(safeCodes).toEqual(expect.arrayContaining(['authoring_cite_unknown', 'stop_too_long']));
    const paths = (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
    expect(paths).toContain('items.3');
  });

  it('sends a catalogue the harness accepts: lower-case codes, short fixed hints, at most 128', () => {
    const catalogue = writerRoleV2(context()).safeCustomIssues ?? {};
    const codes = Object.keys(catalogue);
    expect(codes.length).toBeLessThanOrEqual(128);
    for (const code of codes) {
      expect(code).toMatch(/^[a-z][a-z0-9_]{0,63}$/u);
      expect(catalogue[code]?.length).toBeGreaterThan(0);
      expect(catalogue[code]?.length).toBeLessThanOrEqual(256);
    }
    expect(codes).toContain('source_name_nasa');
  });

  it('asks for one repair that carries the refused answer, and at most 16,000 tokens including thinking', () => {
    const role = writerRoleV2(context());
    expect(role.repairWithPreviousAnswer).toBe(true);
    expect(role.maxOutputTokens).toBe(16_000);
    expect(role.effort).toBe('medium');
  });
});

describe('the v15 instructions', () => {
  it('state the shape, the budget, the voice and the rules the checks enforce', () => {
    const text = writerInstructionsV2(spikeRecipeV2('seasons'));
    for (const phrase of [
      'at most 4 calls',
      'final_call',
      '"limits"',
      '60 words',
      '12 words',
      'FIRST',
      'nine words in a row',
      'cites',
      '3 to 6 minutes',
      'second person',
    ])
      expect(text).toContain(phrase);
    expect(text.length).toBeLessThan(32_768);
  });

  it('name the misconception of the recipe, with no source, and put its wrong option second, with no number to count', () => {
    const text = writerInstructionsV2(spikeRecipeV2('seasons'));
    expect(text).toContain('closer to the Sun in summer');
    expect(text).toContain('the wrong option that states this idea SECOND');
    expect(text).toContain('write no number for it');
    expect(text).not.toContain('commonGuess');
    expect(text).toContain('without naming any study or source');
    expect(text).not.toContain('Private Universe');
  });

  it('say there is no misconception when the recipe has none', () => {
    const text = writerInstructionsV2(spikeRecipeV2('industrial-causes'));
    expect(text).toContain('names no misconception');
    expect(text).not.toContain('THE MISCONCEPTION');
  });

  it('describe the picture and its kit only for a stage recipe', () => {
    const stage = writerInstructionsV2(spikeRecipeV2('seasons'));
    expect(stage).toContain('PINNED PICTURE');
    expect(stage).toContain('view: sun-earth | orbit | orbit-stretched | earth-close | moon-orbit');
    expect(stage).toContain('earthAt: jan | feb');
    // The writer chooses no tilt, pin or Ray: code derives them from the month.
    for (const gone of ['axis:', 'northPin', 'southPin', 'ray:', 'upright']) expect(stage).not.toContain(gone);
    expect(stage).toContain('Earth’s tilt is fixed');
    expect(stage).toContain('"orbit" shows Earth’s orbit from above, drawn to scale');
    expect(stage).toContain('"orbit-stretched" is the same orbit stretched');
    expect(stage).toContain('follow from the month');
    const plain = writerInstructionsV2(spikeRecipeV2('dns-lookup'));
    expect(plain).toContain('NO PICTURE');
    expect(plain).not.toContain('earthAt');
    expect(plain).not.toContain('"stage":{…}');
  });

  it('say a call never changes the picture, and say it as the validator does', () => {
    const text = writerInstructionsV2(spikeRecipeV2('seasons'));
    expect(text).toContain('A call never changes the picture');
    expect(text).toContain('Write "stage" on stops only, never on a call_it or the final_call');
    expect(text).toContain('show the answer by changing the picture on the stop right after the call');
    expect(text).not.toContain('set the picture to show the answer when the call is revealed');
    // The shape the prompt shows carries no stage on a call either.
    const shape = text.slice(text.indexOf('call_it: {'), text.indexOf('aside: {'));
    expect(shape).not.toContain('"stage"');
    const stop = text.slice(text.indexOf('stop: {'), text.indexOf('call_it: {'));
    expect(stop).toContain('"stage":{…}');
  });

  it('ask for a Final call that is a new case', () => {
    expect(writerInstructionsV2(spikeRecipeV2('seasons'))).toContain('its question and its correct answer must be new');
  });

  it('say Earth’s axis is tilted and never sideways, for a stage recipe only, and that such a text is refused', () => {
    const stage = writerInstructionsV2(spikeRecipeV2('seasons'));
    expect(stage).toContain('Earth’s axis is tilted by a fixed angle');
    expect(stage).toContain('never call it sideways or say it lies on its side');
    expect(stage).toContain('A text that does so is refused');
    // Uranus really does spin sideways, so a plain Scroll about other worlds is not told otherwise.
    const elsewhere = writerInstructionsV2(spikeRecipeV2('seasons-elsewhere'));
    expect(elsewhere).toContain('NO PICTURE');
    expect(elsewhere).not.toContain('never call it sideways');
  });

  it('give "Seasons elsewhere" no picture, because the kit draws no other world', () => {
    const recipe = spikeRecipeV2('seasons-elsewhere');
    expect(recipe.variant).toBe('plain');
    expect(writerInstructionsV2(recipe)).not.toContain('earthAt');
    expect(writerInstructionsV2(recipe)).not.toContain('Earth for comparison');
  });

  it('refuse a stage Scroll that calls Earth’s axis sideways, with a fixed hint the repair can use', () => {
    const answer = JSON.parse(JSON.stringify(fixtureAuthoredV2())) as { items: Record<string, unknown>[] };
    answer.items[2] = {
      ...answer.items[2],
      text: 'Earth’s sideways axis points the same way all year, and that is what makes the seasons.',
    };
    const outcome = compileGeneratedScrollV2(AuthoredScrollV2.parse(answer), context());
    expect(outcome.kind === 'refused' && outcome.issues).toContainEqual({
      code: 'earth_axis_sideways',
      path: 'items.2',
    });
    expect(writerRoleV2(context()).safeCustomIssues?.['earth_axis_sideways']).toContain('never call it sideways');
  });

  it('tell the writer to ignore the v1 layout words of a brief', () => {
    expect(writerInstructionsV2(spikeRecipeV2('seasons'))).toContain('Ignore anything in it about diagrams');
  });
});

describe('the Final call that turns the tilt (D-187)', () => {
  const BOUND = 'THE FINAL CALL IS PLAYED WITH A CONTROL';

  it('asks a recipe that hands the reader the tilt for a "what if the axis were not tilted" Final call and a June or December ending', () => {
    const text = writerInstructionsV2(spikeRecipeV2('seasons'));
    expect(text).toContain(BOUND);
    expect(text).toContain('if the axis were not tilted at all');
    expect(text).toContain('the reader can turn Earth’s axis');
    expect(text).toContain('end the Scroll on a June or December picture (earthAt "jun" or "dec")');
    expect(text).toContain('turning the tilt changes nothing, and a Scroll that ends there is refused');
  });

  it('says none of it to a recipe that hands the reader nothing: the other Seasons parts and a recipe with no picture', () => {
    for (const key of ['seasons-hemispheres', 'dns-lookup'] as const) {
      const text = writerInstructionsV2(spikeRecipeV2(key));
      expect(text, key).not.toContain(BOUND);
      expect(text, key).not.toContain('if the axis were not tilted at all');
      expect(text, key).not.toContain('June or December picture');
    }
  });

  it('follows the plan: only a recipe whose plan names the control gets the words, and removing it removes them', () => {
    const recipe = spikeRecipeV2('seasons');
    expect(recipe.finalCall).toEqual({ kind: 'tilt' });
    const { finalCall: _removed, ...unbound } = recipe;
    expect(writerInstructionsV2(unbound)).not.toContain(BOUND);
  });
});

/** One recipe for each drawing kit of D-194: the recipe's own `stageKit` decides which kit its Scroll is drawn with. */
const KIT_RECIPES = [
  ['tides.v1', 'tides', 'The picture draws no coast, place or time of day; coasts belong to the text.'],
  ['greenhouse.v1', 'greenhouse-radiation', 'In it the layer lets sunlight through'],
  ['star.v1', 'stars-fusion', 'The picture draws no years, no figures and no named star'],
  ['transit.v1', 'exoplanet-transit', 'The picture is the transit method only'],
  ['circulation.v1', 'cardiac-cycle', 'The picture draws no heart rate, no blood pressure figure'],
  ['nerve.v1', 'action-potential', 'The picture draws no voltage figure, speed or time'],
  ['starlight.v1', 'exoplanet-habitable-zone', 'A habitable zone is where liquid water could exist on a surface'],
  [
    'black-hole.v1',
    'black-hole-horizon',
    'The picture draws stellar-mass black holes made by a massive star’s collapse',
  ],
] as const;

describe.each(KIT_RECIPES)('the v19 writer for a recipe drawn with %s', (kit, key, sentence) => {
  const kitContext = (): WriterV2Context => ({
    ...context(),
    publication: publicationV2(key),
    recipe: spikeRecipeV2(key),
  });

  it('is a stage recipe of that kit, and its instructions give that kit’s words and no other kit’s', () => {
    const recipe = spikeRecipeV2(key);
    expect(recipe).toMatchObject({ variant: 'stage', kit });
    const text = writerInstructionsV2(recipe);
    expect(text).toContain('PINNED PICTURE');
    expect(text).toContain(sentence);
    for (const [other] of KIT_RECIPES.filter(([candidate]) => candidate !== kit))
      expect(text, other).not.toContain(kitDefinition(other).writerGuide[0] ?? 'x');
    expect(text).not.toContain('earthAt');
    expect(text).not.toContain('never call it sideways');
    // The tides facet on coasts is covered by the text, so the guide must not tell the writer to say nothing about one.
    if (kit === 'tides.v1') expect(text).not.toContain('Say nothing that depends on one');
    expect(text.length).toBeLessThan(32_768);
  });

  it('lists the keys and words of the kit in the shape, for the stage object', () => {
    const text = writerInstructionsV2(spikeRecipeV2(key));
    const definition = kitDefinition(kit);
    for (const stageKey of kitKeys(definition))
      expect(text).toContain(`${stageKey}: ${(definition.enums[stageKey] ?? []).join(' | ')}`);
  });

  it('compiles the recorded answer drawn with that kit, and the role accepts it', () => {
    const outcome = compileGeneratedScrollV2(fixtureAuthoredV2(kit), kitContext());
    expect(outcome.kind === 'refused' ? outcome.issues : []).toEqual([]);
    if (outcome.kind !== 'compiled') return;
    expect(outcome.document.stage?.kit).toBe(kit);
    expect(outcome.document.stage?.states.length).toBeGreaterThanOrEqual(3);
    expect(writerRoleV2(kitContext()).outputSchema.safeParse(fixtureAuthoredV2(kit)).success).toBe(true);
  });

  it('refuses the Earth & sky answer for this recipe, with a fixed hint the repair can use', () => {
    const outcome = compileGeneratedScrollV2(fixtureAuthoredV2(), kitContext());
    expect(outcome.kind === 'refused' && outcome.issues).toContainEqual({
      code: 'stage_choice_invalid',
      path: 'items.0.stage',
    });
    expect(writerRoleV2(kitContext()).safeCustomIssues?.['stage_choice_invalid']).toContain('keys and words listed');
  });
});

describe('the play blocks and the guide in the writer’s instructions (D-207)', () => {
  const asked = (blocks: readonly ('sort' | 'fork' | 'scale' | 'chart')[], guide?: 'ray') =>
    writerInstructionsV2({ ...spikeRecipeV2('dns-lookup'), blocks, ...(guide === undefined ? {} : { guide }) });

  it('says nothing about blocks or a guide to a recipe that names none, so its instructions are the v19 ones', () => {
    const plain = writerInstructionsV2(spikeRecipeV2('dns-lookup'));
    expect(plain).not.toMatch(/PLAY BLOCK|HAS A GUIDE|"type":"sort"|"type":"chart"/u);
    expect(plain).toContain('Ignore anything in it about diagrams, sliders, simulations, steppers, charts');
  });

  it('describes only the blocks the recipe names, with the rule about figures for a scale and a chart', () => {
    const text = asked(['sort', 'chart']);
    expect(text).toContain('THIS SCROLL HAS PLAY BLOCKS: sort and chart');
    expect(text).toMatch(/- sort: the reader puts steps in order/u);
    expect(text).toMatch(/- chart: the reader reveals the points/u);
    expect(text).not.toMatch(/- fork:|- scale:/u);
    expect(text).toContain('never invent, round or fill in a point');
    expect(text).toContain('the play blocks named below');
  });

  it('asks the writer for a guide that speaks rarely and cites, when the recipe names one', () => {
    const text = asked([], 'ray');
    expect(text).toContain('THIS SCROLL HAS A GUIDE. Ray, a friendly sunbeam');
    expect(text).toContain(`at most ${String(LIMITS_V2.guides)} lines`);
    expect(text).toContain('The line is a claim');
  });

  it('reaches the model: the role carries the blocks of the recipe and refuses an answer without them', () => {
    const recipe = { ...spikeRecipeV2('dns-lookup'), blocks: ['sort'] as const };
    const role = writerRoleV2({ ...context('dns-lookup'), recipe });
    expect(role.instructions).toContain('"type":"sort"');
    // The recorded plain answer has no sort: the recipe names one, so the role refuses it with a fixed finding.
    const refused = role.outputSchema.safeParse(fixtureAuthoredV2());
    expect(refused.success).toBe(false);
    if (!refused.success)
      expect(
        refused.error.issues.some(
          (issue) => (issue as { params?: { safeCode?: string } }).params?.safeCode === 'block_missing',
        ),
      ).toBe(true);
  });
});

describe('the stage plan of a recipe: orbit months, figures and the reveal (D-382, D-383, D-384)', () => {
  /** CI fixture sentences about the invented planet Orrin: the figures a stage may show, never product content. */
  const NEAR_FAR =
    'Orrin at its closest to Vael is 41 million kilometres from the star, and at its farthest it is 43 million kilometres away.';
  const DAYLIGHT = 'In June the harbour town of Pell has 14 hours of daylight, and in December it has only 10 hours.';
  const figurePage = extractResearch(
    `<html><title>CI fixture</title><main>${[...FIXTURE_SOURCE_V2, NEAR_FAR, DAYLIGHT].map((text) => `<p>${text}</p>`).join('')}</main></html>`,
    'https://spaceplace.nasa.gov/seasons/en/',
    '2026-10-20T00:00:00.000Z',
  );
  const figurePassages = evidencePassages([figurePage]);
  const handleOf = (sentence: string): string =>
    figurePassages.find((passage) => passage.text === sentence)?.handle ?? '';
  const figureContext = (): WriterV2Context => ({ ...context(), passages: figurePassages, pages: [figurePage] });
  type Draft = { items: Record<string, unknown>[] };
  const compileWith = (edit: (draft: Draft) => void) => compileGeneratedScrollV2(changed(edit), figureContext());
  const NEAREST = { slot: 'nearest', value: '41', magnitude: 'million', unit: 'kilometres' };
  const FARTHEST = { slot: 'farthest', value: '43', magnitude: 'million', unit: 'kilometres' };
  /** The stop right after the first call: the recorded answer turns the picture to the orbit there. */
  const withFigures =
    (...figures: object[]) =>
    (draft: Draft) => {
      draft.items[2] = { ...draft.items[2], cites: ['e4', handleOf(NEAR_FAR)], figures };
    };
  const withoutReveal = (draft: Draft) => {
    const { revealsNext: _removed, ...call } = draft.items[1] as Record<string, unknown>;
    draft.items[1] = call;
  };
  const codesOf = (outcome: ReturnType<typeof compileGeneratedScrollV2>) =>
    outcome.kind === 'refused' ? outcome.issues.map((issue) => issue.code) : [];

  it('asks the Seasons recipe for the months, the figures and the reveal, and says nothing of them to a recipe with no plan', () => {
    const text = writerInstructionsV2(spikeRecipeV2('seasons'));
    expect(text).toContain('THE PICTURE GOES ROUND THE ORBIT');
    expect(text).toContain('2 different months at least');
    expect(text).toContain('FIGURES ON THE PICTURE (nearest, farthest, june-daylight, december-daylight)');
    expect(text).toContain('Never convert one unit to another');
    expect(text).toContain('code leaves out any figure that no cited passage of the stop states');
    expect(text).toContain('THE FIRST CALL TURNS THE PICTURE');
    expect(text).toContain('"revealsNext":true');
    expect(text).toContain('"figures":[{"slot":"nearest"');
    for (const key of ['seasons-hemispheres', 'seasons-limits', 'dns-lookup'] as const) {
      const other = writerInstructionsV2(spikeRecipeV2(key));
      expect(other, key).not.toMatch(/ROUND THE ORBIT|FIGURES ON THE PICTURE|TURNS THE PICTURE|revealsNext|"figures"/u);
    }
  });

  it('follows the plan: removing a clause removes its words, and a recipe with no picture gets none', () => {
    const recipe = spikeRecipeV2('seasons');
    const { stagePlan: _removed, ...unplanned } = recipe;
    expect(writerInstructionsV2(unplanned)).not.toMatch(/ROUND THE ORBIT|FIGURES ON THE PICTURE|TURNS THE PICTURE/u);
    const monthsOnly = writerInstructionsV2({ ...recipe, stagePlan: { orbitMonths: 3 } });
    expect(monthsOnly).toContain('3 different months at least');
    expect(monthsOnly).not.toMatch(/FIGURES ON THE PICTURE|TURNS THE PICTURE|revealsNext/u);
    const plain = writerInstructionsV2({ ...spikeRecipeV2('dns-lookup'), stagePlan: { orbitMonths: 2, reveal: true } });
    expect(plain).not.toMatch(/ROUND THE ORBIT|TURNS THE PICTURE/u);
  });

  it('compiles the recorded answer, which stands on the orbit in two months and turns the picture after the first call', () => {
    const outcome = compileGeneratedScrollV2(fixtureAuthoredV2(), context());
    expect(outcome.kind).toBe('compiled');
    if (outcome.kind !== 'compiled') return;
    expect(outcome.document.stops[1]).toMatchObject({ kind: 'call_it', revealStage: 's3' });
  });

  it('puts a figure on the picture that a cited passage states, and says it in the picture’s words', () => {
    const outcome = compileWith(withFigures(NEAREST, FARTHEST));
    expect(outcome.kind).toBe('compiled');
    if (outcome.kind !== 'compiled') return;
    const entry = outcome.document.stage?.states.find((held) => held.stop === 's3');
    expect(entry?.state).toMatchObject({
      view: 'orbit',
      figures: [
        { slot: 'nearest', value: 41_000_000, unit: 'kilometres' },
        { slot: 'farthest', value: 43_000_000, unit: 'kilometres' },
      ],
    });
    expect(entry?.alt).toContain('At its nearest, Earth is 41,000,000 kilometres from the Sun.');
    expect(outcome.leftOut).toEqual([]);
  });

  it('leaves out a figure no cited passage states, with no repair and no invented number', () => {
    const outcome = compileWith(withFigures({ ...NEAREST, value: '39' }, FARTHEST));
    expect(outcome.kind).toBe('compiled');
    if (outcome.kind !== 'compiled') return;
    const entry = outcome.document.stage?.states.find((held) => held.stop === 's3');
    expect(entry?.state).toMatchObject({ figures: [{ slot: 'farthest', value: 43_000_000 }] });
    expect(entry?.alt).not.toContain('39');
    expect(outcome.leftOut).toEqual([{ path: 'items.2', slot: 'nearest' }]);
  });

  it('refuses, with fixed findings the one repair can use, a picture on the orbit at one month and a first call that turns nothing', () => {
    const oneMonth = compileWith((draft) => {
      draft.items[3] = { ...draft.items[3], stage: { earthAt: 'jan', focus: 'axis' } };
    });
    expect(codesOf(oneMonth)).toContain('stage_months_too_few');
    expect(codesOf(compileWith(withoutReveal))).toContain('call_reveal_missing');
    const role = writerRoleV2(figureContext());
    for (const code of ['stage_months_too_few', 'call_reveal_missing', 'call_reveal_invalid'])
      expect(role.safeCustomIssues?.[code], code).toMatch(/\S/u);
  });

  it('reaches the model: the role carries the plan and refuses a recorded answer that ignores it', () => {
    const role = writerRoleV2(context());
    expect(role.instructions).toContain('THE FIRST CALL TURNS THE PICTURE');
    expect(role.outputSchema.safeParse(fixtureAuthoredV2()).success).toBe(true);
    const refused = role.outputSchema.safeParse(changed(withoutReveal));
    expect(refused.success).toBe(false);
    if (!refused.success)
      expect(
        refused.error.issues.some(
          (issue) => (issue as { params?: { safeCode?: string } }).params?.safeCode === 'call_reveal_missing',
        ),
      ).toBe(true);
  });
});
