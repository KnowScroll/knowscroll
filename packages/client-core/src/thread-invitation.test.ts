import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { problemDetails } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { answerThreadInvitation, composerAddressees, invitationCardView } from './thread-inbox';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const thread = { threadId: id(1), membershipId: id(2), membershipRevision: 1 };
const asha = { kind: 'person' as const, personId: id(10), handle: 'ci.asha', displayName: 'Asha' };

const invited = (patch: Record<string, unknown> = {}) =>
  ({
    thread,
    root: {
      status: 'available',
      target: { assetId: id(500), assetRevision: 1 },
      metadata: { kind: 'reel', title: 'The edge', summary: '', language: 'en' },
    },
    state: 'invited',
    ownPersonId: id(99),
    people: [asha],
    latestMessageSequence: 0,
    own: { readThroughSequence: 0, muted: false },
    lastActivityAt: '2026-10-24T08:00:00.000Z',
    ...patch,
  }) as Parameters<typeof invitationCardView>[0];

describe('the thread invitation card in Talk', () => {
  it('names who started the thread and what it is about, and nobody else', () => {
    expect(invitationCardView(invited({ name: 'Black holes' }))).toEqual({
      heading: 'Asha started a thread · Black holes',
      detail: 'with you · Reel',
      kind: 'reel',
    });
  });

  it('falls back to the content title, and says only who asked when the content is gone', () => {
    expect(invitationCardView(invited()).heading).toBe('Asha started a thread · The edge');
    const gone = invitationCardView(
      invited({ root: { status: 'unavailable', target: { assetId: id(500), assetRevision: 1 } } }),
    );
    expect(gone).toEqual({ heading: 'Asha started a thread', detail: 'with you', kind: undefined });
  });
});

describe('answering an invitation from Talk', () => {
  const scopeOf = (respond: (input: Record<string, unknown>) => Promise<unknown>) =>
    ({ active: true, api: { threads: { respond } } }) as unknown as AccountScope;

  it('sends one respond command with the chosen answer and the caller’s own reference', async () => {
    const sent: Record<string, unknown>[] = [];
    const scope = scopeOf((input) => {
      sent.push(input);
      return Promise.resolve({});
    });
    expect(await answerThreadInvitation(scope, thread, 'decline', id(7))).toBe('done');
    expect(sent).toEqual([{ version: 'content-thread.v1', commandId: id(7), thread, response: 'decline' }]);
  });

  it('says unavailable when the invitation changed, and offline when nothing answered', async () => {
    const refused = new ORPCError('SHARING_UNAVAILABLE', { status: 403, data: problemDetails('SHARING_UNAVAILABLE') });
    expect(
      await answerThreadInvitation(
        scopeOf(() => Promise.reject(refused)),
        thread,
        'join',
        id(7),
      ),
    ).toBe('unavailable');
    expect(
      await answerThreadInvitation(
        scopeOf(() => Promise.reject(new Error('network'))),
        thread,
        'join',
        id(7),
      ),
    ).toBe('offline');
  });
});

describe('who the thread composer addresses', () => {
  const named = (displayName: string, handle: string) => ({ displayName, handle });
  it('uses first words, a last initial when two share one, and the handle when that is shared too', () => {
    expect(composerAddressees([named('Ravi Kumar', 'ci.ravi'), named('Meera', 'ci.meera')])).toBe('Ravi and Meera');
    expect(composerAddressees([named('J222 Alpha', 'ci.j222a'), named('J222 Beta', 'ci.j222b')])).toBe(
      'J222 A. and J222 B.',
    );
    expect(composerAddressees([named('J222', 'ci.j222a'), named('J222 Test', 'ci.j222b')])).toBe('J222 and J222 T.');
    expect(composerAddressees([named('J222 Test', 'ci.j222a'), named('J222 Tester', 'ci.j222b')])).toBe(
      '@ci.j222a and @ci.j222b',
    );
    expect(composerAddressees([named('Asha', 'a'), named('Ravi', 'r'), named('Meera', 'm')])).toBe(
      'Asha, Ravi and Meera',
    );
    expect(composerAddressees([])).toBe('everyone');
  });
});
