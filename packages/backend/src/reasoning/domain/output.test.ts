import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MAX_ISSUES, extractJsonObject, summariseIssues, validateOutput } from './output.js';

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
        { path: 'echo', code: 'too_big', detail: 'maximum 5' },
        { path: 'letters', code: 'missing', detail: 'required; expected number' },
        { path: '(root)', code: 'unrecognized_keys', detail: 'unexpected keys' },
      ]),
    );
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
