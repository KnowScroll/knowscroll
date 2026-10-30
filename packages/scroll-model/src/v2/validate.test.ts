import { describe, expect, it } from 'vitest';
import { INTEGRITY_METHOD } from '../document.js';
import { assembleScrollV2 } from '../producer/v2/assemble.js';
import { authoredV2, filler, PUBLICATION_V2, recipeV2 } from '../test-support/v2-fixtures.js';
import { callsOf, type CallItStop, type FinalCallStop, type ReadStop, type ScrollDocumentV2 } from './document.js';
import { describeStageState } from './kit.js';
import { computeMeasuresV2 } from './measures.js';
import { computeIntegrityV2, validateDocumentV2 } from './validate.js';

function fixture(variant: 'stage' | 'plain' = 'stage'): ScrollDocumentV2 {
  const result = assembleScrollV2(authoredV2(variant), PUBLICATION_V2, recipeV2(variant));
  if (result.kind !== 'assembled') throw new Error('expected an assembled Scroll');
  return JSON.parse(JSON.stringify(result.document)) as ScrollDocumentV2;
}

/** Recomputes the measures and the hash, so a test changes one rule at a time. */
function signed(document: ScrollDocumentV2): ScrollDocumentV2 {
  const measures = computeMeasuresV2(document);
  const unsigned = { ...document, measures };
  return { ...unsigned, integrity: { method: INTEGRITY_METHOD, sha256: computeIntegrityV2(unsigned) } };
}

const issues = (document: unknown): string[] => {
  const outcome = validateDocumentV2(document);
  return outcome.kind === 'invalid' ? outcome.issues.map((issue) => `${issue.code}@${issue.path}`) : [];
};

const broken = (edit: (document: ScrollDocumentV2) => void, variant: 'stage' | 'plain' = 'stage'): string[] => {
  const document = fixture(variant);
  edit(document);
  return issues(signed(document));
};

// Typed access to the fixture's parts; a test fails loudly if the fixture changes shape.
function read(document: ScrollDocumentV2, index: number): ReadStop {
  const stop = document.stops[index];
  if (stop?.kind !== 'read') throw new Error(`stop ${index} is not a read stop`);
  return stop;
}
function call(document: ScrollDocumentV2, index: number): CallItStop | FinalCallStop {
  const stop = document.stops[index];
  if (stop === undefined || stop.kind === 'read') throw new Error(`stop ${index} is not a call`);
  return stop;
}
function callIt(document: ScrollDocumentV2, index: number): CallItStop {
  const stop = call(document, index);
  if (stop.kind !== 'call_it') throw new Error(`stop ${index} is not a Call it`);
  return stop;
}
function stageOf(document: ScrollDocumentV2): NonNullable<ScrollDocumentV2['stage']> {
  if (document.stage === undefined) throw new Error('the fixture has no stage');
  return document.stage;
}
function stateAt(document: ScrollDocumentV2, index: number) {
  const state = stageOf(document).states[index];
  if (state === undefined) throw new Error(`no stage state ${index}`);
  return state;
}
function asideAt(document: ScrollDocumentV2, index: number) {
  const aside = document.asides[index];
  if (aside === undefined) throw new Error(`no aside ${index}`);
  return aside;
}

describe('validateDocumentV2: a stored Scroll', () => {
  it.each(['stage', 'plain'] as const)('accepts the assembled %s fixture', (variant) => {
    expect(validateDocumentV2(fixture(variant)).kind).toBe('valid');
  });

  it('refuses a document that is not JSON, one that is too large and one with a field it does not know', () => {
    expect(issues({ fn: () => 1 })).toEqual(['document_not_object@$']);
    expect(issues({ junk: 'x'.repeat(140_000) })).toEqual(['document_too_large@$']);
    expect(issues({ ...fixture(), surprise: true })).toContain('schema_unrecognized_keys@$');
    expect(issues({ ...fixture(), schemaVersion: 'scroll-document.v1' })).toContain(
      'schema_invalid_value@schemaVersion',
    );
  });

  it('recomputes the measures and the hash instead of trusting them', () => {
    const edited = fixture();
    read(edited, 2).blocks = [{ type: 'paragraph', text: filler(40, 5) }];
    expect(issues(edited)).toEqual(
      expect.arrayContaining(['measures_mismatch@measures', 'integrity_mismatch@integrity']),
    );
    expect(issues({ ...fixture(), title: 'Another title entirely' })).toEqual(['integrity_mismatch@integrity']);
    expect(issues(signed(edited))).toEqual([]);
  });
});

describe('validateDocumentV2: the rules of scroll-limits.v2', () => {
  it('keeps the spine between six and fourteen stops', () => {
    expect(
      broken((document) => {
        document.stops = document.stops.slice(4);
        document.asides = [];
        document.recap = { captions: document.recap.captions };
      }, 'plain'),
    ).toContain('stops_too_few@stops');
    expect(
      broken((document) => {
        const template = read(document, 0);
        document.stops.push(...Array.from({ length: 6 }, (_, index) => ({ ...template, id: `x${index + 1}` })));
      }, 'plain'),
    ).toContain('schema_too_big@stops');
  });

  it('needs three read stops, because a facet binds to them and a Scroll of calls could never form a place', () => {
    const withReads = (reads: number) =>
      broken((document) => {
        const reading = document.stops.filter((stop): stop is ReadStop => stop.kind === 'read').slice(0, reads);
        const calls = document.stops.filter((stop) => stop.kind !== 'read');
        // Six stops in all, so only the number of read stops varies; the calls are the fixture's, plus copies.
        const extra = Array.from({ length: 6 - reads - calls.length }, (_, index) => ({
          ...callIt(document, 1),
          id: `c${index + 1}`,
          commonGuess: undefined,
        }));
        document.stops = [...reading, ...extra, ...calls];
        document.asides = [];
        document.recap = { captions: document.recap.captions };
      }, 'plain');
    expect(withReads(2)).toContain('read_stops_too_few@stops');
    expect(withReads(3)).not.toContain('read_stops_too_few@stops');
  });

  it('holds stops to 60 words, lines to 12 and a heading to the top of the stop', () => {
    const result = broken((document) => {
      read(document, 0).blocks = [
        { type: 'paragraph', text: filler(30, 1) },
        { type: 'heading', level: 2, text: 'Late heading' },
        { type: 'line', text: filler(13, 2) },
      ];
      read(document, 2).blocks = [{ type: 'paragraph', text: filler(61, 3) }];
      call(document, 1).explain = filler(61, 4);
      asideAt(document, 0).text = filler(61, 5);
    });
    expect(result).toEqual(
      expect.arrayContaining([
        'heading_misplaced@stops.0.blocks.1',
        'line_too_long@stops.0.blocks.2',
        'stop_too_long@stops.2',
        'stop_too_long@stops.1.explain',
        'stop_too_long@asides.0.text',
      ]),
    );
  });

  it('allows at most four calls, the Final call last, and distinct options', () => {
    expect(
      broken((document) => {
        document.stops[2] = { ...callIt(document, 1), id: 's3x' };
        document.stops[3] = { ...callIt(document, 1), id: 's4x' };
      }),
    ).toContain('call_budget_exceeded@stops');
    expect(broken((document) => document.stops.pop())).toContain('final_call_missing@stops');
    expect(
      broken((document) => {
        const final = document.stops.splice(-1, 1);
        document.stops.unshift(...final);
      }),
    ).toContain('final_call_misplaced@stops');
    expect(
      broken((document) => {
        const stop = callIt(document, 1);
        stop.options = ['Same', 'same'];
        stop.answer = 0;
        delete stop.commonGuess;
      }),
    ).toContain('call_options_duplicate@stops.1.options');
    expect(callsOf(fixture())).toHaveLength(3);
  });

  it('refuses a Final call that asks again what an earlier call asked, or whose answer repeats an earlier answer', () => {
    const final = (document: ScrollDocumentV2) => call(document, document.stops.length - 1);
    expect(broken((document) => (final(document).prompt = callIt(document, 1).prompt))).toContain(
      'final_call_restates_call@stops.8',
    );
    expect(
      broken((document) => {
        const earlier = callIt(document, 4);
        final(document).options[final(document).answer] = `${earlier.options[earlier.answer] ?? ''} again`;
      }),
    ).toContain('final_call_restates_call@stops.8');
    // A different question and a different answer pass, and an earlier Call it may repeat another Call it.
    expect(
      broken((document) => {
        final(document).prompt = 'Imagine a world that never leans. What would its year be like?';
        final(document).options[final(document).answer] = 'The days would stay about as long all year';
      }),
    ).toEqual([]);
    expect(broken((document) => (callIt(document, 4).prompt = callIt(document, 1).prompt))).toEqual([]);
  });

  it('answers inside the options: an index beyond the last option is refused', () => {
    const result = broken((document) => {
      const stop = callIt(document, 4);
      stop.options = ['One option here', 'Another option here'];
      stop.answer = 2;
    });
    expect(result).toContain('call_answer_invalid@stops.4.answer');
  });

  it('takes the common guess from the recipe: its source, a wrong option, and only on the myth’s first call', () => {
    const guessOf = (document: ScrollDocumentV2) => {
      const guess = callIt(document, 1).commonGuess;
      if (guess === undefined) throw new Error('the fixture’s first call has no common guess');
      return guess;
    };
    expect(broken((document) => (guessOf(document).source.label = 'Another label'))).toContain(
      'common_guess_invalid@stops.1.commonGuess',
    );
    expect(broken((document) => (guessOf(document).option = callIt(document, 1).answer))).toContain(
      'common_guess_invalid@stops.1.commonGuess',
    );
    expect(broken((document) => delete callIt(document, 1).commonGuess)).toContain('common_guess_missing@stops.1');
    expect(broken((document) => (callIt(document, 4).commonGuess = { ...guessOf(document) }))).toContain(
      'common_guess_unexpected@stops.4.commonGuess',
    );
    expect(broken((document) => (document.misconception = { kind: 'none' }))).toContain(
      'common_guess_unexpected@stops.1.commonGuess',
    );
  });

  it('needs a limits aside that opens before the Final call and that the recap links to', () => {
    expect(broken((document) => (document.asides = []))).toContain('limits_aside_missing@asides');
    expect(broken((document) => (asideAt(document, 0).anchorStop = 's9'))).toContain(
      'limits_aside_last@asides.0.anchorStop',
    );
    expect(broken((document) => (asideAt(document, 0).anchorStop = 's99'))).toContain(
      'aside_anchor_unknown@asides.0.anchorStop',
    );
    expect(broken((document) => (document.recap.smallPrintAside = 'a9'))).toContain(
      'recap_small_print_unknown@recap.smallPrintAside',
    );
    expect(broken((document) => (asideAt(document, 0).anchorStop = 's8'))).toEqual([]);
  });

  it('keeps ids unique across stops and asides', () => {
    expect(broken((document) => (asideAt(document, 0).id = 's2'))).toContain('id_duplicate@asides.0.id');
  });

  it('checks the stage: first stop, order, known stops, self-described states and enough change', () => {
    expect(broken((document) => (stateAt(document, 0).stop = 's2'))).toContain(
      'stage_first_state_missing@stage.states',
    );
    expect(broken((document) => (stateAt(document, 1).stop = 's99'))).toContain(
      'stage_state_stop_unknown@stage.states.1.stop',
    );
    expect(broken((document) => (stateAt(document, 2).stop = stateAt(document, 1).stop))).toContain(
      'stage_states_unordered@stage.states.2.stop',
    );
    expect(broken((document) => (stateAt(document, 1).alt = 'A picture that does not match.'))).toContain(
      'stage_alt_mismatch@stage.states.1.alt',
    );
    expect(
      broken((document) => {
        stateAt(document, 1).state = { ...stateAt(document, 0).state };
        stateAt(document, 1).alt = stateAt(document, 0).alt;
      }),
    ).toContain('stage_state_repeated@stage.states.1');
    expect(broken((document) => (stageOf(document).states = stageOf(document).states.slice(0, 2)))).toContain(
      'stage_too_static@stage.states',
    );
  });

  it('keeps the picture off the calls, so it cannot show an answer before the reader gives one', () => {
    // s2 is the first Call it; the states sit on read stops only.
    expect(stageOf(fixture()).states.map((entry) => entry.stop)).not.toContain('s2');
    expect(broken((document) => (stateAt(document, 1).stop = 's2'))).toContain(
      'stage_state_on_call@stage.states.1.stop',
    );
    expect(broken((document) => (stateAt(document, 5).stop = 's9'))).toContain(
      'stage_state_on_call@stage.states.5.stop',
    );
  });

  it('refuses a stored state that holds what its view does not draw, so a picture cannot contradict itself', () => {
    const unsettled = { view: 'earth-close', earthAt: 'jun', moonAt: 'full', focus: 'moon' } as const;
    expect(
      broken((document) => {
        stateAt(document, 1).state = unsettled;
        stateAt(document, 1).alt = describeStageState(unsettled);
      }),
    ).toEqual(['stage_state_unsettled@stage.states.1.state']);
  });

  it('refuses a stored state with a field the kit no longer has: Earth’s tilt, the pins and Ray are not stored', () => {
    for (const extra of [{ axis: 'sideways' }, { northPin: 'warm' }, { ray: 'low' }])
      expect(
        broken((document) => {
          Object.assign(stateAt(document, 1).state, extra);
        }),
      ).toContain('schema_unrecognized_keys@stage.states.1.state');
  });

  it('holds the reading time to three to six minutes at 230 words a minute plus ten seconds a call', () => {
    expect(
      broken((document) => {
        for (const stop of document.stops)
          if (stop.kind === 'read') stop.blocks = [{ type: 'paragraph', text: filler(10, 7) }];
      }),
    ).toContain('reading_length_out_of_brief@measures.readingSeconds');
  });

  it('takes a Final call that hands the reader the tilt only on a stage that draws the axis, and a landmark with it', () => {
    const bound = (document: ScrollDocumentV2) => {
      const final = call(document, document.stops.length - 1);
      if (final.kind !== 'final_call') throw new Error('the last stop is the Final call');
      final.binding = { kind: 'tilt' };
      document.landmark = { key: 'ci-fixture-axis', name: 'The CI Fixture Axis' };
    };
    expect(broken(bound)).toEqual([]);
    // No stage at all: there is no axis to turn.
    expect(broken(bound, 'plain')).toEqual([
      'final_call_binding_invalid@stops.' + String(fixture('plain').stops.length - 1) + '.binding',
    ]);
    // A stage that ends on the Moon view draws no axis.
    const last = fixture().stops.length - 1;
    expect(
      broken((document) => {
        bound(document);
        const states = stageOf(document).states;
        const state = states.at(-1);
        if (state === undefined) throw new Error('the fixture has a stage');
        state.state = { view: 'moon-orbit', earthAt: 'mar', moonAt: 'full', focus: 'none' };
        state.alt = describeStageState(state.state);
      }),
    ).toEqual(['final_call_binding_invalid@stops.' + String(last) + '.binding']);
  });

  it('refuses a binding or a landmark that is not one the schema knows', () => {
    expect(
      broken((document) => {
        const final = call(document, document.stops.length - 1);
        if (final.kind === 'final_call') (final as { binding?: unknown }).binding = { kind: 'slider' };
      }),
    ).not.toEqual([]);
    expect(
      broken((document) => {
        (document as { landmark?: unknown }).landmark = { key: 'Bad Key', name: 'A landmark' };
      }),
    ).not.toEqual([]);
    expect(
      broken((document) => {
        (document as { landmark?: unknown }).landmark = { key: 'a-landmark', name: 'A landmark', points: 3 };
      }),
    ).not.toEqual([]);
  });

  it('notes an unreviewed source without refusing the Scroll', () => {
    const document = fixture();
    if (document.misconception.kind !== 'myth') throw new Error('the fixture names a myth');
    document.misconception.source.reviewed = false;
    const guess = callIt(document, 1).commonGuess;
    if (guess !== undefined) guess.source.reviewed = false;
    const outcome = validateDocumentV2(signed(document));
    expect(outcome.kind === 'valid' && outcome.notices).toEqual([
      { code: 'misconception_source_unreviewed', path: 'misconception.source' },
    ]);
  });
});
