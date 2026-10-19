import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import {
  clearedSessionCookie,
  clientAddress,
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
});
