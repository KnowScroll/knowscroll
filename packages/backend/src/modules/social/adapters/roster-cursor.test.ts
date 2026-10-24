import { describe, it, expect } from 'vitest';
import { rosterCursorCodec } from './roster-cursor.js';
import type { RosterCertificate } from '../application/ports.js';
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const certificate: RosterCertificate = {
  accountId: id(1),
  universeId: id(2),
  epoch: 1,
  filter: 'incoming',
  revision: 7,
  limit: 20,
  after: id(3),
  started: 1000,
  until: 301000,
};
describe('roster keyset cursor (authored)', () => {
  it('round-trips within the existing opaque-token ceiling', () => {
    const codec = rosterCursorCodec(),
      token = codec.encode(certificate);
    expect(token.length).toBeLessThanOrEqual(256);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(codec.decode(token)).toEqual(certificate);
  });
  it('survives a restart and works on another instance: it holds no key', () => {
    const token = rosterCursorCodec().encode(certificate);
    expect(rosterCursorCodec().decode(token)).toEqual(certificate);
  });
  it('shows only values the caller already holds', () => {
    const text = Buffer.from(rosterCursorCodec().encode(certificate), 'base64url').toString('hex');
    // The caller's own scope, the public person ID it scanned to, and numbers: nothing about other people.
    expect(text).toContain(certificate.after.replaceAll('-', ''));
    expect(text).toContain(certificate.accountId.replaceAll('-', ''));
  });
  it('refuses truncated, extended, non-canonical and wrong-version tokens', () => {
    const codec = rosterCursorCodec(),
      token = codec.encode(certificate),
      bytes = Buffer.from(token, 'base64url');
    for (const bad of ['', token + '=', token.slice(1), token + 'A', 'x'.repeat(256)])
      expect(codec.decode(bad)).toBeUndefined();
    const otherVersion = Buffer.from(bytes);
    otherVersion[0] = 2;
    expect(codec.decode(otherVersion.toString('base64url'))).toBeUndefined();
    const otherFilter = Buffer.from(bytes);
    otherFilter[1] = 9;
    expect(codec.decode(otherFilter.toString('base64url'))).toBeUndefined();
  });
  it('refuses invalid bounds', () => {
    const codec = rosterCursorCodec();
    for (const invalid of [
      { ...certificate, until: certificate.started },
      { ...certificate, until: certificate.started + 300001 },
      { ...certificate, limit: 0 },
      { ...certificate, limit: 51 },
      { ...certificate, revision: 0 },
    ])
      expect(codec.decode(codec.encode(invalid))).toBeUndefined();
  });
});
