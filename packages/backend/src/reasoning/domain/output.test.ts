import { fc, test } from '@fast-check/vitest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  MAX_ANSWER_DEPTH,
  MAX_ANSWER_CHARS,
  MAX_ISSUES,
  exceedsDepth,
  extractJsonObject,
  issueFor,
  issueForExtraction,
  summariseIssues,
  validateOutput,
  validSafeCustomIssues,
} from './output.js';

describe('strict JSON extraction', () => {
  it('accepts exactly one bare JSON object, with surrounding whitespace', () => {
    expect(extractJsonObject('  {"ok": true, "echo": "lantern"}\n')).toEqual({
      ok: true,
      value: { ok: true, echo: 'lantern' },
    });
  });

  it('accepts one fenced block containing one object', () => {
    expect(extractJsonObject('```json\n{"ok": true}\n```')).toEqual({ ok: true, value: { ok: true } });
    expect(extractJsonObject('```\n{"ok": true}\n```')).toEqual({ ok: true, value: { ok: true } });
  });

  it.each([
    ['prose before the object', 'Here you go: {"ok": true}'],
    ['prose after the object', '{"ok": true} Hope this helps!'],
    ['two objects', '{"ok": true}{"ok": false}'],
    ['two objects on lines', '{"ok": true}\n{"ok": false}'],
    ['an array', '[{"ok": true}]'],
    ['a scalar', '"ok"'],
    ['a truncated object', '{"ok": tr'],
    ['prose around a fence', 'Sure:\n```json\n{"ok": true}\n```'],
    ['two fences', '```json\n{"a": 1}\n```\n```json\n{"b": 2}\n```'],
    ['an unclosed fence', '```json\n{"ok": true}'],
  ])('refuses %s', (_label, text) => {
    expect(extractJsonObject(text)).toEqual({ ok: false, reason: 'OUTPUT_NOT_ONE_JSON_OBJECT' });
  });

  it('distinguishes an empty answer', () => {
    expect(extractJsonObject('   \n')).toEqual({ ok: false, reason: 'OUTPUT_EMPTY' });
  });

  it('keeps a <think> tag inside a JSON string (provider framing is the adapter’s job)', () => {
    expect(extractJsonObject('{"note": "<think>user text</think>"}')).toEqual({
      ok: true,
      value: { note: '<think>user text</think>' },
    });
  });
});

describe('safe structural JSON refusal diagnostics (CI fixture)', () => {
  const reason = 'OUTPUT_NOT_ONE_JSON_OBJECT';
  const grammar =
    /^answer with exactly one JSON object and nothing else; json-refusal\.v1 phase=(framing|syntax) framing=(bare|fenced|invalid_fence|embedded_fence) prefix=(object|array|scalar|other) category=(expected_property|expected_comma_or_separator|unterminated_string|unexpected_end|unexpected_token|other) chars=(\d{1,6})$/u;
  it.each([
    ['unquoted property', '{unquoted:true}', 'syntax', 'bare', 'object', 'expected_property'],
    ['trailing comma', '{"a":true,}', 'syntax', 'bare', 'object', 'expected_property'],
    ['missing comma', '{"a":1 "b":2}', 'syntax', 'bare', 'object', 'expected_comma_or_separator'],
    ['missing colon', '{"a" 1}', 'syntax', 'bare', 'object', 'expected_comma_or_separator'],
    ['array separator', '{"a":[1 2]}', 'syntax', 'bare', 'object', 'expected_comma_or_separator'],
    ['unterminated string', '{"a":"unfinished}', 'syntax', 'bare', 'object', 'unterminated_string'],
    ['incomplete object', '{"a":', 'syntax', 'bare', 'object', 'unexpected_end'],
    ['unexpected value', '{"a":nope}', 'syntax', 'bare', 'object', 'unexpected_token'],
    ['other syntax', '{"a":"\\q"}', 'syntax', 'bare', 'object', 'other'],
    ['two objects', '{}{}', 'framing', 'bare', 'object', 'unexpected_token'],
    ['leading prose', 'Here is the object: {}', 'framing', 'bare', 'other', 'other'],
    ['trailing prose', '{} This is prose.', 'framing', 'bare', 'object', 'unexpected_token'],
    ['array', '[{}]', 'framing', 'bare', 'array', 'other'],
    ['scalar', '"value"', 'framing', 'bare', 'scalar', 'other'],
    ['bad fence', '```json\n{}', 'framing', 'invalid_fence', 'other', 'other'],
    ['embedded fence', '```json\n{"a":"```"}\n```', 'framing', 'embedded_fence', 'object', 'other'],
    ['fenced syntax', '```json\n{bad:true}\n```', 'syntax', 'fenced', 'object', 'expected_property'],
  ])('keeps %s refused with fixed categories only', (_label, text, phase, framing, prefix, category) => {
    expect(extractJsonObject(text)).toEqual({ ok: false, reason });
    const issue = issueForExtraction(reason, text);
    expect(issue.path).toBe('(root)');
    expect(issue.code).toBe('not_one_json_object');
    expect(issue.detail).toContain(`phase=${phase} framing=${framing} prefix=${prefix} category=${category}`);
    expect(issue.detail).toMatch(grammar);
  });

  it('preserves legacy issue details and all other refusal codes and bounds', () => {
    expect(issueFor(reason)).toEqual({
      path: '(root)',
      code: 'not_one_json_object',
      detail: 'answer with exactly one JSON object and nothing else',
    });
    expect(extractJsonObject('x'.repeat(MAX_ANSWER_CHARS + 1))).toEqual({ ok: false, reason: 'OUTPUT_TOO_LARGE' });
    for (const code of [
      'OUTPUT_EMPTY',
      'OUTPUT_TOO_LARGE',
      'OUTPUT_TRUNCATED',
      'OUTPUT_TOO_DEEP',
      'OUTPUT_SCHEMA_MISMATCH',
      'REPLY_UNREADABLE',
    ] as const)
      expect(issueForExtraction(code, 'PRIVATE-UNREADABLE-ANSWER')).toEqual(issueFor(code));
    expect(issueForExtraction(reason, 'x'.repeat(MAX_ANSWER_CHARS + 1))).toEqual(issueFor(reason));
  });

  it('falls back to a fixed other category for an unknown engine error, without its message', () => {
    const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw new SyntaxError('PRIVATE-ENGINE-ERROR with an arbitrary reply snippet');
    });
    try {
      const issue = issueForExtraction(reason, '{broken: true}');
      expect(issue.detail).toContain('phase=syntax framing=bare prefix=object category=other');
      expect(issue.detail).toMatch(grammar);
      expect(JSON.stringify(issue)).not.toContain('PRIVATE-ENGINE-ERROR');
    } finally {
      parse.mockRestore();
    }
  });

  test.prop([fc.string({ maxLength: 512 })])(
    'malformed secret-bearing keys, values and framing cannot enter an issue',
    (text) => {
      const canary = 'DIAGNOSTIC-PRIVATE-CANARY-Zq81';
      const fakeKey = `sk-cp-${canary}-01234567890123456789`;
      const fakeUrl = `https://private.example/${canary}?X-Amz-Signature=${canary}`;
      const key = JSON.stringify(`${text}${fakeKey}${fakeUrl}`);
      const malformed = `{${key}:nope}`;
      for (const answer of [
        malformed,
        `prose ${fakeUrl} ${malformed}`,
        `\`\`\`json\n${malformed}\n\`\`\``,
        `${malformed}${fakeKey}`,
      ]) {
        expect(extractJsonObject(answer)).toEqual({ ok: false, reason });
        const issue = issueForExtraction(reason, answer);
        expect(issue.detail).toMatch(grammar);
        expect(issue.detail?.length).toBeLessThan(256);
        const match = grammar.exec(issue.detail ?? '');
        expect(Number(match?.[5])).toBeLessThanOrEqual(MAX_ANSWER_CHARS);
        expect(Number(match?.[5])).toBeGreaterThanOrEqual(0);
        for (const secret of [canary, fakeKey, fakeUrl, 'private.example', 'X-Amz-Signature'])
          expect(JSON.stringify(issue)).not.toContain(secret);
      }
    },
  );
});

describe('the validator summary', () => {
  const schema = z.object({ ok: z.literal(true), echo: z.string().max(5), letters: z.number().int() }).strict();

  it('retains only explicitly declared custom codes and fixed hints, preserving path masking', () => {
    const privateText = 'PRIVATE-REPLY https://private.example/?signature=fixture';
    const semantic = z.object({ rows: z.array(z.object({ text: z.string() })) }).superRefine((_value, ctx) => {
      ctx.addIssue({
        code: 'custom',
        path: ['rows', 0, privateText],
        message: privateText,
        params: { safeCode: 'binding_missing' },
      });
    });
    const value = { rows: [{ text: privateText }] };
    const catalogue = { binding_missing: 'Bind this passage to an offered claim.' };
    expect(validateOutput(semantic, value, catalogue)).toEqual({
      valid: false,
      reason: 'OUTPUT_SCHEMA_MISMATCH',
      issues: [{ path: 'rows[0].?', code: 'binding_missing', detail: catalogue.binding_missing }],
    });
    expect(validateOutput(semantic, value)).toEqual({
      valid: false,
      reason: 'OUTPUT_SCHEMA_MISMATCH',
      issues: [{ path: 'rows[0].?', code: 'custom' }],
    });
    expect(JSON.stringify(validateOutput(semantic, value, catalogue))).not.toContain(privateText);
  });

  it.each([
    undefined,
    null,
    'binding_missing',
    {},
    { safeCode: 1 },
    { safeCode: ['binding_missing'] },
    { safeCode: 'undeclared' },
    { safeCode: '__proto__' },
    { safeCode: 'constructor' },
    { safeCode: 'prototype' },
    { safeCode: 'x'.repeat(65) },
    { safeCode: 'private value' },
    Object.create({ safeCode: 'binding_missing' }) as object,
  ])('suppresses untrusted custom messages and malformed/undeclared metadata (%j)', (params) => {
    const custom = z.object({}).superRefine((_value, ctx) => {
      ctx.addIssue({ code: 'custom', message: 'binding_missing', params: params as Record<string, unknown> });
    });
    const catalogue = Object.assign(
      Object.create({ undeclared: 'Never inherit this hint.' }) as Record<string, string>,
      {
        binding_missing: 'A fixed code-owned hint.',
        constructor: 'Never emit this hint.',
      },
    );
    expect(validateOutput(custom, {}, catalogue)).toEqual({
      valid: false,
      reason: 'OUTPUT_SCHEMA_MISMATCH',
      issues: [{ path: '(root)', code: 'custom' }],
    });
  });

  it('bounds the opt-in code catalogue at admission', () => {
    expect(validSafeCustomIssues({ binding_missing: 'A fixed hint.' })).toBe(true);
    expect(
      validSafeCustomIssues(Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`code_${i}`, 'hint']))),
    ).toBe(true);
    for (const invalid of [
      Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`code_${i}`, 'hint'])),
      { ['x'.repeat(65)]: 'hint' },
      { 'unknown field': 'hint' },
      { constructor: 'hint' },
      JSON.parse('{"__proto__":"hint"}') as Record<string, string>,
      { code: '' },
      { code: 'x'.repeat(257) },
      { code: 'line\nbreak' },
    ])
      expect(validSafeCustomIssues(invalid)).toBe(false);
  });

  it('rejects hidden, accessor and symbol catalogue properties without invoking getters', () => {
    let getterReads = 0;
    const accessor = Object.defineProperty({}, 'code', {
      enumerable: true,
      get() {
        getterReads += 1;
        return 'x'.repeat(257);
      },
    }) as Record<string, string>;
    const hiddenCodes = Object.defineProperties(
      {},
      Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`code_${i}`, { value: 'hint', enumerable: false }])),
    ) as Record<string, string>;
    for (const invalid of [
      Object.defineProperty({}, 'code', { value: 'A short hidden hint.' }) as Record<string, string>,
      Object.defineProperty({}, 'code', { value: 'x'.repeat(257) }) as Record<string, string>,
      hiddenCodes,
      accessor,
      { [Symbol('hidden-code')]: 'hint' },
    ])
      expect(validSafeCustomIssues(invalid)).toBe(false);
    expect(getterReads).toBe(0);
  });

  it.each([
    ['C1 next line', '\u0085'],
    ['C1 control sequence', '\u009b'],
    ['bidi override', '\u202e'],
    ['bidi isolate', '\u2066'],
    ['zero-width space', '\u200b'],
  ])('rejects Unicode control/format hint characters: %s', (_label, control) => {
    expect(validSafeCustomIssues({ code: `Fixed${control}hint.` })).toBe(false);
    expect(validSafeCustomIssues({ code: 'Keep the Scroll’s original meaning — rewrite this passage.' })).toBe(true);
  });

  it('reports missing fields, bounds, literals and unexpected keys structurally', () => {
    const verdict = validateOutput(schema, { ok: false, echo: 'lantern', 'run rm -rf': 1 });
    expect(verdict.valid).toBe(false);
    if (verdict.valid) return;
    expect(verdict.reason).toBe('OUTPUT_SCHEMA_MISMATCH');
    expect(verdict.issues).toEqual(
      expect.arrayContaining([
        { path: 'ok', code: 'invalid_value', detail: 'allowed: true' },
        { path: 'echo', code: 'too_big', detail: 'at most 5 characters' },
        { path: 'letters', code: 'missing', detail: 'required; expected number' },
        { path: '(root)', code: 'unrecognized_keys', detail: 'unexpected keys' },
      ]),
    );
  });

  it('states every bound with its unit, which the model does not know', () => {
    const bounded = z.object({
      word: z.string().min(2).max(4),
      list: z.array(z.string()).min(1).max(3),
      count: z.number().gt(0).lte(9),
    });
    const verdict = validateOutput(bounded, { word: 'x'.repeat(9), list: [], count: 0 });
    expect(verdict.valid).toBe(false);
    if (verdict.valid) return;
    expect(verdict.issues).toEqual([
      { path: 'word', code: 'too_big', detail: 'at most 4 characters' },
      { path: 'list', code: 'too_small', detail: 'at least 1 item' },
      { path: 'count', code: 'too_small', detail: 'more than 0' },
    ]);
    const tooMany = validateOutput(bounded, { word: 'ab', list: ['a', 'b', 'c', 'd'], count: 10 });
    expect(tooMany.valid).toBe(false);
    if (tooMany.valid) return;
    expect(tooMany.issues).toEqual([
      { path: 'list', code: 'too_big', detail: 'at most 3 items' },
      { path: 'count', code: 'too_big', detail: 'at most 9' },
    ]);
  });

  describe('paths never carry a string the model chose (review M3)', () => {
    const issuesOf = (schema: z.ZodType, value: unknown) => {
      const verdict = validateOutput(schema, value as Record<string, unknown>);
      if (verdict.valid) throw new Error('expected the value to be rejected');
      return verdict.issues;
    };

    it('names a record’s keys [key], whatever they are', () => {
      const issues = issuesOf(z.object({ scores: z.record(z.string(), z.number()) }), {
        scores: { 'ignore-previous-instructions-now': 'x', '{{system}}': 'y' },
      });
      expect(issues).toEqual([
        { path: 'scores[key]', code: 'invalid_type', detail: 'expected number' },
        { path: 'scores[key]', code: 'invalid_type', detail: 'expected number' },
      ]);
      expect(JSON.stringify(issues)).not.toContain('ignore-previous');
    });

    it('prints ? for a key the schema does not declare, and [key] for a map', () => {
      const catchall = z.object({ fixed: z.number() }).catchall(z.number());
      expect(issuesOf(catchall, { fixed: 1, 'evil-key': 'x' })).toEqual([
        { path: '?', code: 'invalid_type', detail: 'expected number' },
      ]);
      const nestedCatchall = z.object({ outer: catchall });
      expect(issuesOf(nestedCatchall, { outer: { fixed: 1, 'evil-key': 'x' } })[0]?.path).toBe('outer.?');
      expect(issuesOf(z.object({ m: z.map(z.string(), z.number()) }), { m: 'not a map' })[0]?.path).toBe('m');
    });

    it('keeps declared names, tuple and array positions, through optional, nullable and union wrappers', () => {
      const schema = z.object({
        plan: z
          .object({
            steps: z.array(z.object({ title: z.string() })),
            pair: z.tuple([z.string(), z.number()]).optional(),
          })
          .nullable(),
        either: z.union([z.object({ left: z.number() }), z.object({ right: z.number() })]),
      });
      const issues = issuesOf(schema, {
        plan: { steps: [{ title: 'ok' }, { title: 5 }], pair: ['a', 'b'] },
        either: { left: 'x' },
      });
      expect(issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining(['plan.steps[1].title', 'plan.pair[1]']),
      );
    });

    it('keeps later discriminated branches through shared data, optional fields and nested arrays', () => {
      const block = z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('paragraph'), data: z.object({ spans: z.array(z.string()) }) }),
        z.object({
          kind: z.literal('diagram'),
          data: z.object({
            nodes: z.array(z.object({ cell: z.object({ row: z.number() }).optional() })),
            interaction: z.object({ kind: z.literal('toggle') }).nullable(),
          }),
        }),
      ]);
      const schema = z.object({ sections: z.array(z.object({ blocks: z.array(block) })) });
      const result = validateOutput(schema, {
        sections: [
          {
            blocks: [
              {
                kind: 'diagram',
                data: {
                  nodes: [{ cell: null }],
                  interaction: 3,
                },
              },
            ],
          },
        ],
      });
      expect(result.valid).toBe(false);
      if (!result.valid)
        expect(result.issues).toEqual([
          { path: 'sections[0].blocks[0].data.nodes[0].cell', code: 'invalid_type', detail: 'expected object' },
          { path: 'sections[0].blocks[0].data.interaction', code: 'invalid_type', detail: 'expected object' },
        ]);
    });

    it('carries both intersection branches and conservatively masks map/object ambiguity', () => {
      const schema = z.intersection(
        z.object({ data: z.object({ left: z.number() }) }),
        z.object({ data: z.object({ right: z.number() }) }),
      );
      const result = validateOutput(schema, { data: { left: 'bad', right: 'bad' } });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.issues.map((i) => i.path)).toEqual(['data.left', 'data.right']);
      const ambiguous = z.union([z.object({ chosen: z.number() }), z.record(z.string(), z.number())]);
      expect(
        summariseIssues(
          [{ code: 'invalid_type', message: 'PRIVATE-ISSUE-MESSAGE', expected: 'number', path: ['chosen'] }],
          undefined,
          ambiguous,
        ),
      ).toEqual([{ path: '[key]', code: 'invalid_type', detail: 'expected number' }]);
    });

    it('bounds candidate, wrapper depth, total visits and rendered path without printing unknown names', () => {
      const issue = [
        {
          code: 'invalid_type' as const,
          message: 'PRIVATE-ISSUE-MESSAGE',
          expected: 'object' as const,
          path: ['data', 'private-canary'],
        },
      ];
      const branch = () => z.object({ data: z.object({ leaf: z.number() }) });
      const tooWide = z.union(Array.from({ length: 65 }, branch));
      let tooDeep: z.ZodType = branch();
      for (let n = 0; n < 17; n++) tooDeep = tooDeep.optional();
      const tooMuchWork = z.union(
        Array.from({ length: 64 }, () => {
          let candidate: z.ZodType = branch();
          for (let n = 0; n < 9; n++) candidate = candidate.optional();
          return candidate;
        }),
      );
      for (const schema of [tooWide, tooDeep, tooMuchWork])
        expect(summariseIssues(issue, undefined, schema)).toEqual([
          { path: '?.?', code: 'invalid_type', detail: 'expected object' },
        ]);
      const key = 'a'.repeat(32);
      let long: z.ZodType = z.number();
      for (let n = 0; n < 12; n++) long = z.object({ [key]: long });
      const summary = summariseIssues(
        [
          {
            code: 'invalid_type',
            message: 'PRIVATE-ISSUE-MESSAGE',
            expected: 'number',
            path: Array.from({ length: 12 }, () => key),
          },
        ],
        undefined,
        long,
      );
      expect(summary[0]?.path.length).toBeLessThanOrEqual(256);
      expect(summary[0]?.path.split('.').length).toBeLessThanOrEqual(10);
      const throws = z.lazy(() => {
        throw new Error('PRIVATE-SCHEMA-CANARY');
      });
      expect(summariseIssues(issue, undefined, throws)).toEqual([
        { path: '?.?', code: 'invalid_type', detail: 'expected object' },
      ]);
    });

    it('prints ? for every name when no schema is available', () => {
      const parsed = z.object({ a: z.number() }).safeParse({ a: 'x' });
      if (parsed.success) throw new Error('expected a failure');
      expect(summariseIssues(parsed.error.issues, { a: 'x' })[0]?.path).toBe('?');
    });
  });

  describe('depth', () => {
    const wrap = (levels: number): unknown => {
      let inner: unknown = { leaf: 1 };
      for (let level = 1; level < levels; level += 1) inner = [inner];
      return inner;
    };

    it('accepts nesting up to the bound and refuses deeper, even when it is a hundred thousand levels', () => {
      expect(exceedsDepth(wrap(MAX_ANSWER_DEPTH), MAX_ANSWER_DEPTH)).toBe(false);
      expect(exceedsDepth(wrap(MAX_ANSWER_DEPTH + 1), MAX_ANSWER_DEPTH)).toBe(true);
      expect(exceedsDepth(wrap(100_000), MAX_ANSWER_DEPTH)).toBe(true);
      expect(exceedsDepth({ flat: [1, 2, { a: 'b' }], other: 'x' }, MAX_ANSWER_DEPTH)).toBe(false);
    });

    it('has a recorded issue code for the refusal', () => {
      expect(issueFor('OUTPUT_TOO_DEEP')).toEqual({
        path: '(root)',
        code: 'too_deep',
        detail: `nest objects at most ${MAX_ANSWER_DEPTH} levels deep`,
      });
    });
  });

  it('never repeats received values or issue messages', () => {
    const verdict = validateOutput(schema, { ok: true, echo: 'SECRET-VALUE-0123456789', letters: 'many' });
    expect(JSON.stringify(verdict)).not.toContain('SECRET-VALUE');
    expect(JSON.stringify(verdict)).not.toContain('many');
    expect(JSON.stringify(verdict)).not.toContain('received');
  });

  it('is bounded', () => {
    const wide = z.object(Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`f${index}`, z.string()])));
    const parsed = wide.safeParse({});
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const summary = summariseIssues(parsed.error.issues, {});
    expect(summary).toHaveLength(MAX_ISSUES + 1);
    expect(summary.at(-1)).toEqual({ path: '(root)', code: 'more', detail: '12 more' });
  });

  it('accepts a valid value and returns the parsed output', () => {
    expect(validateOutput(schema, { ok: true, echo: 'lamp', letters: 4 })).toEqual({
      valid: true,
      output: { ok: true, echo: 'lamp', letters: 4 },
      value: { ok: true, echo: 'lamp', letters: 4 },
    });
  });
});
