import { describe, it, expect } from 'vitest';
import { inviteStatus, INVITE_LIFETIME_MS, type Invite } from './invites.js';
const start = Date.parse('2026-10-23T00:00:00Z');
const row: Invite = {
  accountId: 'fixture',
  linkId: 'fixture',
  tokenHash: 'fixture',
  revision: 1,
  createdAt: new Date(start).toISOString(),
  expiresAt: new Date(start + INVITE_LIFETIME_MS).toISOString(),
  revoked: false,
};
describe('initial invitation absolute policy (authored)', () => {
  it('has one seven-day absolute deadline without a sliding refresh', () => {
    expect(INVITE_LIFETIME_MS).toBe(604800000);
    expect(inviteStatus(row, start)).toBe('active');
    expect(inviteStatus(row, start + INVITE_LIFETIME_MS - 1)).toBe('active');
    expect(inviteStatus(row, start + INVITE_LIFETIME_MS)).toBe('expired');
    expect(inviteStatus({ ...row, revoked: true }, start)).toBe('revoked');
    expect(inviteStatus({ ...row, revoked: true }, start + INVITE_LIFETIME_MS)).toBe('revoked');
    expect(row.revision).toBe(1);
  });
});
