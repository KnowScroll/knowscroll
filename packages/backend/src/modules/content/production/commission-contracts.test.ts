import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  CUTROOM_COMMISSION_POLICY,
  lintCutroomCommission,
  prepareCutroomCommission,
  type CutroomCommissionScript,
} from './commission-contracts.js';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Authored fictional CI fixture, not reviewed evidence, owner approval or provider output. */
function script(): CutroomCommissionScript {
  const excerpt = 'A fictional source describes the imaginary blue object.';
  return {
    policyVersion: CUTROOM_COMMISSION_POLICY,
    scriptVersion: 'fictional.v1',
    title: 'Imaginary object',
    evidence: {
      version: 'cutroom-public-evidence.v1',
      reviewRef: 'fictional-review',
      sources: [
        {
          id: 'source1',
          url: 'https://example.invalid/evidence',
          retrievedAt: '2026-10-21T00:00:00Z',
          excerpt,
          excerptSha256: sha(excerpt),
        },
      ],
    },
    claims: [
      {
        id: 'claim1',
        role: 'main',
        statement: 'The imaginary object is blue.',
        support: [{ sourceId: 'source1', excerptSha256: sha(excerpt) }],
      },
    ],
    narration: Array.from({ length: 6 }, (_, index) => ({
      text: `Imaginary blue object number ${index + 1} appears.`,
      claimIds: ['claim1'],
    })),
    criteria: {
      mustShow: [{ id: 'show1', text: 'A blue object', type: 'presence', claimId: 'claim1' }],
      mustNotShow: [],
      depictionPolicyVersion: 'fictional.v1',
    },
    style: { id: 'fictional', version: 1, text: 'Clearly labelled fictional illustration' },
  };
}

function prepare(value: CutroomCommissionScript) {
  const lint = lintCutroomCommission(value);
  expect(lint.kind).toBe('valid');
  if (lint.kind !== 'valid') throw new Error('fixture invalid');
  return prepareCutroomCommission(
    value,
    { ref: 'fictional-approval-reference-only', scriptSha256: lint.scriptSha256 },
    { take: 1, worldId: 'ci', ceilingCents: 75 },
  );
}

describe('Cutroom commission prerequisite (authored CI fixtures only)', () => {
  it('freezes exact UTF-8 wire bytes/hash and sends labels, never internal evidence or claim text', async () => {
    const value = script();
    value.narration[0]!.text = 'An imaginary café object appears.';
    const prepared = prepare(value);
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') throw new Error('fixture refused');
    // Test-only use of the actual immutable upstream schema, not a duplicate of its contract.
    const wireUrl = new URL('../adapters/cutroom/wire-v1/request.ts', import.meta.url).href;
    const { SubmitRequest } = (await import(wireUrl)) as { SubmitRequest: z.ZodType };
    expect(SubmitRequest.safeParse(JSON.parse(prepared.requestUtf8)).success).toBe(true);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(prepared.requestId).toBe(`ks-reel-${prepared.scriptSha256.slice(0, 32)}-1`);
    expect(prepared.requestSha256).toBe(sha(prepared.requestUtf8));
    expect(prepared.byteLength).toBe(Buffer.byteLength(prepared.requestUtf8, 'utf8'));
    expect(prepared.byteLength).toBeGreaterThan(prepared.requestUtf8.length);
    expect(JSON.parse(prepared.requestUtf8)).toEqual({
      contractVersion: 1,
      requestId: prepared.requestId,
      worldId: 'ci',
      narration: value.narration,
      claims: [{ id: 'claim1', role: 'main' }],
      criteria: value.criteria,
      style: value.style,
      options: { until: 'video', budgetCents: 75 },
    });
    expect(prepared.requestUtf8).not.toContain('example.invalid');
    expect(prepared.requestUtf8).not.toContain(value.claims[0]!.statement);
    // Caller mutation cannot rewrite the once-compiled string.
    value.narration[0]!.text = 'A different object appears.';
    expect(prepare(value)).not.toEqual(prepared);
    expect(prepared.requestSha256).toBe(sha(prepared.requestUtf8));
  });

  it('binds evidence changes and exact whitespace to script identity even when wire labels are unchanged', () => {
    const original = script();
    const changed = structuredClone(original);
    changed.evidence.reviewRef = 'other-review';
    const first = prepare(original);
    const second = prepare(changed);
    expect(first.kind).toBe('prepared');
    expect(second.kind).toBe('prepared');
    if (first.kind !== 'prepared' || second.kind !== 'prepared') throw new Error('fixture refused');
    expect(first.scriptSha256).not.toBe(second.scriptSha256);
    expect(first.evidenceSha256).not.toBe(second.evidenceSha256);
    expect(first.requestId).not.toBe(second.requestId);
    expect(first.requestUtf8.replace(first.requestId, 'same-identity')).toBe(
      second.requestUtf8.replace(second.requestId, 'same-identity'),
    );
    changed.narration[0]!.text = ` ${changed.narration[0]!.text}`;
    expect(prepare(changed)).not.toEqual(second);
    expect(
      prepareCutroomCommission(
        changed,
        { ref: 'fictional', scriptSha256: first.scriptSha256 },
        { take: 1, worldId: 'ci', ceilingCents: 75 },
      ),
    ).toEqual({ kind: 'refused', code: 'approval_mismatch' });
  });

  it('refuses fewer than six units, hidden extra sentences, ending Sun and long estimated shots', () => {
    const short = script();
    short.narration.pop();
    expect(lintCutroomCommission(short)).toEqual({ kind: 'refused', code: 'structure' });
    const extra = script();
    extra.narration[0]!.text = 'The object appears. Another appears.';
    expect(lintCutroomCommission(extra)).toEqual({ kind: 'refused', code: 'sentence_boundary' });
    const sun = script();
    sun.narration[0]!.text = 'The object faces the Sun.”';
    expect(lintCutroomCommission(sun)).toEqual({ kind: 'refused', code: 'ending_sun' });
    const long = script();
    long.narration[0]!.text = `${'word '.repeat(23)}ends.`;
    expect(lintCutroomCommission(long)).toEqual({ kind: 'refused', code: 'shot_estimate' });
  });

  it('refuses altered evidence, foreign/unreferenced claims, duplicate identities and forbidden criterion types', () => {
    const altered = script();
    altered.evidence.sources[0]!.excerpt += ' Changed.';
    expect(lintCutroomCommission(altered)).toEqual({ kind: 'refused', code: 'evidence_mismatch' });
    const foreign = script();
    foreign.claims[0]!.support[0]!.sourceId = 'foreign';
    expect(lintCutroomCommission(foreign)).toEqual({ kind: 'refused', code: 'evidence_mismatch' });
    const unbound = script();
    unbound.narration[0]!.claimIds = ['foreign'];
    expect(lintCutroomCommission(unbound)).toEqual({ kind: 'refused', code: 'claim_binding' });
    const duplicate = script();
    duplicate.claims.push(structuredClone(duplicate.claims[0]!));
    expect(lintCutroomCommission(duplicate)).toEqual({ kind: 'refused', code: 'duplicate_identity' });
    const criterion = script();
    criterion.criteria.mustNotShow.push({ id: 'no-event', type: 'event', text: 'A hidden event' });
    expect(lintCutroomCommission(criterion)).toEqual({ kind: 'refused', code: 'criterion_binding' });
  });

  it('safely refuses malformed or credential-bearing source URLs without claiming source review', () => {
    for (const url of [
      'not-a-url',
      'https://',
      'https://user@example.invalid/evidence',
      'https://user:password@example.invalid/evidence',
      'https://:password@example.invalid/evidence',
    ]) {
      const value = script();
      value.evidence.sources[0]!.url = url;
      expect(lintCutroomCommission(value)).toEqual({ kind: 'refused', code: 'structure' });
    }
  });

  it('refuses aggregate evidence overflow and extra approval authority fields', () => {
    const overflow = script();
    const excerpt = 'x'.repeat(8000);
    overflow.evidence.sources = Array.from({ length: 8 }, (_, index) => ({
      id: `s${index}`,
      url: 'https://example.invalid/evidence',
      retrievedAt: '2026-10-21T00:00:00Z',
      excerpt,
      excerptSha256: sha(excerpt),
    }));
    // The bound is checked before hash/binding work, with no truncation.
    expect(lintCutroomCommission(overflow)).toEqual({ kind: 'refused', code: 'package_too_large' });
    const value = script();
    const lint = lintCutroomCommission(value);
    if (lint.kind !== 'valid') throw new Error('fixture invalid');
    expect(
      prepareCutroomCommission(
        value,
        { ref: 'fictional', scriptSha256: lint.scriptSha256, approved: true },
        { take: 1, worldId: 'ci', ceilingCents: 75 },
      ),
    ).toEqual({ kind: 'refused', code: 'approval_mismatch' });
    expect(
      prepareCutroomCommission(
        value,
        { ref: 'fictional', scriptSha256: lint.scriptSha256 },
        { take: 1, worldId: 'ci', ceilingCents: 76 },
      ),
    ).toEqual({ kind: 'refused', code: 'structure' });
  });
});
