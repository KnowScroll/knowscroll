import { describe, expect, it } from 'vitest';
import {
  ReadPublicContentSharePreviewSchema,
  PublicContentSharePreviewSchema,
  publicContentSharesContract,
  publicContentSharePreviewForRead,
} from './public-content-shares.js';
import { ResolvedContentShareSchema } from './content-shares.js';
import { PublicContentShareProblemSchema, PublicContentShareProblemIssueSchema } from './social-problems.js';
import { problemCatalogue, problemTypeUri } from './problems.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const read = { version: 'content-share.v1', readId: id(1) };
const token = 'kssh_' + 'a'.repeat(43);
const target = { assetId: id(2), assetRevision: 1 };
const metadata = { kind: 'reel', title: 'Public card fixture', summary: 'Public metadata only', language: 'en' };
const available = { ...read, status: 'public_metadata', content: { status: 'available', target, metadata } };
const unavailable = { ...read, status: 'unavailable' };
const scope = { accountId: id(3), privacyEpoch: 2 };
const conversation = { conversationId: id(4), membershipId: id(5), membershipRevision: 1 };

describe('strict public-only metadata preview declarations (#242; no installed HTTP runtime)', () => {
  it('uses the exact token/read body outside private v1; cookies cannot select another output shape', () => {
    const request = { ...read, token };
    expect(ReadPublicContentSharePreviewSchema.parse(request)).toEqual(request);
    expect(PublicContentSharePreviewSchema.parse(available)).toEqual(available);
    expect(PublicContentSharePreviewSchema.parse(unavailable)).toEqual(unavailable);
    expect(publicContentSharesContract.preview['~orpc'].route).toMatchObject({ method: 'POST', path: '/s/preview' });
    const privateResult = { ...read, status: 'conversation', scope, conversation, content: available.content };
    expect(ResolvedContentShareSchema.parse(privateResult)).toEqual(privateResult);
    expect(PublicContentSharePreviewSchema.safeParse(privateResult).success).toBe(false);
    for (const extra of [
      { cookie: 'PRIVATE_COOKIE_CANARY' },
      { authorization: 'PRIVATE_AUTH_CANARY' },
      { scope },
      { conversation },
      { accountId: id(3) },
      { redirect: 'https://private.invalid/TOKEN_CANARY' },
    ]) {
      expect(ReadPublicContentSharePreviewSchema.safeParse({ ...request, ...extra }).success).toBe(false);
      expect(PublicContentSharePreviewSchema.safeParse({ ...available, ...extra }).success).toBe(false);
    }
    // This schema proves the closed projection; cookie-independent lookup/headers require
    // future real HTTP fixtures, never treating this declaration as installed authentication.
  });
  it('preserves the original exact target through explicit public correction without private grants', () => {
    const corrected = {
      ...available,
      content: { status: 'corrected', target, current: { ...target, assetRevision: 2, metadata } },
    };
    expect(PublicContentSharePreviewSchema.parse(corrected)).toEqual(corrected);
    expect(
      PublicContentSharePreviewSchema.safeParse({
        ...corrected,
        content: { ...corrected.content, current: { ...target, metadata } },
      }).success,
    ).toBe(false);
    expect(
      PublicContentSharePreviewSchema.safeParse({
        ...corrected,
        content: { ...corrected.content, current: { ...target, assetId: id(9), assetRevision: 2, metadata } },
      }).success,
    ).toBe(false);
    for (const extra of [
      { mediaUrl: 'https://private.invalid/SIGNED_CANARY' },
      { playbackGrant: id(6) },
      { exposureId: id(6) },
      { token },
      { sender: 'PRIVATE_NAME_CANARY' },
      { privateFrame: 'PRIVATE_FRAME_CANARY' },
    ]) {
      expect(PublicContentSharePreviewSchema.safeParse({ ...available, ...extra }).success).toBe(false);
      expect(
        PublicContentSharePreviewSchema.safeParse({
          ...available,
          content: { ...available.content, metadata: { ...metadata, ...extra } },
        }).success,
      ).toBe(false);
    }
    const wire = JSON.stringify(PublicContentSharePreviewSchema.parse(available));
    for (const field of [
      'token',
      'scope',
      'conversation',
      'cookie',
      'author',
      'mediaUrl',
      'playbackGrant',
      'exposureId',
    ])
      expect(wire).not.toContain(`"${field}"`);
    expect(wire).not.toContain('PRIVATE_');
  });
  it('makes all denial causes one neutral body without distinguishing existence or a private audience', () => {
    for (const cause of ['unknown', 'expired', 'revoked', 'blocked', 'conversation', 'withdrawn', 'private']) {
      expect(PublicContentSharePreviewSchema.parse(unavailable)).toEqual(unavailable);
      expect(PublicContentSharePreviewSchema.safeParse({ ...unavailable, reason: cause }).success).toBe(false);
      expect(PublicContentSharePreviewSchema.safeParse({ ...read, status: cause }).success).toBe(false);
    }
    for (const extra of [
      { exists: false },
      { title: metadata.title },
      { content: available.content },
      { scope },
      { conversation },
      { token },
    ])
      expect(PublicContentSharePreviewSchema.safeParse({ ...unavailable, ...extra }).success).toBe(false);
    // Consumer correlation is mandatory; a schema cannot compare a response with its request.
    expect(available.readId).toBe(read.readId);
    expect(PublicContentSharePreviewSchema.safeParse({ ...available, readId: id(8) }).success).toBe(true);
  });
  it('refuses accessors, own undefined, symbols, non-JSON prototypes and coercion before serialization', () => {
    let calls = 0;
    const getter = Object.defineProperty({ ...read }, 'token', {
      enumerable: true,
      get: () => {
        calls++;
        return token;
      },
    });
    expect(ReadPublicContentSharePreviewSchema.safeParse(getter).success).toBe(false);
    const nested = Object.defineProperty({ kind: 'reel', summary: metadata.summary, language: 'en' }, 'title', {
      enumerable: true,
      get: () => {
        calls++;
        return metadata.title;
      },
    });
    expect(
      PublicContentSharePreviewSchema.safeParse({ ...available, content: { ...available.content, metadata: nested } })
        .success,
    ).toBe(false);
    expect(calls).toBe(0);
    for (const value of [
      { ...read, token: undefined },
      { ...read, token, unknown: undefined },
      { ...read, token, [Symbol('SECRET')]: true },
      { ...read, token: 123 },
      Object.assign(Object.create({ token }) as object, read),
    ])
      expect(ReadPublicContentSharePreviewSchema.safeParse(value).success).toBe(false);
    expect(
      PublicContentSharePreviewSchema.safeParse({
        ...available,
        content: { ...available.content, target: { ...target, assetRevision: '1' } },
      }).success,
    ).toBe(false);
  });
  it('exposes only fixed public problem codes and path tokens, including fixed Origin refusal', () => {
    const errors = publicContentSharesContract.preview['~orpc'].errorMap;
    expect(Object.keys(errors)).toEqual([
      'INVALID_REQUEST',
      'ORIGIN_NOT_ALLOWED',
      'PAYLOAD_TOO_LARGE',
      'UNSUPPORTED_MEDIA_TYPE',
      'UNPROCESSABLE_REQUEST',
      'TOO_MANY_REQUESTS',
      'SERVICE_UNAVAILABLE',
      'INTERNAL',
    ]);
    for (const [code, definition] of Object.entries(errors)) {
      const problem = {
        type: problemTypeUri(code as keyof typeof problemCatalogue),
        title: definition.message,
        status: definition.status,
        code,
      };
      expect(PublicContentShareProblemSchema.parse(problem)).toEqual(problem);
      for (const extra of [
        { detail: token },
        { instance: '/s/' + token },
        { message: 'PRIVATE_MESSAGE_CANARY' },
        { token },
        { scope },
        { reason: 'blocked' },
      ])
        expect(PublicContentShareProblemSchema.safeParse({ ...problem, ...extra }).success).toBe(false);
    }
    const code = 'INVALID_REQUEST';
    const problem = {
      type: problemTypeUri(code),
      title: problemCatalogue[code].title,
      status: 400,
      code,
      issues: [{ path: ['unknown'], code: 'unrecognized_keys' }],
    };
    expect(PublicContentShareProblemSchema.parse(problem)).toEqual(problem);
    for (const path of [[token], ['PRIVATE_RECEIVED_KEY_CANARY'], ['scope'], ['accountId'], [0]])
      expect(
        PublicContentShareProblemSchema.safeParse({ ...problem, issues: [{ path, code: 'custom' }] }).success,
      ).toBe(false);
    expect(
      PublicContentShareProblemIssueSchema.safeParse({ path: ['token'], code: 'custom', value: token }).success,
    ).toBe(false);
    expect(PublicContentShareProblemSchema.safeParse({ ...problem, issues: undefined }).success).toBe(false);
    const wire = JSON.stringify(PublicContentShareProblemSchema.parse(problem));
    expect(wire).not.toContain(token);
    expect(wire).not.toContain('PRIVATE_');
  });
});

it('public reply correlation cannot accept another read or the private resolver union, regardless of caller privilege', () => {
  const request = { ...read, token };
  expect(publicContentSharePreviewForRead(request, available)).toEqual(available);
  expect(publicContentSharePreviewForRead(request, unavailable)).toEqual(unavailable);
  expect(publicContentSharePreviewForRead(request, { ...available, readId: id(8) })).toBeUndefined();
  expect(
    publicContentSharePreviewForRead(request, {
      ...read,
      status: 'conversation',
      scope,
      conversation,
      content: available.content,
    }),
  ).toBeUndefined();
  expect(publicContentSharePreviewForRead({ ...request, cookie: 'PRIVATE_COOKIE_CANARY' }, available)).toBeUndefined();
  const uppercase = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  expect(
    publicContentSharePreviewForRead(
      { ...request, readId: uppercase },
      { ...available, readId: uppercase.toLowerCase() },
    )?.readId,
  ).toBe(uppercase.toLowerCase());
  const definition = publicContentSharesContract.preview['~orpc'].errorMap.INVALID_REQUEST;
  expect(
    definition.data.safeParse({
      type: problemTypeUri('INVALID_REQUEST'),
      title: definition.message,
      status: 400,
      code: 'INVALID_REQUEST',
      issues: undefined,
    }).success,
  ).toBe(false);
});
