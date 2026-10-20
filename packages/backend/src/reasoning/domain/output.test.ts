import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MAX_ANSWER_DEPTH,
  MAX_ISSUES,
  exceedsDepth,
  extractJsonObject,
  issueFor,
  summariseIssues,
  validateOutput,
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

describe('the validator summary', () => {
  const schema = z.object({ ok: z.literal(true), echo: z.string().max(5), letters: z.number().int() }).strict();

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
