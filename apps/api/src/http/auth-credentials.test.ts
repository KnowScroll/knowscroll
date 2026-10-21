import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import {
  apiSecurityHeaders,
  clearedSessionCookie,
  clientAddress,
  clientKey,
  cookieValue,
  credentialFrom,
  originGuard,
  sessionCookie,
  sessionCookieName,
} from './auth-credentials.js';

const token = `kss_${'a'.repeat(43)}`;

describe('session credentials', () => {
  it('prefers a bearer header over the cookie, and reads only the session cookie', () => {
    expect(credentialFrom({ authorization: `Bearer ${token}`, cookie: `ks_session=other` }, 'ks_session')).toEqual({
      kind: 'bearer',
      token,
    });
    expect(credentialFrom({ cookie: `theme=dark; ks_session=${token}; x=1` }, 'ks_session')).toEqual({
      kind: 'cookie',
      token,
    });
    expect(credentialFrom({ cookie: `__Host-ks_session=${token}` }, 'ks_session')).toBeUndefined();
    expect(credentialFrom({ authorization: 'Basic abc' }, 'ks_session')).toBeUndefined();
    expect(credentialFrom({ authorization: 'Bearer' }, 'ks_session')).toBeUndefined();
    expect(credentialFrom({}, 'ks_session')).toBeUndefined();
    expect(cookieValue('a=1;  b = 2 ', 'b')).toBe('2');
  });

  it('sets an HttpOnly, SameSite=Lax cookie, __Host- and Secure on HTTPS only', () => {
    const expires = new Date(Date.now() + 86_400_000);
    expect(sessionCookieName(true)).toBe('__Host-ks_session');
    expect(sessionCookie(token, expires, true)).toMatch(
      /^__Host-ks_session=kss_a{43}; Path=\/; Max-Age=86\d{3}; HttpOnly; SameSite=Lax; Secure$/,
    );
    expect(sessionCookie(token, expires, false)).toMatch(
      /^ks_session=kss_a{43}; Path=\/; Max-Age=86\d{3}; HttpOnly; SameSite=Lax$/,
    );
    expect(clearedSessionCookie(true)).toBe('__Host-ks_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
  });
});

describe('originGuard', () => {
  const publicOrigin = 'https://app.dev.knowscroll.space';
  function run(method: string, headers: Record<string, string>) {
    const events: string[] = [];
    const guard = originGuard({
      publicOrigin,
      cookieName: '__Host-ks_session',
      logEvent: (event: string) => {
        events.push(event);
      },
    });
    let status: number | undefined;
    let passed = false;
    const response = {
      status(code: number) {
        status = code;
        return this;
      },
      setHeader() {
        return this;
      },
      end() {
        return this;
      },
    } as unknown as Response;
    guard({ method, headers } as unknown as Request, response, () => (passed = true));
    return { passed, status, events };
  }
  const cookie = `__Host-ks_session=${token}`;

  it('lets safe methods, bearer requests and same-origin cookie requests through', () => {
    expect(run('GET', { cookie }).passed).toBe(true);
    expect(run('POST', { authorization: `Bearer ${token}` }).passed).toBe(true);
    expect(run('POST', {}).passed).toBe(true);
    expect(run('POST', { cookie, origin: publicOrigin }).passed).toBe(true);
  });

  it('refuses a foreign origin, and a cookie-authenticated change without an origin', () => {
    const refused: Record<string, string>[] = [
      { cookie, origin: 'https://attacker.invalid' },
      { cookie },
      { authorization: `Bearer ${token}`, origin: 'https://attacker.invalid' },
      { cookie, origin: 'null' },
    ];
    for (const headers of refused)
      expect(run('POST', headers)).toEqual({ passed: false, status: 403, events: ['identity.origin_refused'] });
    expect(run('DELETE', { cookie }).status).toBe(403);
  });
});

describe('clientAddress', () => {
  const request = (remoteAddress: string, forwarded?: string) =>
    ({
      socket: { remoteAddress },
      headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
    }) as unknown as Request;

  it('trusts X-Forwarded-For only from the loopback proxy, and takes its last entry', () => {
    expect(clientAddress(request('127.0.0.1', '203.0.113.9, 198.51.100.4'))).toBe('198.51.100.4');
    expect(clientAddress(request('127.0.0.1'))).toBe('127.0.0.1');
    expect(clientAddress(request('192.0.2.1', '203.0.113.9'))).toBe('192.0.2.1');
  });

  it('keys IPv6 clients by their /64 and IPv4-mapped clients by their IPv4 (review M2)', () => {
    expect(clientKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:DB8:0001:0002::9')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientKey('2001:db8:1:2:3:4:192.0.2.1')).toBe('2001:db8:1:2::/64');
    expect(clientKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(clientKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('::ffff:cb00:7109')).toBe('203.0.113.9');
    expect(clientKey('0:0:0:0:0:FFFF:CB00:7109')).toBe('203.0.113.9');
    expect(clientKey('::1')).toBe('::1');
    expect(clientKey('::')).toBe('::');
    expect(clientKey('::2')).toBe('0:0:0:0::/64');
    expect(clientKey('203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('unknown')).toBe('unknown');
    // Every address of one /64, however written, shares one budget.
    expect(clientAddress(request('127.0.0.1', '2001:db8:1:2::abcd'))).toBe(
      clientAddress(request('127.0.0.1', '2001:db8:1:2:1234:5678:9abc:def0')),
    );
    expect(clientAddress(request('127.0.0.1', '2001:db8:1:3::1'))).not.toBe(
      clientAddress(request('127.0.0.1', '2001:db8:1:2::1')),
    );
  });
});

describe('apiSecurityHeaders', () => {
  it('lets no API answer be framed, run anything or leak a referrer (review m7)', () => {
    const headers = new Map<string, string>();
    let nextCalled = false;
    apiSecurityHeaders()(
      {} as Request,
      { setHeader: (name: string, value: string) => headers.set(name, value) } as unknown as Response,
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(true);
    expect(Object.fromEntries(headers)).toEqual({
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
  });
});

import { isKeepPlaceRequest, requestContextMiddleware, currentRequest } from './request-context.js';
import { noStoreForAuth } from './auth-credentials.js';
describe('finite Keep pre-guard cache and serializer context', () => {
  it('tags exactly both POST paths including Express case/trailing-slash forms before guards', () => {
    for (const path of [
      '/v1/experience/keep/read',
      '/v1/experience/keep/place',
      '/V1/EXPERIENCE/KEEP/READ/',
      '/v1/experience/keep/place/',
    ]) {
      const request = { method: 'POST', path } as Request,
        headers: Record<string, string> = {};
      const response = {
        setHeader: (k: string, v: string) => {
          headers[k.toLowerCase()] = v;
        },
        once: () => undefined,
      } as unknown as Response;
      requestContextMiddleware(() => undefined)(request, response, () => {
        expect(currentRequest()?.problemFamily).toBe('keep-place');
        expect(headers['cache-control']).toBe('private, no-store');
      });
      noStoreForAuth()(request, response, () => undefined);
      expect(headers['cache-control']).toBe('private, no-store');
    }
    for (const request of [
      { method: 'GET', path: '/v1/experience/keep/read' },
      { method: 'POST', path: '/v1/experience/keep/read/extra' },
      { method: 'POST', path: '/v1/experience/keep/place-secret' },
      { method: 'POST', path: '/v1/saved' },
    ])
      expect(isKeepPlaceRequest(request)).toBe(false);
  });
});
