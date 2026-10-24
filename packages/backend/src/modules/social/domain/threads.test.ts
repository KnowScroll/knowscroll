import { describe, expect, it } from 'vitest';
import { canAnswerInvitation, canTakePart, invitable, isParticipant } from './threads.js';

const joined = { pending: false, left: false, stands: true };

describe('a member of a thread', () => {
  it('takes part once joined', () => {
    expect(canTakePart(joined)).toBe(true);
    expect(canAnswerInvitation(joined)).toBe(false);
  });
  it('can only answer while invited', () => {
    const invited = { ...joined, pending: true };
    expect(canTakePart(invited)).toBe(false);
    expect(canAnswerInvitation(invited)).toBe(true);
  });
  it('loses both when the ground gives way or they left', () => {
    for (const member of [
      { ...joined, stands: false },
      { ...joined, left: true },
      { pending: true, left: true, stands: true },
      { pending: true, left: false, stands: false },
    ]) {
      expect(canTakePart(member)).toBe(false);
      expect(canAnswerInvitation(member)).toBe(false);
    }
  });
  it('is listed while the place stands, invited or joined', () => {
    expect(isParticipant(joined)).toBe(true);
    expect(isParticipant({ ...joined, pending: true })).toBe(true);
    expect(isParticipant({ ...joined, stands: false })).toBe(false);
    expect(isParticipant({ ...joined, left: true })).toBe(false);
  });
});

describe('inviting a friend', () => {
  it('needs a standing friendship and an active account', () => {
    expect(invitable({ lineage: 'a', accountActive: true })).toBe(true);
    expect(invitable({ lineage: null, accountActive: true })).toBe(false);
    expect(invitable({ lineage: 'a', accountActive: false })).toBe(false);
  });
});
