import { describe, it, expect } from 'vitest';
import { rosterCursorCodec } from './roster-cursor.js';
import type { RosterCertificate } from '../application/ports.js';
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const c: RosterCertificate = {
  accountId: id(1),
  universeId: id(2),
  epoch: 1,
  filter: 'incoming',
  revision: 7,
  limit: 20,
  after: id(3),
  ceiling: id(9),
  started: 1000,
  until: 301000,
};
describe('roster authenticated bounded certificate (authored)', () => {
  it('preserves exact private binding while remaining within the existing opaque-token ceiling', () => {
    const codec = rosterCursorCodec(),
      token = codec.encode(c);
    expect(token.length).toBeLessThanOrEqual(256);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(codec.decode(token)).toEqual(c);
    expect(rosterCursorCodec().decode(token)).toBeUndefined();
  });
  it('rejects every changed authenticated byte, truncated/noncanonical bytes and invalid bounds', () => {
    const codec = rosterCursorCodec(),
      token = codec.encode(c),
      bytes = Buffer.from(token, 'base64url');
    for (let i = 0; i < bytes.length; i++) {
      const changed = Buffer.from(bytes);
      changed[i] = changed[i]! ^ 1;
      expect(codec.decode(changed.toString('base64url'))).toBeUndefined();
    }
    for (const bad of ['', token + '=', token.slice(1), token + 'A', 'x'.repeat(256)])
      expect(codec.decode(bad)).toBeUndefined();
    for (const invalid of [
      { ...c, until: c.started },
      { ...c, until: c.started + 300001 },
      { ...c, after: c.ceiling },
      { ...c, limit: 0 },
    ])
      expect(codec.decode(codec.encode(invalid))).toBeUndefined();
  });
});
