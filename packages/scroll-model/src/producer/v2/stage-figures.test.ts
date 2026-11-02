import { describe, expect, it } from 'vitest';
import { authoredV2, compileInputV2, EVIDENCE_V2, PASSAGES_V2, recipeV2 } from '../../test-support/v2-fixtures.js';
import { validateDocumentV2 } from '../../v2/validate.js';
import type { ScrollDocumentV2 } from '../../v2/document.js';
import type { StagePlanV2 } from './assemble.js';
import { AuthoredScrollV2 } from './authoring-schema.js';
import { compileAuthoredV2, type CompileV2Input, type CompileV2Outcome } from './compile.js';
import { stageFigureIsStated } from './stage-figures.js';

/**
 * CI FIXTURES, never product content: the passages are authored sentences about an invented planet, Orrin, and its
 * invented star, Vael. They state the figures a stage may show, and the ways a writer could misuse them.
 */
const NEAR_FAR =
  'Orrin at its closest to Vael is 41 million kilometres from the star, and at its farthest it is 43 million kilometres away.';
const DAYLIGHT = 'In June the harbour town of Pell has 14 hours of daylight, and in December it has only 10 hours.';
const SWAPPED = 'Vael lies 43 million kilometres from Orrin at perihelion and 41 million kilometres at aphelion.';
const RANGE = 'Orrin is between 41 to 43 million kilometres from Vael, and Pell is a harbour town on its coast.';
const FIGURE_PASSAGES = [...PASSAGES_V2, NEAR_FAR, DAYLIGHT, SWAPPED, RANGE];
const NEAR_FAR_HANDLE = 'e7';
const DAYLIGHT_HANDLE = 'e8';
const SWAPPED_HANDLE = 'e9';

const evidence = (): CompileV2Input['evidence'] => ({
  claimIdOf: new Map([
    ...EVIDENCE_V2.claimIdOf,
    ...FIGURE_PASSAGES.slice(6).map((_, index): [string, string] => [
      `e${String(index + 7)}`,
      `claim-v2-${String(index + 7)}`,
    ]),
  ]),
  quoteOf: new Map([
    ...EVIDENCE_V2.quoteOf,
    ...FIGURE_PASSAGES.slice(6).map((text, index): [string, string] => [`claim-v2-${String(index + 7)}`, text]),
  ]),
  minDistinctCitations: 4,
});

type Mutable = { items: Record<string, unknown>[]; [key: string]: unknown };

const NEAREST = { slot: 'nearest', value: '41', magnitude: 'million', unit: 'kilometres' };
const FARTHEST = { slot: 'farthest', value: '43', magnitude: 'million', unit: 'kilometres' };

/**
 * The stage fixture drawn on the orbit from stop three on: the stop right after the first call turns the picture to the
 * closest view in January, the next to June, the next to March. `edit` changes the authored list before it is parsed.
 */
function authoredOrbit(edit: (draft: Mutable) => void = () => undefined): AuthoredScrollV2 {
  const draft = JSON.parse(JSON.stringify(authoredV2('stage'))) as Mutable;
  draft.items[2] = { ...draft.items[2], stage: { view: 'orbit-stretched', earthAt: 'jan', focus: 'none' } };
  draft.items[3] = { ...draft.items[3], stage: { earthAt: 'jun' } };
  draft.items[5] = { ...draft.items[5], stage: { view: 'sun-earth', earthAt: 'jun' } };
  edit(draft);
  return AuthoredScrollV2.parse(draft);
}

const withStop = (draft: Mutable, at: number, extra: Record<string, unknown>) => {
  draft.items[at] = { ...draft.items[at], ...extra };
};

function compile(authored: AuthoredScrollV2, plan?: StagePlanV2, variant: 'stage' | 'plain' = 'stage') {
  const input: CompileV2Input = {
    ...compileInputV2(variant),
    recipe: { ...recipeV2(variant), ...(plan === undefined ? {} : { stagePlan: plan }) },
    evidence: evidence(),
    sources: FIGURE_PASSAGES,
  };
  return compileAuthoredV2(authored, input);
}

function compiled(outcome: CompileV2Outcome) {
  if (outcome.kind !== 'compiled') throw new Error(`expected a compiled Scroll: ${JSON.stringify(outcome)}`);
  return outcome;
}

const codes = (outcome: CompileV2Outcome) =>
  outcome.kind === 'refused' ? outcome.issues.map((issue) => `${issue.code}@${issue.path}`) : [];

const entryAt = (document: ScrollDocumentV2, stopId: string) =>
  document.stage?.states.find((entry) => entry.stop === stopId);

describe('a stage figure is shown only when a cited passage states it (D-382)', () => {
  it('puts the figures of a stop on its picture, in the passage’s own unit, and says them in the picture’s words', () => {
    const outcome = compiled(
      compile(
        authoredOrbit((draft) => withStop(draft, 2, { cites: ['e4', NEAR_FAR_HANDLE], figures: [NEAREST, FARTHEST] })),
      ),
    );
    const entry = entryAt(outcome.document, 's3');
    expect(entry?.state).toMatchObject({
      view: 'orbit-stretched',
      figures: [
        { slot: 'nearest', value: 41_000_000, unit: 'kilometres' },
        { slot: 'farthest', value: 43_000_000, unit: 'kilometres' },
      ],
    });
    expect(entry?.alt).toContain('At its nearest, Earth is 41,000,000 kilometres from the Sun.');
    expect(entry?.alt).toContain('At its farthest, Earth is 43,000,000 kilometres from the Sun.');
    expect(entry?.alt).toContain('You are here');
    expect(outcome.leftOut).toEqual([]);
    expect(validateDocumentV2(JSON.parse(JSON.stringify(outcome.document))).kind).toBe('valid');
  });

  it('draws daylight as bands on the Sun and Earth view, with the place the passage names', () => {
    const outcome = compiled(
      compile(
        authoredOrbit((draft) =>
          withStop(draft, 5, {
            cites: ['e2', DAYLIGHT_HANDLE],
            figures: [
              { slot: 'june-daylight', value: '14', unit: 'hours', place: 'Pell' },
              { slot: 'december-daylight', value: '10', unit: 'hours', place: 'Pell' },
            ],
          }),
        ),
      ),
    );
    const entry = entryAt(outcome.document, 's6');
    expect(entry?.state).toMatchObject({
      view: 'sun-earth',
      figures: [
        { slot: 'june-daylight', value: 14, unit: 'hours', place: 'Pell' },
        { slot: 'december-daylight', value: 10, unit: 'hours', place: 'Pell' },
      ],
    });
    expect(entry?.alt).toContain('In Pell, daylight lasts 14 hours in June.');
    expect(entry?.alt).toContain('In Pell, daylight lasts 10 hours in December.');
  });

  it('leaves out a figure that no passage states, and reports it, without refusing the Scroll or inventing one', () => {
    const outcome = compiled(
      compile(
        authoredOrbit((draft) =>
          withStop(draft, 2, {
            cites: ['e4', NEAR_FAR_HANDLE],
            figures: [{ ...NEAREST, value: '39' }, FARTHEST],
          }),
        ),
      ),
    );
    expect(entryAt(outcome.document, 's3')?.state).toMatchObject({
      figures: [{ slot: 'farthest', value: 43_000_000, unit: 'kilometres' }],
    });
    expect(outcome.leftOut).toEqual([{ path: 'items.2', slot: 'nearest' }]);
  });

  it('leaves the picture with no figure at all when none is stated, so the state is a plain orbit view', () => {
    const outcome = compiled(
      compile(authoredOrbit((draft) => withStop(draft, 2, { figures: [NEAREST, { ...FARTHEST, value: '44' }] }))),
    );
    expect(entryAt(outcome.document, 's3')?.state).not.toHaveProperty('figures');
    expect(entryAt(outcome.document, 's3')?.alt).not.toContain('You are here');
    expect(outcome.leftOut.map((figure) => figure.slot)).toEqual(['nearest', 'farthest']);
  });

  it('needs the passage to be one the stop cites: a figure a different stop’s passage states is left out', () => {
    const outcome = compiled(
      compile(authoredOrbit((draft) => withStop(draft, 2, { cites: ['e4'], figures: [NEAREST] }))),
    );
    expect(outcome.leftOut).toEqual([{ path: 'items.2', slot: 'nearest' }]);
  });

  it('keeps each figure with its own end of the orbit: the figures of a passage that gives them the other way round are left out', () => {
    const outcome = compiled(
      compile(
        authoredOrbit((draft) => withStop(draft, 2, { cites: ['e4', SWAPPED_HANDLE], figures: [NEAREST, FARTHEST] })),
      ),
    );
    expect(outcome.leftOut.map((figure) => figure.slot)).toEqual(['nearest', 'farthest']);
    expect(entryAt(outcome.document, 's3')?.state).not.toHaveProperty('figures');
  });

  it('leaves out a figure written some other way than the passage writes it, a unit or a place the passages never use', () => {
    const quotes = [NEAR_FAR, DAYLIGHT, RANGE];
    expect(stageFigureIsStated(NEAREST as never, quotes)).toBe(true);
    // No word after the figure, where the passage writes "41 million".
    expect(stageFigureIsStated({ ...NEAREST, magnitude: undefined } as never, quotes)).toBe(false);
    // A word the passage does not put there, a figure one end of a range, a unit the passages never name.
    expect(stageFigureIsStated({ ...NEAREST, magnitude: 'billion' } as never, quotes)).toBe(false);
    expect(stageFigureIsStated({ ...NEAREST, unit: 'parsecs' } as never, quotes)).toBe(false);
    expect(stageFigureIsStated({ ...NEAREST, value: '4.1e7' } as never, quotes)).toBe(false);
    expect(stageFigureIsStated(NEAREST as never, [RANGE])).toBe(false);
    const june = { slot: 'june-daylight', value: '14', unit: 'hours', place: 'Pell' };
    expect(stageFigureIsStated(june as never, quotes)).toBe(true);
    expect(stageFigureIsStated({ ...june, place: 'Delhi' } as never, quotes)).toBe(false);
    expect(stageFigureIsStated({ ...june, place: undefined } as never, quotes)).toBe(false);
    // The figure beside the word December is not June's.
    expect(stageFigureIsStated({ ...june, value: '10' } as never, quotes)).toBe(false);
    expect(stageFigureIsStated({ ...june, slot: 'december-daylight', value: '10' } as never, quotes)).toBe(true);
  });

  it('sets aside a figure the picture has no place for: a distance on the Sun and Earth view stays out of the state', () => {
    const outcome = compiled(
      compile(authoredOrbit((draft) => withStop(draft, 5, { cites: ['e2', NEAR_FAR_HANDLE], figures: [NEAREST] }))),
    );
    expect(entryAt(outcome.document, 's6')?.state).not.toHaveProperty('figures');
  });

  it('keeps the figures until a stop changes the picture, and clears them there', () => {
    const outcome = compiled(
      compile(authoredOrbit((draft) => withStop(draft, 2, { cites: ['e4', NEAR_FAR_HANDLE], figures: [NEAREST] }))),
    );
    const states = outcome.document.stage?.states ?? [];
    // s3 sets the orbit with the figure; s4 changes the month (no figure of its own), so the figure is gone there.
    expect(states.slice(0, 4).map((entry) => [entry.stop, 'figures' in entry.state])).toEqual([
      ['s1', false],
      ['s3', true],
      ['s4', false],
      ['s6', false],
    ]);
  });

  it('refuses a figure on a Scroll with no picture, like a stage state', () => {
    const plain = AuthoredScrollV2.parse(
      JSON.parse(
        JSON.stringify({
          ...authoredV2('plain'),
          items: authoredV2('plain').items.map((item, index) =>
            index === 2 ? { ...item, figures: [NEAREST], cites: ['e4', NEAR_FAR_HANDLE] } : item,
          ),
        }),
      ),
    );
    expect(codes(compile(plain, undefined, 'plain'))).toContain('stage_unexpected@items.2.figures');
  });
});

describe('what a recipe’s stage plan asks of the picture (D-382)', () => {
  const plan: StagePlanV2 = { orbitMonths: 2 };

  it('accepts a picture that stands on the orbit at two different months, so the recap of the journey can draw', () => {
    const outcome = compiled(compile(authoredOrbit(), plan));
    expect(outcome.document.stage?.states.filter((entry) => entry.state.view.startsWith('orbit'))).toHaveLength(2);
  });

  it('refuses a picture that stands on the orbit at one month, and one that never goes there', () => {
    const oneMonth = authoredOrbit((draft) => withStop(draft, 3, { stage: { earthAt: 'jan', focus: 'orbit' } }));
    expect(codes(compile(oneMonth, plan))).toContain('stage_months_too_few@items');
    // The ordinary fixture is drawn on the Sun and Earth view throughout.
    expect(codes(compile(AuthoredScrollV2.parse(authoredV2('stage')), plan))).toContain('stage_months_too_few@items');
    // Without the plan neither is a problem.
    expect(compile(oneMonth).kind).toBe('compiled');
  });

  it('counts months, not stops: the same month twice is one place', () => {
    const sameMonth = authoredOrbit((draft) => {
      withStop(draft, 3, { stage: { earthAt: 'jan', focus: 'orbit' } });
      withStop(draft, 5, { stage: { view: 'orbit', earthAt: 'jan', focus: 'none' } });
      withStop(draft, 6, { stage: { earthAt: 'jan', focus: 'sun' } });
      withStop(draft, 7, { stage: { earthAt: 'jan', focus: 'earth' } });
    });
    expect(codes(compile(sameMonth, plan))).toContain('stage_months_too_few@items');
    expect(compile(sameMonth, { orbitMonths: 1 }).kind).toBe('compiled');
  });
});

describe('the first call shows the true picture to a reader who guessed wrong (D-383)', () => {
  const plan: StagePlanV2 = { reveal: true };
  const revealing = (draft: Mutable) => withStop(draft, 1, { revealsNext: true });

  it('points the call at the stop after it, whose picture is the true one', () => {
    const outcome = compiled(compile(authoredOrbit(revealing), plan));
    const call = outcome.document.stops[1];
    expect(call).toMatchObject({ kind: 'call_it', revealStage: 's3' });
    expect(entryAt(outcome.document, 's3')?.state.view).toBe('orbit-stretched');
  });

  it('is refused when the stop after the call does not change the picture, so there is nothing to turn to', () => {
    const still = authoredOrbit((draft) => {
      revealing(draft);
      draft.items[2] = { ...draft.items[2], stage: undefined };
      delete draft.items[2]['stage'];
    });
    expect(codes(compile(still, plan))).toContain('call_reveal_invalid@items.1.revealStage');
  });

  it('is refused when the recipe asks for it and the writer gives none', () => {
    expect(codes(compile(authoredOrbit(), plan))).toContain('call_reveal_missing@items.1');
    // A recipe that does not ask is not refused, and a call that asks without a plan is allowed.
    expect(compile(authoredOrbit()).kind).toBe('compiled');
    expect(compile(authoredOrbit(revealing)).kind).toBe('compiled');
  });

  it('is refused on a Scroll with no picture', () => {
    const plain = AuthoredScrollV2.parse({
      ...authoredV2('plain'),
      items: authoredV2('plain').items.map((item, index) => (index === 1 ? { ...item, revealsNext: true } : item)),
    });
    expect(codes(compile(plain, undefined, 'plain'))).toContain('stage_unexpected@items.1.revealsNext');
  });
});

describe('a state with figures, once stored, is admitted only as code made it (D-382)', () => {
  const document = (): ScrollDocumentV2 =>
    JSON.parse(
      JSON.stringify(
        compiled(
          compile(authoredOrbit((draft) => withStop(draft, 2, { cites: ['e4', NEAR_FAR_HANDLE], figures: [NEAREST] }))),
        ).document,
      ),
    ) as ScrollDocumentV2;

  it('refuses a figure on a view that does not draw it, a figure the words do not describe and a repeated slot', () => {
    const draft = document();
    const entry = draft.stage?.states.find((held) => held.stop === 's3');
    if (entry === undefined) throw new Error('fixture has the state');
    const kept = JSON.stringify(draft);
    const refusedWith = (change: (state: { figures?: unknown[]; view: string }) => void): string[] => {
      const copy = JSON.parse(kept) as ScrollDocumentV2;
      const held = copy.stage?.states.find((candidate) => candidate.stop === 's3');
      if (held === undefined) throw new Error('fixture has the state');
      change(held.state);
      const outcome = validateDocumentV2(copy, { verify: false });
      return outcome.kind === 'invalid' ? outcome.issues.map((issue) => issue.code) : [];
    };
    expect(refusedWith((state) => (state.view = 'sun-earth'))).toContain('stage_state_unsettled');
    expect(refusedWith((state) => (state.figures = [...(state.figures ?? []), ...(state.figures ?? [])]))).toContain(
      'stage_state_unsettled',
    );
    expect(refusedWith((state) => ((state.figures ?? [])[0] as { value: number }).value++)).toContain(
      'stage_alt_mismatch',
    );
  });
});
