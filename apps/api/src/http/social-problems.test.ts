import { describe, expect, it } from 'vitest';
import { ORPCError } from '@orpc/server';
import type { Request, Response } from 'express';
import { problemDetails, SocialProblemSchema } from '@knowscroll/contracts';
import { socialDetails, socialIssues } from './social-problems.js';
import { currentRequest, requestContextMiddleware } from './request-context.js';
import { keepProblem, problemFromOrpcError, sendProblem } from './problems.js';

const canary = 'PRIVATE-SOCIAL-RECEIVED-KEY-CANARY';
describe('closed Social problem projection (authored data, no installed-runtime claim)', () => {
  it('discards details, instance and private source fields from every admitted fixed family code', () => {
    for (const code of [
      'INVALID_REQUEST',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'ORIGIN_NOT_ALLOWED',
      'UNIVERSE_UNAVAILABLE',
      'SHARING_UNAVAILABLE',
      'SHARING_REVISION_STALE',
      'CONFLICT',
      'PRIVACY_EPOCH_CHANGED',
      'SCOPE_MISMATCH',
      'COMMAND_KEY_REUSED',
      'PAYLOAD_TOO_LARGE',
      'UNSUPPORTED_MEDIA_TYPE',
      'UNPROCESSABLE_REQUEST',
      'TOO_MANY_REQUESTS',
      'SERVICE_UNAVAILABLE',
      'INTERNAL',
    ] as const) {
      const value = socialDetails({ ...problemDetails(code), detail: canary, instance: canary });
      expect(value).toEqual(problemDetails(code));
      expect(SocialProblemSchema.parse(value)).toEqual(value);
      expect(JSON.stringify(value)).not.toContain(canary);
    }
    expect(socialDetails({ ...problemDetails('KEEP_PLACE_REVISION_STALE'), detail: canary })).toEqual(
      problemDetails('INTERNAL'),
    );
  });
  it('masks unknown/numeric/object path segments and bounds issue arrays and paths', () => {
    const issue = {
      path: ['version', 'handle', 2, { key: canary }, canary, 'target', 'peerPersonId', 'token', 'commandId'],
      code: canary,
      received: canary,
      message: canary,
    };
    const value = socialDetails({ ...problemDetails('INVALID_REQUEST'), issues: Array(40).fill(issue) });
    expect(value.issues).toHaveLength(32);
    expect(value.issues?.[0]).toEqual({
      path: ['version', 'unknown', 'unknown', 'unknown', 'unknown', 'target', 'peerPersonId', 'token'],
      code: 'custom',
    });
    expect(JSON.stringify(value)).not.toContain(canary);
    expect(socialIssues(null)).toEqual([]);
    expect(socialIssues([null, 2, 'invalid'])).toEqual(Array(3).fill({ path: [], code: 'custom' }));
  });
});

function inRequest<T>(method: string, path: string, work: (headers: Map<string, string>) => T): T {
  const headers = new Map<string, string>();
  let result: T | undefined;
  requestContextMiddleware(() => undefined)(
    { method, path } as Request,
    {
      setHeader: (key: string, value: string) => headers.set(key, value),
      once: () => undefined,
    } as unknown as Response,
    () => {
      result = work(headers);
    },
  );
  return result as T;
}

describe('mounted Social serialization boundary before authentication and parsing', () => {
  it('selects only the mounted methods and paths, including Express case/trailing slash aliases', () => {
    const mounted = [
      ['GET', '/v1/social/profile'],
      ['GET', '/v1/social/invites'],
      ['GET', '/v1/social/read-receipts'],
      ['POST', '/v1/social/read-receipts'],
      ...[
        'profile',
        'friends/page',
        'requests/page',
        'invites/resolve',
        'invites/create',
        'invites/revoke',
        'people/lookup',
        'pairs/read',
        'friends/request',
        'friends/accept',
        'friends/decline',
        'friends/cancel',
        'friends/remove',
        'friends/block',
        'friends/unblock',
      ].map((path) => ['POST', `/v1/social/${path}`]),
      ...[
        'conversations/start',
        'conversations/inbox',
        'conversations/read',
        'conversations/history',
        'conversations/changes',
        'conversations/send',
        'conversations/send/read',
        'conversations/react',
        'conversations/mark-read',
        'conversations/mute',
        'conversations/leave',
        'content-shares/create',
        'content-shares/revoke',
        'content-shares/read',
        'content-shares/list',
        'content-shares/resolve',
      ].map((path) => ['POST', `/v1/social/${path}`]),
      ['POST', '/s/preview'],
    ];
    for (const [method, path] of mounted) {
      for (const alias of [path!, `${path!.toUpperCase()}/`])
        inRequest(method!, alias, (headers) => {
          expect(currentRequest()?.problemFamily).toBe('social');
          expect(headers.get('cache-control')).toBe('private, no-store');
        });
    }
    for (const [method, path] of [
      ['GET', '/v1/social/friends/request'],
      ['PUT', '/v1/social/profile'],
      ['POST', '/v1/social/profile/extra'],
      ['GET', '/v1/social/friends'],
      ['POST', '/v1/social/invitations/redeem'],
      ['GET', '/v1/social/conversations/send'],
      ['POST', '/v1/social/conversations/typing'],
      ['POST', '/v1/social/conversations/send/extra'],
      ['GET', '/s/preview'],
      ['GET', '/v1/shares/public-token'],
    ])
      inRequest(method!, path!, (headers) => {
        expect(currentRequest()?.problemFamily).toBeUndefined();
        expect(headers.has('cache-control')).toBe(false);
      });
  });

  it('masks parser errors centrally and cannot carry a trusted Keep CAS extension across the family boundary', () => {
    inRequest('POST', '/v1/social/friends/request', () => {
      const details = problemFromOrpcError(
        new ORPCError('BAD_REQUEST', {
          data: { issues: [{ path: [{ key: canary }, 'token', 42], code: 'unrecognized_keys', input: canary }] },
        }),
        () => undefined,
      );
      expect(details).toEqual({
        ...problemDetails('INVALID_REQUEST'),
        issues: [{ path: ['unknown', 'token', 'unknown'], code: 'unrecognized_keys' }],
      });
      expect(currentRequest()?.problemCode).toBe('INVALID_REQUEST');
      const foreign = problemFromOrpcError(
        keepProblem({
          code: 'KEEP_PLACE_REVISION_STALE',
          currentPlaceRevision: 9,
        }),
        () => undefined,
      );
      expect(foreign).toEqual(problemDetails('INTERNAL'));
      expect(foreign).not.toHaveProperty('currentPlaceRevision');
    });
  });

  it('closes pre-handler errors on the wire and records only their projected family code', () => {
    inRequest('POST', '/v1/social/people/lookup', (headers) => {
      let body: string | undefined;
      const response = {
        status: (status: number) => {
          expect(status).toBe(400);
          return response;
        },
        setHeader: (name: string, value: string) => {
          headers.set(name, value);
          return response;
        },
        end: (value: string) => {
          body = value;
        },
      } as unknown as Response;
      sendProblem(response, { ...problemDetails('INVALID_REQUEST'), detail: canary, instance: canary });
      expect(JSON.parse(body!)).toEqual(problemDetails('INVALID_REQUEST'));
      expect(body).not.toContain(canary);
      expect(headers.get('cache-control')).toBe('private, no-store');
      expect(headers.get('content-type')).toBe('application/problem+json');
      expect(currentRequest()?.problemCode).toBe('INVALID_REQUEST');
    });
  });
});
