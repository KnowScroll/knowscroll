import { describe, expect, it } from 'vitest';
import { authoredV2, compileInputV2, filler, MYTH_V2, PASSAGES_V2 } from '../../test-support/v2-fixtures.js';
import { validateDocumentV2 } from '../../v2/validate.js';
import { AuthoredScrollV2 } from './authoring-schema.js';
import { compileAuthoredV2, type CompileV2Outcome } from './compile.js';

type Mutable = { items: Record<string, unknown>[]; [key: string]: unknown };

/** The fixture as a plain object a test can change, then parsed again so only schema-valid input reaches the compiler. */
function changed(edit: (draft: Mutable) => void, variant: 'stage' | 'plain' = 'stage'): AuthoredScrollV2 {
  const draft = JSON.parse(JSON.stringify(authoredV2(variant))) as Mutable;
  edit(draft);
  return AuthoredScrollV2.parse(draft);
}

const refusedWith = (outcome: CompileV2Outcome) => (outcome.kind === 'refused' ? outcome.issues : []);
const findings = (authored: AuthoredScrollV2, variant: 'stage' | 'plain' = 'stage') =>
  refusedWith(compileAuthoredV2(authored, compileInputV2(variant)));
const codes = (authored: AuthoredScrollV2, variant: 'stage' | 'plain' = 'stage') =>
  findings(authored, variant).map((issue) => `${issue.code}@${issue.path}`);

const itemIndex = (draft: Mutable, type: string, nth = 0): number =>
  draft.items.flatMap((item, index) => (item['type'] === type ? [index] : []))[nth] ?? -1;

describe('compileAuthoredV2: a valid Scroll', () => {
  it.each(['stage', 'plain'] as const)('compiles the %s fixture into a document that admission accepts', (variant) => {
    const outcome = compileAuthoredV2(authoredV2(variant), compileInputV2(variant));
    expect(outcome.kind).toBe('compiled');
    if (outcome.kind !== 'compiled') return;
    expect(validateDocumentV2(JSON.parse(JSON.stringify(outcome.document))).kind).toBe('valid');
    expect(outcome.document.stops.at(-1)?.kind).toBe('final_call');
    expect(outcome.document.stage === undefined).toBe(variant === 'plain');
    expect(outcome.document.measures.readingSeconds).toBeGreaterThanOrEqual(180);
    expect(outcome.document.measures.readingSeconds).toBeLessThanOrEqual(360);
  });

  it('is deterministic: the same authoring always gives byte-identical output', () => {
    const first = compileAuthoredV2(authoredV2(), compileInputV2());
    const second = compileAuthoredV2(authoredV2(), compileInputV2());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('sets the misconception, its source and the common guess from the recipe, never from the writer', () => {
    const outcome = compileAuthoredV2(authoredV2(), compileInputV2());
    if (outcome.kind !== 'compiled') throw new Error('expected a compiled Scroll');
    expect(outcome.document.misconception).toEqual(MYTH_V2);
    const firstCall = outcome.document.stops.find((stop) => stop.kind === 'call_it');
    expect(firstCall?.kind === 'call_it' && firstCall.commonGuess?.source).toEqual(MYTH_V2.source);
    // The guess is a wrong option, and the answer is the option the writer put first.
    expect(firstCall?.kind === 'call_it' && firstCall.commonGuess?.option).not.toBe(
      firstCall?.kind === 'call_it' ? firstCall.answer : -1,
    );
  });

  it('records which claims every part rests on, by the document’s own ids', () => {
    const outcome = compileAuthoredV2(authoredV2(), compileInputV2());
    if (outcome.kind !== 'compiled') throw new Error('expected a compiled Scroll');
    expect(outcome.citations['s1']).toEqual(['claim-v2-1', 'claim-v2-2']);
    expect(outcome.citations['a1']).toEqual(['claim-v2-6']);
    expect(outcome.citations['recap']).toEqual(['claim-v2-1', 'claim-v2-5']);
    expect(Object.keys(outcome.citations)).toHaveLength(
      outcome.document.stops.length + outcome.document.asides.length + 1,
    );
  });

  it('reports an unreviewed source as a notice, not a refusal', () => {
    const outcome = compileAuthoredV2(
      authoredV2(),
      compileInputV2('stage', { ...MYTH_V2, source: { ...MYTH_V2.source, reviewed: false } }),
    );
    expect(outcome.kind === 'compiled' && outcome.notices).toEqual([
      { code: 'misconception_source_unreviewed', path: 'misconception.source' },
    ]);
  });
});

describe('compileAuthoredV2: stops and lines', () => {
  it('refuses a stop over 60 words, a line over 12 and a simple text over 60, at the writer’s item', () => {
    const result = codes(
      changed((draft) => {
        draft.items[2] = { ...draft.items[2], text: filler(61, 90) };
        draft.items[3] = {
          ...draft.items[3],
          line: 'one two three four five six seven eight nine ten eleven twelve thirteen',
        };
        draft.items[4] = { ...draft.items[4], simple: filler(61, 92) };
      }),
    );
    expect(result).toContain('stop_too_long@items.2');
    expect(result).toContain('line_too_long@items.3.line');
    expect(result).toContain('simple_too_long@items.4.simple');
  });

  it('counts the text and the line of a stop together against 60 words, and allows exactly 60', () => {
    const line = 'one two three four five six seven eight nine ten eleven twelve';
    const exact = codes(changed((draft) => (draft.items[0] = { ...draft.items[0], text: filler(48, 93), line })));
    expect(exact.filter((entry) => /stop_too_long|line_too_long/u.test(entry))).toEqual([]);
    const over = codes(changed((draft) => (draft.items[0] = { ...draft.items[0], text: filler(49, 93), line })));
    expect(over).toContain('stop_too_long@items.0');
  });

  it('refuses a Scroll with too few stops', () => {
    const fewer = changed((draft) => {
      draft.items = [0, 1, 2, 3, 8, 9].map((index) => draft.items[index] as Record<string, unknown>);
    });
    expect(codes(fewer)).toContain('stops_too_few@items');
    expect(AuthoredScrollV2.safeParse({ ...authoredV2(), items: authoredV2().items.slice(0, 5) }).success).toBe(false);
  });
});

describe('compileAuthoredV2: calls', () => {
  it('allows four calls and refuses five', () => {
    const extraCall = (draft: Mutable, count: number) => {
      const template = draft.items[itemIndex(draft, 'call_it', 1)] as Record<string, unknown>;
      const at = itemIndex(draft, 'stop', 3);
      draft.items.splice(at + 1, 0, ...Array.from({ length: count }, () => ({ ...template })));
    };
    expect(codes(changed((draft) => extraCall(draft, 1)))).not.toContain('call_budget_exceeded@items');
    expect(codes(changed((draft) => extraCall(draft, 2)))).toContain('call_budget_exceeded@items');
  });

  it('needs a Final call that is the only one and ends the spine', () => {
    expect(codes(changed((draft) => draft.items.splice(itemIndex(draft, 'final_call'), 1)))).toContain(
      'final_call_missing@items',
    );
    expect(
      codes(
        changed((draft) => {
          const final = draft.items[itemIndex(draft, 'final_call')] as Record<string, unknown>;
          draft.items.splice(itemIndex(draft, 'stop', 2), 0, final);
        }),
      ),
    ).toContain('final_call_misplaced@items');
    expect(
      codes(
        changed((draft) => {
          const final = draft.items[itemIndex(draft, 'final_call')] as Record<string, unknown>;
          draft.items.push({ ...final });
        }),
      ),
    ).toContain('final_call_misplaced@items');
  });

  it('needs at least one Call it besides the Final call', () => {
    expect(
      codes(changed((draft) => (draft.items = draft.items.filter((item) => item['type'] !== 'call_it')))),
    ).toContain('call_it_missing@items');
  });

  it('refuses duplicate options', () => {
    const result = codes(
      changed((draft) => {
        const index = itemIndex(draft, 'call_it', 1);
        const options = (draft.items[index] as { options: string[] }).options;
        draft.items[index] = { ...draft.items[index], options: [options[0], options[0]] };
      }),
    );
    expect(result).toContain('call_options_duplicate@items.4.options');
  });

  it('puts the correct option in an order the writer cannot predict', () => {
    const outcome = compileAuthoredV2(authoredV2(), compileInputV2());
    if (outcome.kind !== 'compiled') throw new Error('expected a compiled Scroll');
    const positions = outcome.document.stops.flatMap((stop) => (stop.kind === 'read' ? [] : [stop.answer]));
    expect(positions.length).toBe(3);
    expect(new Set(positions).size).toBeGreaterThan(1);
  });

  it('keeps the common guess to the first Call it of a myth Scroll', () => {
    const missing = changed((draft) => {
      const index = itemIndex(draft, 'call_it', 0);
      const { commonGuess: _removed, ...rest } = draft.items[index] as Record<string, unknown>;
      draft.items[index] = rest;
    });
    expect(codes(missing)).toContain('common_guess_missing@items.1');

    const second = changed((draft) => {
      draft.items[itemIndex(draft, 'call_it', 1)] = { ...draft.items[itemIndex(draft, 'call_it', 1)], commonGuess: 1 };
    });
    expect(codes(second)).toContain(
      `common_guess_unexpected@items.${itemIndex(JSON.parse(JSON.stringify({ items: authoredV2().items })) as Mutable, 'call_it', 1)}.commonGuess`,
    );

    const outOfRange = changed((draft) => {
      const index = itemIndex(draft, 'call_it', 0);
      draft.items[index] = {
        ...draft.items[index],
        options: ['correct option here', 'only a wrong option'],
        commonGuess: 2,
      };
    });
    expect(codes(outOfRange)).toContain('common_guess_invalid@items.1.commonGuess');
  });

  it('refuses a common guess when the recipe names no myth', () => {
    const outcome = compileAuthoredV2(authoredV2(), compileInputV2('stage', { kind: 'none' }));
    expect(refusedWith(outcome).map((issue) => `${issue.code}@${issue.path}`)).toContain(
      'common_guess_unexpected@items.1.commonGuess',
    );
    const withoutGuess = changed((draft) => {
      const index = itemIndex(draft, 'call_it', 0);
      const { commonGuess: _removed, ...rest } = draft.items[index] as Record<string, unknown>;
      draft.items[index] = rest;
    });
    expect(compileAuthoredV2(withoutGuess, compileInputV2('stage', { kind: 'none' })).kind).toBe('compiled');
  });
});

describe('compileAuthoredV2: asides', () => {
  it('needs a limits aside, next to the claim it limits and never after the Final call', () => {
    expect(codes(changed((draft) => draft.items.splice(itemIndex(draft, 'aside'), 1)))).toContain(
      'limits_aside_missing@items',
    );
    const last = changed((draft) => {
      const [aside] = draft.items.splice(itemIndex(draft, 'aside'), 1);
      draft.items.push(aside as Record<string, unknown>);
    });
    expect(codes(last)).toContain(`limits_aside_last@items.${authoredV2().items.length - 1}`);
  });

  it('allows the limits aside right before the Final call, as the Seasons design places it', () => {
    expect(codes(authoredV2())).toEqual([]);
  });

  it('refuses an aside before any stop, and any other aside after the Final call', () => {
    expect(
      codes(
        changed((draft) => {
          const [aside] = draft.items.splice(itemIndex(draft, 'aside'), 1);
          draft.items.unshift(aside as Record<string, unknown>);
          draft.items.splice(itemIndex(draft, 'final_call'), 0, { ...(aside as Record<string, unknown>) });
        }),
      ),
    ).toContain('aside_before_stop@items.0');
    expect(
      codes(
        changed((draft) => {
          draft.items.push({ type: 'aside', cites: ['e2'], kind: 'tangent', title: 'A tangent', text: filler(20, 70) });
        }),
      ),
    ).toContain(`aside_after_final_call@items.${authoredV2().items.length}`);
  });
});

describe('compileAuthoredV2: the stage', () => {
  it('refuses a stage on a plain Scroll and a stage Scroll that never sets its first picture', () => {
    expect(codes(authoredV2('stage'), 'plain')).toContain('stage_unexpected@items.0.stage');
    const noOpening = changed((draft) => {
      draft.items[0] = { ...draft.items[0], stage: { earthAt: 'jun' } };
    });
    expect(codes(noOpening)).toContain('stage_first_state_missing@items.0.stage');
    const none = changed((draft) => {
      for (const item of draft.items) delete item['stage'];
    });
    expect(codes(none)).toContain('stage_first_state_missing@items.0.stage');
  });

  it('refuses a stage that does not change enough to be a stage', () => {
    const still = changed((draft) => {
      for (const item of draft.items) if (item['stage'] !== undefined) item['stage'] = {};
      draft.items[0] = { ...draft.items[0], stage: { view: 'sun-earth' } };
    });
    expect(codes(still)).toContain('stage_too_static@items');
  });

  it('refuses a word that is not in the kit, so the writer cannot invent a picture', () => {
    const parsed = AuthoredScrollV2.safeParse({
      ...authoredV2(),
      items: authoredV2().items.map((item, index) => (index === 0 ? { ...item, stage: { view: 'a-castle' } } : item)),
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path.join('.')).toBe('items.0.stage.view');
    const unknownKey = AuthoredScrollV2.safeParse({
      ...authoredV2(),
      items: authoredV2().items.map((item, index) => (index === 0 ? { ...item, stage: { x: 4 } } : item)),
    });
    expect(unknownKey.success).toBe(false);
  });
});

describe('compileAuthoredV2: claims cite like any other claim', () => {
  it('refuses a handle that was not offered and a Scroll that cites too few passages', () => {
    expect(codes(changed((draft) => (draft.items[2] = { ...draft.items[2], cites: ['e1', 'e99'] })))).toContain(
      'authoring_cite_unknown@items.2',
    );
    const narrow = changed((draft) => {
      for (const item of draft.items) item['cites'] = ['e1'];
      (draft['recap'] as { cites: string[] }).cites = ['e1'];
    });
    expect(codes(narrow)).toContain('authoring_too_few_cites@$');
  });

  it('refuses a figure in a call’s answer, an option or a simple text unless a cited passage states it', () => {
    const inExplain = changed((draft) => {
      const index = itemIndex(draft, 'call_it', 1);
      draft.items[index] = { ...draft.items[index], explain: `${filler(30, 71)} It is 47 percent.` };
    });
    expect(codes(inExplain)).toContain(`authoring_number_not_in_evidence@items.4`);
    const inOption = changed((draft) => {
      const index = itemIndex(draft, 'final_call');
      draft.items[index] = {
        ...draft.items[index],
        options: ['It leans by 31 degrees', 'It does not lean', 'It leans by 12 degrees'],
      };
    });
    // The final call cites e1, which states 31 but not 12.
    expect(codes(inOption)).toContain('authoring_number_not_in_evidence@items.9');
    const inSimple = changed((draft) => {
      draft.items[2] = { ...draft.items[2], simple: 'It is 99 times as far.' };
    });
    expect(codes(inSimple)).toContain('authoring_number_not_in_evidence@items.2');
  });

  it('accepts a figure that a cited passage states, written the same way', () => {
    const cited = changed((draft) => {
      draft.items[3] = { ...draft.items[3], text: `${filler(40, 72)} The lean is 31 degrees.` };
    });
    expect(codes(cited)).not.toContain('authoring_number_not_in_evidence@items.3');
  });

  it('refuses nine words in a row from the research, in a stop, an aside or a call', () => {
    const passage = PASSAGES_V2[5] ?? '';
    const copyOf = passage.split(' ').slice(0, 12).join(' ');
    const result = codes(
      changed((draft) => {
        draft.items[2] = { ...draft.items[2], text: copyOf };
        const call = itemIndex(draft, 'call_it', 1);
        draft.items[call] = { ...draft.items[call], explain: copyOf };
        draft.items[itemIndex(draft, 'aside')] = { ...draft.items[itemIndex(draft, 'aside')], text: copyOf };
      }),
    );
    expect(result).toEqual(
      expect.arrayContaining(['copied_passage@items.2', 'copied_passage@items.4', 'copied_passage@items.8']),
    );
  });
});

describe('compileAuthoredV2: reading time and text', () => {
  it('refuses a Scroll under three minutes and one over six', () => {
    const short = changed((draft) => {
      for (const item of draft.items) if (item['type'] === 'stop') item['text'] = filler(20, 73);
    });
    expect(codes(short)).toContain('reading_length_out_of_brief@$');
    const long = changed((draft) => {
      const stopTemplate = draft.items[0] as Record<string, unknown>;
      for (const item of draft.items) {
        if (item['type'] === 'stop') item['text'] = filler(60, 74);
        else if (item['type'] !== 'aside')
          Object.assign(item, { prompt: filler(20, 75), explain: filler(60, 75), twist: filler(60, 76) });
      }
      const asides = [1, 2, 3].map((tag) => ({
        type: 'aside',
        cites: ['e2'],
        kind: 'tangent',
        title: 'Tangent',
        text: filler(60, 80 + tag),
      }));
      const extraStops = [1, 2, 3, 4].map((tag) => ({ ...stopTemplate, text: filler(60, 90 + tag), stage: {} }));
      draft.items.splice(
        8,
        1,
        ...extraStops,
        ...asides.slice(0, 1),
        draft.items[8] as Record<string, unknown>,
        ...asides.slice(1),
      );
    });
    expect(codes(long)).toContain('reading_length_out_of_brief@$');
    expect(codes(long)).not.toContain('call_budget_exceeded@items');
  });

  it('refuses a web address in reader text', () => {
    const result = codes(
      changed((draft) => {
        draft.items[2] = { ...draft.items[2], text: `${filler(30, 77)} See www.example.org for more.` };
      }),
    );
    expect(result).toContain('text_mentions_web_address@items.2.text');
  });

  it('reports every kind of finding in one pass, so one repair can fix them all', () => {
    const result = codes(
      changed((draft) => {
        draft.items[3] = { ...draft.items[3], cites: ['e98'], text: filler(70, 78) };
        draft.items[5] = { ...draft.items[5], simple: 'It is 99 times as far.' };
        draft.items[8] = { ...draft.items[8], text: (PASSAGES_V2[4] ?? '').split(' ').slice(0, 11).join(' ') };
      }),
    );
    expect(result).toEqual(
      expect.arrayContaining([
        'authoring_cite_unknown@items.3',
        'stop_too_long@items.3',
        'authoring_number_not_in_evidence@items.5',
        'copied_passage@items.8',
      ]),
    );
  });

  it('cuts a title or heading a little over its limit instead of refusing it', () => {
    const outcome = compileAuthoredV2(
      changed((draft) => {
        draft['title'] =
          `Why Orrin has summers and winters and the reason is not the one most people give at first glance`;
        draft.items[0] = {
          ...draft.items[0],
          heading: 'A heading that runs quite a bit longer than the spine is able to show',
        };
      }),
      compileInputV2(),
    );
    expect(outcome.kind).toBe('compiled');
    if (outcome.kind !== 'compiled') throw new Error('expected a compiled Scroll');
    expect(outcome.document.title.length).toBeLessThanOrEqual(90);
    const first = outcome.document.stops[0];
    expect(
      first?.kind === 'read' && first.blocks[0]?.type === 'heading' && first.blocks[0].text.length,
    ).toBeLessThanOrEqual(60);
  });
});
