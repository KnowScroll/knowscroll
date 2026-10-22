import { describe, expect, it } from 'vitest';
import {
  apiContract,
  ListSavedRequestSchema,
  ListSavedResponseSchema,
  LegacyListSavedResponseSchema,
  SavedPageRequestSchema,
  SavedPageResponseSchema,
  SavedPageCursorSchema,
  SavedListProblemSchema,
  SavedListProblemIssueSchema,
  problemCatalogue,
  problemTypeUri,
} from './index.js';

// Synthetic wire fixtures only: syntax proves no authority, token integrity or database ordering.
const id = (n: number) => `019b7dc2-83fe-7000-8000-${String(n).padStart(12, '0')}`;
const cursor = `ksp1_${'a'.repeat(80)}`;
const request = { pagination: 'saved-page.v1', filter: 'all', limit: '20' };
const item = {
  assetId: id(1),
  assetRevision: 2,
  savedEntryId: id(2),
  savedAt: '2026-10-22T10:00:00.123456Z',
  kind: 'reel',
  availability: 'available',
  metadata: { kind: 'reel', title: 'Synthetic Reel', summary: 'Fixture only.', language: 'en' },
};
const page = {
  pagination: 'saved-page.v1',
  consistency: 'live',
  scope: { accountId: id(3), privacyEpoch: 4 },
  filter: 'all',
  limit: 20,
  revision: 10,
  items: [item],
  continuation: { status: 'more', cursor },
};
const problem = (code: keyof typeof problemCatalogue) => ({
  type: problemTypeUri(code),
  code,
  ...problemCatalogue[code],
});

describe('saved-page.v1 compatible GET declaration', () => {
  it('retains legacy empty/limit requests, ID-only replies and unrelated unknown-field stripping', () => {
    expect(ListSavedRequestSchema.parse({})).toEqual({});
    expect(ListSavedRequestSchema.parse({ limit: '100', future: true })).toEqual({ limit: '100' });
    const legacy = { revision: 0, items: [{ assetId: id(1), assetRevision: 2, savedAt: item.savedAt }] };
    expect(ListSavedResponseSchema.parse({ ...legacy, future: true })).toEqual(legacy);
    expect(LegacyListSavedResponseSchema.parse(legacy)).toEqual(legacy);
    // A paged caller must demand the new branch. Old-server success cannot pretend to page.
    expect(SavedPageResponseSchema.safeParse(legacy).success).toBe(false);
  });

  it('requires explicit bounded string query selection, without defaults or coercion', () => {
    for (const filter of ['all', 'reel', 'scroll'])
      for (const limit of ['1', '20', '50']) {
        const value = { ...request, filter, limit, cursor };
        expect(SavedPageRequestSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
        expect(ListSavedRequestSchema.parse(value)).toEqual(value);
      }
    for (const limit of [undefined, 20, '0', '01', '51', '100', '1.5', '-1', '', ' 20', Infinity])
      expect(ListSavedRequestSchema.safeParse({ ...request, limit }).success).toBe(false);
    for (const filter of [undefined, 'requested', 'peer', '', 1])
      expect(ListSavedRequestSchema.safeParse({ ...request, filter }).success).toBe(false);
    for (const extra of [{ scope: page.scope }, { offset: 20 }, { afterAssetId: id(1) }, { snapshotRevision: 10 }])
      expect(ListSavedRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
  });

  it('never downgrades malformed, mixed or missing-discriminator paging into the legacy first page', () => {
    for (const pagination of ['saved-page.v2', null, true, '', undefined])
      expect(ListSavedRequestSchema.safeParse({ ...request, pagination, cursor }).success).toBe(false);
    for (const mixed of [{ cursor }, { filter: 'all' }, { limit: '100', cursor }, { pagination: 'saved-page.v1' }])
      expect(ListSavedRequestSchema.safeParse(mixed).success).toBe(false);
    for (const change of [
      { pagination: undefined },
      { pagination: 'saved-page.v2' },
      { scope: undefined },
      { continuation: undefined },
      { consistency: 'snapshot' },
      { limit: '20' },
    ])
      expect(ListSavedResponseSchema.safeParse({ ...page, ...change }).success).toBe(false);
  });

  it('bounds only opaque cursor syntax; private claims and decoder formats are absent from the wire', () => {
    for (const n of [43, 1024]) expect(SavedPageCursorSchema.parse(`ksp1_${'a'.repeat(n)}`)).toHaveLength(n + 5);
    for (const invalid of [
      '',
      'a'.repeat(80),
      `ksp1_${'a'.repeat(42)}`,
      `ksp1_${'a'.repeat(1025)}`,
      `ksp1_${'a'.repeat(43)}=`,
      id(1),
      5,
      { after: id(1) },
    ])
      expect(SavedPageCursorSchema.safeParse(invalid).success).toBe(false);
    // This token is deliberately not authentic. A parser cannot perform the future codec checks.
    expect(SavedPageRequestSchema.parse({ ...request, cursor })).toEqual({ ...request, cursor });
  });

  it('declares exact membership references and current available/corrected/withdrawn rows', () => {
    expect(SavedPageResponseSchema.parse(JSON.parse(JSON.stringify(page)))).toEqual(page);
    const priorCursor = `ksp1_${'b'.repeat(80)}`;
    const continued = { ...page, requestCursor: priorCursor };
    expect(SavedPageResponseSchema.parse(continued)).toEqual(continued);
    // Equality to the initiating request is a receiving-adapter obligation; parser preserves it.
    expect(SavedPageResponseSchema.parse(continued).requestCursor).toBe(priorCursor);
    const corrected = { ...item, availability: 'corrected', currentAssetRevision: 1 };
    expect(SavedPageResponseSchema.parse({ ...page, items: [corrected] }).items).toEqual([corrected]);
    const withdrawn = { ...item, availability: 'withdrawn', metadata: undefined };
    expect(SavedPageResponseSchema.parse({ ...page, filter: 'reel', items: [withdrawn] }).items).toHaveLength(1);
    for (const change of [
      { savedEntryId: undefined },
      { assetRevision: 0 },
      { kind: 'requested' },
      { availability: undefined },
      { metadata: { ...item.metadata, kind: 'scroll' } },
      { availability: 'withdrawn' },
      { availability: 'corrected', currentAssetRevision: 2 },
      { currentAssetRevision: 3 },
      { savedAt: 5 },
      { placeRevision: 2 },
      { peerPosition: 20 },
    ])
      expect(SavedPageResponseSchema.safeParse({ ...page, items: [{ ...item, ...change }] }).success).toBe(false);
  });

  it('rejects scope, filter, budget, duplicate membership and private-state violations', () => {
    for (const change of [
      { requestCursor: cursor },
      { requestCursor: 'not-a-cursor' },
      { scope: { ...page.scope, privacyEpoch: 0 } },
      { scope: { ...page.scope, universeId: id(4) } },
      { filter: 'scroll' },
      { limit: 0 },
      { limit: 51 },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { total: 101 },
      { snapshotRevision: 10 },
      { position: { kind: 'reel', positionMs: 10 } },
      { continuation: { status: 'end', cursor } },
      { continuation: { status: 'more' } },
      { items: [item, item] },
      { items: [item, { ...item, savedEntryId: id(5) }] },
      { items: [item, { ...item, assetId: id(5) }] },
    ])
      expect(SavedPageResponseSchema.safeParse({ ...page, ...change }).success).toBe(false);
    const items = Array.from({ length: 21 }, (_, i) => ({ ...item, assetId: id(10 + i), savedEntryId: id(100 + i) }));
    expect(SavedPageResponseSchema.safeParse({ ...page, items }).success).toBe(false);
    expect(SavedPageResponseSchema.parse({ ...page, limit: 50, items }).items).toHaveLength(21);
    expect(SavedPageResponseSchema.safeParse({ ...page, limit: 50, items: Array(51).fill(item) }).success).toBe(false);
  });

  it('permits live watermark changes and empty continuation windows, without inventing a snapshot or count', () => {
    for (const revision of [0, 10, 25])
      expect(SavedPageResponseSchema.parse({ ...page, revision, items: [] }).continuation.status).toBe('more');
    expect(SavedPageResponseSchema.parse({ ...page, items: [], continuation: { status: 'end' } }).items).toEqual([]);
    // Wire schema preserves row order even within the same displayed millisecond. Database
    // full-precision ordering, removed anchors, resave races and >100 traversal need real PG tests.
    const tied = { ...item, assetId: id(4), savedEntryId: id(5), savedAt: '2026-10-22T10:00:00.123455Z' };
    expect(SavedPageResponseSchema.parse({ ...page, items: [item, tied] }).items).toEqual([item, tied]);
  });

  it('has a closed static problem family with uniform cursor unavailability and no private extensions', () => {
    const errors = apiContract.experience.listSaved['~orpc'].errorMap;
    expect(Object.keys(errors)).toHaveLength(14);
    for (const code of Object.keys(errors) as (keyof typeof errors)[])
      expect(SavedListProblemSchema.parse(problem(code))).toEqual(problem(code));
    expect(problemCatalogue.SAVED_CURSOR_UNAVAILABLE.status).toBe(409);
    for (const code of ['KEEP_ENTRY_UNAVAILABLE', 'KEEP_PLACE_REVISION_STALE', 'ASSET_NOT_FOUND'] as const)
      expect(SavedListProblemSchema.safeParse(problem(code)).success).toBe(false);
    for (const extra of [
      { cursor },
      { detail: 'decoder failure' },
      { instance: '/v1/saved?cursor=private' },
      { currentEpoch: 4 },
      { total: 101 },
    ])
      expect(SavedListProblemSchema.safeParse({ ...problem('SAVED_CURSOR_UNAVAILABLE'), ...extra }).success).toBe(
        false,
      );
    for (const path of [['cursor', cursor], ['scope'], [0], ['savedAt'], ['unknown', id(1)]])
      expect(SavedListProblemIssueSchema.safeParse({ path, code: 'invalid_format' }).success).toBe(false);
    expect(SavedListProblemIssueSchema.parse({ path: ['cursor'], code: 'invalid_format' })).toEqual({
      path: ['cursor'],
      code: 'invalid_format',
    });
    expect(
      SavedListProblemSchema.safeParse({
        ...problem('INVALID_REQUEST'),
        issues: Array(33).fill({ path: [], code: 'custom' }),
      }).success,
    ).toBe(false);
  });

  it('keeps one GET route; declarations install no backend paging, codec or filter', () => {
    expect(apiContract.experience.listSaved['~orpc'].route).toMatchObject({
      method: 'GET',
      path: '/v1/saved',
      successStatus: 200,
    });
    expect(apiContract.experience.listSaved['~orpc'].inputSchema).toBe(ListSavedRequestSchema);
    expect(apiContract.experience.listSaved['~orpc'].outputSchema).toBe(ListSavedResponseSchema);
  });
});
