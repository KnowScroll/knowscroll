import { describe, expect, it } from 'vitest';
import { canRemove, joinDecision, roomAcceptsPosts, statusAfter, type JoinFacts } from './membership.js';

const facts = (overrides: Partial<JoinFacts> = {}): JoinFacts => ({
  rule: 'open',
  status: 'open',
  earlier: 'never',
  hasProfile: true,
  invited: false,
  friendOfMember: false,
  ...overrides,
});

describe('joinDecision', () => {
  it('lets anyone with a profile into an open room', () => {
    expect(joinDecision(facts())).toEqual({ allowed: true });
  });

  it('keeps a removed person out, whatever the rule or an invitation says', () => {
    expect(joinDecision(facts({ earlier: 'removed', invited: true }))).toEqual({ allowed: false, reason: 'removed' });
  });

  it('lets a person who left come back', () => {
    expect(joinDecision(facts({ earlier: 'left' }))).toEqual({ allowed: true });
  });

  it('takes nobody into a paused or closed room', () => {
    expect(joinDecision(facts({ status: 'paused' }))).toEqual({ allowed: false, reason: 'paused' });
    expect(joinDecision(facts({ status: 'closed', invited: true }))).toEqual({ allowed: false, reason: 'closed' });
  });

  it('asks an invite-only room for an invitation and a friends-of-members room for a friend or an invitation', () => {
    expect(joinDecision(facts({ rule: 'invite_only', friendOfMember: true }))).toEqual({
      allowed: false,
      reason: 'invite_only',
    });
    expect(joinDecision(facts({ rule: 'invite_only', invited: true }))).toEqual({ allowed: true });
    expect(joinDecision(facts({ rule: 'friends_of_members' }))).toEqual({
      allowed: false,
      reason: 'friend_of_member_needed',
    });
    expect(joinDecision(facts({ rule: 'friends_of_members', friendOfMember: true }))).toEqual({ allowed: true });
    expect(joinDecision(facts({ rule: 'friends_of_members', invited: true }))).toEqual({ allowed: true });
  });

  it('names the way in before it names the missing profile', () => {
    expect(joinDecision(facts({ hasProfile: false, rule: 'invite_only' }))).toEqual({
      allowed: false,
      reason: 'invite_only',
    });
    expect(joinDecision(facts({ hasProfile: false }))).toEqual({ allowed: false, reason: 'profile_needed' });
  });
});

describe('room status', () => {
  it('lets only an open room take posts', () => {
    expect(roomAcceptsPosts('open')).toBe(true);
    expect(roomAcceptsPosts('paused')).toBe(false);
    expect(roomAcceptsPosts('closed')).toBe(false);
  });

  it('moves between open and paused and never reopens a closed room', () => {
    expect(statusAfter('pause', 'open')).toBe('paused');
    expect(statusAfter('pause', 'paused')).toBeUndefined();
    expect(statusAfter('resume', 'paused')).toBe('open');
    expect(statusAfter('resume', 'open')).toBeUndefined();
    expect(statusAfter('resume', 'closed')).toBeUndefined();
    expect(statusAfter('pause', 'closed')).toBeUndefined();
  });
});

describe('canRemove', () => {
  it('removes ordinary members only, never oneself or another moderator', () => {
    const actor = { accountId: 'a' };
    expect(canRemove(actor, { accountId: 'b', role: 'member' })).toBe(true);
    expect(canRemove(actor, { accountId: 'b', role: 'moderator' })).toBe(false);
    expect(canRemove(actor, { accountId: 'a', role: 'member' })).toBe(false);
  });
});
