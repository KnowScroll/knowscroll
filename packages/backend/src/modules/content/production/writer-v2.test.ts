import { describe, expect, it } from 'vitest';
import { kitDefinition, kitKeys } from '@knowscroll/scroll-model';
import { AuthoredScrollV2 } from '@knowscroll/scroll-model/producer';
import { evidencePassages } from './evidence.js';
import { spikeRecipeV2 } from './spike-v2/topics.js';
import { fixtureAuthoredV2, fixtureResearchPageV2 } from './spike-v2/writer-v2.fixture.js';
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

describe('the v18 writer', () => {
  it('has its own version and leaves the v1 writer’s alone', () => {
    expect(WRITER_V2_PROMPT_VERSION).toBe('scroll-writer.v18');
    expect(WRITER_PROMPT_VERSION).toBe('scroll-writer.v13');
    expect(writerRoleV2(context()).version).toBe('scroll-writer.v18');
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
  ['starlight.v1', 'exoplanet-habitable-zone', 'A habitable zone is where liquid water could exist on a surface'],
  [
    'black-hole.v1',
    'black-hole-horizon',
    'The picture draws stellar-mass black holes made by a massive star’s collapse',
  ],
] as const;

describe.each(KIT_RECIPES)('the v18 writer for a recipe drawn with %s', (kit, key, sentence) => {
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
