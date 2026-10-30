import { describe, expect, it } from 'vitest';
import { INTEGRITY_METHOD } from '../document.js';
import { assembleScrollV2 } from '../producer/v2/assemble.js';
import { authoredV2, filler, PUBLICATION_V2, recipeV2 } from '../test-support/v2-fixtures.js';
import { callsOf, type ScrollDocumentV2 } from './document.js';
import { computeMeasuresV2 } from './measures.js';
import { computeIntegrityV2, validateDocumentV2 } from './validate.js';

type Json = Record<string, any>;

function fixture(variant: 'stage' | 'plain' = 'stage'): Json {
  const result = assembleScrollV2(authoredV2(variant), PUBLICATION_V2, recipeV2(variant));
  if (result.kind !== 'assembled') throw new Error('expected an assembled Scroll');
  return JSON.parse(JSON.stringify(result.document)) as Json;
}

/** Recomputes the measures and the hash, so a test changes one rule at a time. */
function signed(document: Json): Json {
  const { integrity: _removed, ...rest } = document;
  const unsigned = { ...rest, measures: computeMeasuresV2(rest as unknown as ScrollDocumentV2) };
  return { ...unsigned, integrity: { method: INTEGRITY_METHOD, sha256: computeIntegrityV2(unsigned as never) } };
}

const issues = (document: unknown): string[] => {
  const outcome = validateDocumentV2(document);
  return outcome.kind === 'invalid' ? outcome.issues.map((issue) => `${issue.code}@${issue.path}`) : [];
};

describe('validateDocumentV2: a stored Scroll', () => {
  it.each(['stage', 'plain'] as const)('accepts the assembled %s fixture', (variant) => {
    const outcome = validateDocumentV2(fixture(variant));
    expect(outcome.kind).toBe('valid');
  });

  it('refuses a document that is not JSON, one that is too large and one with a field it does not know', () => {
    expect(issues({ fn: () => 1 })).toEqual(['document_not_object@$']);
    expect(issues({ junk: 'x'.repeat(140_000) })).toEqual(['document_too_large@$']);
    expect(issues({ ...fixture(), surprise: true })).toContain('schema_unrecognized_keys@$');
    expect(issues({ ...fixture(), schemaVersion: 'scroll-document.v1' })).toContain('schema_invalid_value@schemaVersion');
  });

  it('recomputes the measures and the hash instead of trusting them', () => {
    const edited = fixture();
    edited['stops'][2].blocks[0].text = filler(40, 5);
    expect(issues(edited)).toEqual(expect.arrayContaining(['measures_mismatch@measures', 'integrity_mismatch@integrity']));
    expect(issues({ ...fixture(), title: 'Another title entirely' })).toEqual(['integrity_mismatch@integrity']);
    expect(issues(signed(edited))).toEqual([]);
  });
});

describe('validateDocumentV2: the rules of scroll-limits.v2', () => {
  const broken = (edit: (document: Json) => void, variant: 'stage' | 'plain' = 'stage'): string[] => {
    const document = fixture(variant);
    edit(document);
    return issues(signed(document));
  };

  it('keeps the spine between six and fourteen stops', () => {
    expect(
      broken((document) => {
        document['stops'] = document['stops'].slice(4);
        document['asides'] = [];
        document['stage'] = undefined;
        document['recap'].smallPrintAside = undefined;
      }, 'plain'),
    ).toContain('stops_too_few@stops');
    expect(
      broken((document) => {
        const read = document['stops'][0];
        document['stops'].push(...Array.from({ length: 6 }, (_, index) => ({ ...read, id: `x${index + 1}` })));
      }, 'plain'),
    ).toContain('schema_too_big@stops');
  });

  it('holds stops to 60 words, lines to 12 and a heading to the top of the stop', () => {
    const result = broken((document) => {
      document['stops'][0].blocks = [
        { type: 'paragraph', text: filler(30, 1) },
        { type: 'heading', level: 2, text: 'Late heading' },
        { type: 'line', text: filler(13, 2) },
      ];
      document['stops'][2].blocks = [{ type: 'paragraph', text: filler(61, 3) }];
      document['stops'][1].explain = filler(61, 4);
      document['asides'][0].text = filler(61, 5);
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

  it('allows at most four calls, the Final call last, answers inside the options and distinct options', () => {
    expect(
      broken((document) => {
        document['stops'][2] = { ...document['stops'][1], id: 's3x' };
        document['stops'][3] = { ...document['stops'][1], id: 's4x' };
      }),
    ).toContain('call_budget_exceeded@stops');
    expect(broken((document) => document['stops'].pop())).toEqual(expect.arrayContaining(['final_call_missing@stops']));
    expect(
      broken((document) => {
        const [final] = document['stops'].splice(-1, 1);
        document['stops'].unshift(final);
      }),
    ).toContain('final_call_misplaced@stops');
    expect(broken((document) => (document['stops'][1].answer = 2 + document['stops'][1].options.length))).toEqual(
      expect.arrayContaining(['schema_too_big@stops.1.answer']),
    );
    expect(
      broken((document) => {
        document['stops'][1].options = ['Same', 'same'];
        document['stops'][1].answer = 0;
        delete document['stops'][1].commonGuess;
      }),
    ).toEqual(expect.arrayContaining(['call_options_duplicate@stops.1.options']));
    expect(callsOf(fixture() as unknown as ScrollDocumentV2)).toHaveLength(3);
  });

  it('answers inside the options: an index beyond the last option is refused', () => {
    const result = broken((document) => {
      document['stops'][4].options = ['One option here', 'Another option here'];
      document['stops'][4].answer = 2;
    });
    expect(result).toContain('call_answer_invalid@stops.4.answer');
  });

  it('takes the common guess from the recipe: its source, a wrong option, and only on the myth’s first call', () => {
    expect(broken((document) => (document['stops'][1].commonGuess.source.label = 'Another label'))).toContain('common_guess_invalid@stops.1.commonGuess');
    expect(broken((document) => (document['stops'][1].commonGuess.option = document['stops'][1].answer))).toContain('common_guess_invalid@stops.1.commonGuess');
    expect(broken((document) => delete document['stops'][1].commonGuess)).toContain('common_guess_missing@stops.1');
    expect(
      broken((document) => (document['stops'][4].commonGuess = { ...document['stops'][1].commonGuess })),
    ).toContain('common_guess_unexpected@stops.4.commonGuess');
    expect(broken((document) => (document['misconception'] = { kind: 'none' }))).toContain('common_guess_unexpected@stops.1.commonGuess');
  });

  it('needs a limits aside that opens before the Final call and that the recap links to', () => {
    expect(broken((document) => (document['asides'] = []))).toEqual(expect.arrayContaining(['limits_aside_missing@asides']));
    expect(broken((document) => (document['asides'][0].anchorStop = 's9'))).toContain('limits_aside_last@asides.0.anchorStop');
    expect(broken((document) => (document['asides'][0].anchorStop = 's99'))).toContain('aside_anchor_unknown@asides.0.anchorStop');
    expect(broken((document) => (document['recap'].smallPrintAside = 'a9'))).toContain('recap_small_print_unknown@recap.smallPrintAside');
    expect(broken((document) => (document['asides'][0].anchorStop = 's8'))).toEqual([]);
  });

  it('keeps ids unique across stops and asides', () => {
    expect(broken((document) => (document['asides'][0].id = 's2'))).toContain('id_duplicate@asides.0.id');
  });

  it('checks the stage: first stop, order, known stops, self-described states and enough change', () => {
    expect(broken((document) => (document['stage'].states[0].stop = 's2'))).toContain('stage_first_state_missing@stage.states');
    expect(broken((document) => (document['stage'].states[1].stop = 's99'))).toContain('stage_state_stop_unknown@stage.states.1.stop');
    expect(broken((document) => (document['stage'].states[2].stop = document['stage'].states[1].stop))).toContain('stage_states_unordered@stage.states.2.stop');
    expect(broken((document) => (document['stage'].states[1].alt = 'A picture that does not match.'))).toContain('stage_alt_mismatch@stage.states.1.alt');
    expect(broken((document) => (document['stage'].states[1].state = { ...document['stage'].states[0].state }))).toEqual(
      expect.arrayContaining(['stage_state_repeated@stage.states.1']),
    );
    expect(broken((document) => (document['stage'].states = document['stage'].states.slice(0, 2)))).toContain('stage_too_static@stage.states');
  });

  it('holds the reading time to three to six minutes at 230 words a minute plus ten seconds a call', () => {
    expect(
      broken((document) => {
        for (const stop of document['stops']) if (stop.kind === 'read') stop.blocks = [{ type: 'paragraph', text: filler(10, 7) }];
      }),
    ).toContain('reading_length_out_of_brief@measures.readingSeconds');
  });

  it('notes an unreviewed source without refusing the Scroll', () => {
    const document = fixture();
    document['misconception'].source.reviewed = false;
    document['stops'][1].commonGuess.source.reviewed = false;
    const outcome = validateDocumentV2(signed(document));
    expect(outcome.kind === 'valid' && outcome.notices).toEqual([{ code: 'misconception_source_unreviewed', path: 'misconception.source' }]);
  });
});
