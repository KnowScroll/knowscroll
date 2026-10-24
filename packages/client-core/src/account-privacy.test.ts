import { ORPCError } from '@orpc/client';
import { describe, expect, it, vi } from 'vitest';
import {
  DELETE_ACCOUNT_CONFIRMATION,
  problemDetails,
  type ProblemCode,
  type SessionSummary,
} from '@knowscroll/contracts';
import type { ApiClient } from './api-client';
import { createAccountSessionsSession } from './account-sessions';
import { requestAccountDeletion } from './account-deletion';
import { createDataExportsSession } from './data-exports';

const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const problem = (code: ProblemCode) => {
  const details = problemDetails(code);
  return new ORPCError(code, { status: details.status, message: details.title, data: details });
};
const session = (n: number, current = false): SessionSummary => ({
  id: id(n),
  client: 'web',
  deviceLabel: `Device ${String(n)}`,
  signedInAt: '2026-10-24T09:00:00.000Z',
  lastUsedAt: '2026-10-24T10:00:00.000Z',
  current,
});
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 3, email: 'person@example.test' };

describe('the sessions of Account', () => {
  function fixture(initial: SessionSummary[]) {
    let sessions = initial;
    const calls: string[] = [];
    const fail: { next?: ORPCError<string, unknown> | Error } = {};
    const owner = {
      active: true,
      api: {
        account: {
          sessions: () => Promise.resolve({ sessions }),
          endSession: (input: { sessionId: string }) => {
            calls.push(`end ${input.sessionId}`);
            if (fail.next) return Promise.reject(fail.next);
            sessions = sessions.filter((entry) => entry.id !== input.sessionId);
            return Promise.resolve({ status: 'ended' as const });
          },
          endOtherSessions: () => {
            calls.push('others');
            if (fail.next) return Promise.reject(fail.next);
            sessions = sessions.filter((entry) => entry.current);
            return Promise.resolve({ revoked: 1 });
          },
        },
      } as unknown as Pick<ApiClient, 'account'>,
    };
    return { owner, calls, fail, set: (next: SessionSummary[]) => (sessions = next) };
  }

  it('loads the list, and rereads it after a sign-out', async () => {
    const { owner, calls } = fixture([session(10, true), session(11)]);
    const use = createAccountSessionsSession(owner);
    expect(use.getState().status).toBe('loading');
    await use.refresh();
    expect(use.getState()).toMatchObject({ status: 'ready', failed: false });
    expect(use.getState().sessions.map((entry) => entry.id)).toEqual([id(10), id(11)]);
    await use.end(id(11));
    expect(calls).toEqual([`end ${id(11)}`]);
    expect(use.getState().sessions.map((entry) => entry.id)).toEqual([id(10)]);
    expect(use.getState().ending).toBeUndefined();
  });

  it('signs every other session out', async () => {
    const { owner } = fixture([session(10, true), session(11), session(12)]);
    const use = createAccountSessionsSession(owner);
    await use.refresh();
    await use.endOthers();
    expect(use.getState().sessions.map((entry) => entry.id)).toEqual([id(10)]);
  });

  it('keeps the list and says so when a sign-out fails, but treats an already-gone session as done', async () => {
    const { owner, fail, set } = fixture([session(10, true), session(11)]);
    const use = createAccountSessionsSession(owner);
    await use.refresh();
    fail.next = new Error('offline');
    await use.end(id(11));
    expect(use.getState()).toMatchObject({ failed: true, ending: undefined });
    expect(use.getState().sessions).toHaveLength(2);
    fail.next = problem('NOT_FOUND');
    set([session(10, true)]);
    await use.end(id(11));
    expect(use.getState().failed).toBe(false);
    expect(use.getState().sessions).toHaveLength(1);
  });

  it('is unavailable until the first read works, and keeps the last list if a later read fails', async () => {
    const down = createAccountSessionsSession({
      active: true,
      api: { account: { sessions: () => Promise.reject(new Error('offline')) } } as unknown as Pick<
        ApiClient,
        'account'
      >,
    });
    await down.refresh();
    expect(down.getState().status).toBe('unavailable');
    const { owner } = fixture([session(10, true)]);
    const use = createAccountSessionsSession(owner);
    await use.refresh();
    owner.api.account.sessions = () => Promise.reject(new Error('offline'));
    await use.refresh();
    expect(use.getState()).toMatchObject({ status: 'ready' });
    expect(use.getState().sessions).toHaveLength(1);
  });

  it('stops notifying once its scope has ended', async () => {
    const { owner } = fixture([session(10, true)]);
    const live = { ...owner, active: true };
    const use = createAccountSessionsSession(live);
    const listener = vi.fn();
    use.subscribe(listener);
    live.active = false;
    await use.refresh();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('the exports of P02', () => {
  function fixture() {
    let exports: { id: string; state: 'preparing' | 'ready'; requestedAt: string; expiresAt: string | null }[] = [];
    const requested: string[] = [];
    const fail: { request?: boolean; link?: ORPCError<string, unknown> | Error } = {};
    const owner = {
      active: true,
      api: {
        account: {
          exports: {
            list: () => Promise.resolve({ exports }),
            request: (input: { exportId: string }) => {
              if (fail.request) return Promise.reject(new Error('offline'));
              requested.push(input.exportId);
              exports = [
                { id: input.exportId, state: 'preparing', requestedAt: '2026-10-24T10:00:00.000Z', expiresAt: null },
              ];
              return Promise.resolve({ export: exports[0] });
            },
            link: () =>
              fail.link
                ? Promise.reject(fail.link)
                : Promise.resolve({ path: '/auth/exports/kse_secret', expiresAt: '2026-10-24T10:01:00.000Z' }),
          },
        },
      } as unknown as Pick<ApiClient, 'account'>,
    };
    return { owner, requested, fail, setExports: (next: typeof exports) => (exports = next) };
  }

  it('asks with a fresh id each time and shows the receipt', async () => {
    const { owner, requested } = fixture();
    let next = 0;
    const use = createDataExportsSession(owner, () => id((next += 1)));
    await use.refresh();
    expect(use.getState()).toMatchObject({ status: 'ready', exports: [] });
    await use.request();
    expect(requested).toEqual([id(1)]);
    expect(use.getState().exports).toMatchObject([{ id: id(1), state: 'preparing' }]);
    expect(use.getState().requesting).toBe(false);
  });

  it('says when the request did not go through', async () => {
    const { owner, fail } = fixture();
    const use = createDataExportsSession(owner);
    fail.request = true;
    await use.request();
    expect(use.getState()).toMatchObject({ failed: 'request', requesting: false });
  });

  it('hands the link path to the opener once and never keeps it in state', async () => {
    const { owner } = fixture();
    const use = createDataExportsSession(owner);
    const opened: string[] = [];
    await use.download(id(1), (path) => opened.push(path));
    expect(opened).toEqual(['/auth/exports/kse_secret']);
    expect(JSON.stringify(use.getState())).not.toContain('kse_');
    expect(use.getState().opening).toBeUndefined();
  });

  it('rereads the receipts when the export is no longer ready', async () => {
    const { owner, fail, setExports } = fixture();
    const use = createDataExportsSession(owner);
    fail.link = problem('CONFLICT');
    setExports([{ id: id(1), state: 'preparing', requestedAt: '2026-10-24T10:00:00.000Z', expiresAt: null }]);
    const opener = vi.fn();
    await use.download(id(1), opener);
    expect(opener).not.toHaveBeenCalled();
    expect(use.getState().failed).toBe('download');
    expect(use.getState().exports).toHaveLength(1);
  });
});

describe('asking for deletion', () => {
  function deps() {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        newId: () => id(99),
        remember: (receiptId: string) => calls.push(`remember ${receiptId}`),
        forget: () => calls.push('forget'),
        ended: () => {
          calls.push('ended');
          return Promise.resolve();
        },
      },
    };
  }
  const owner = (answer: () => Promise<unknown>) => ({
    account,
    api: { account: { delete: vi.fn(answer) } } as unknown as Pick<ApiClient, 'account'>,
  });

  it('keeps the receipt before sending, sends the confirmed request and ends the scope once accepted', async () => {
    const { calls, deps: dependencies } = deps();
    const subject = owner(() => Promise.resolve({ receiptId: id(99), requestedAt: '2026-10-24T10:00:00.000Z' }));
    expect(await requestAccountDeletion(subject, dependencies)).toBe('accepted');
    expect(calls).toEqual([`remember ${id(99)}`, 'ended']);
    expect(subject.api.account.delete).toHaveBeenCalledWith({
      receiptId: id(99),
      expectedPrivacyEpoch: 3,
      confirmation: DELETE_ACCOUNT_CONFIRMATION,
    });
  });

  it('forgets the receipt when the request is refused', async () => {
    const stale = deps();
    expect(
      await requestAccountDeletion(
        owner(() => Promise.reject(problem('PRIVACY_EPOCH_CHANGED'))),
        stale.deps,
      ),
    ).toBe('stale');
    expect(stale.calls).toEqual([`remember ${id(99)}`, 'forget']);
    const refused = deps();
    expect(
      await requestAccountDeletion(
        owner(() => Promise.reject(problem('UNIVERSE_UNAVAILABLE'))),
        refused.deps,
      ),
    ).toBe('unavailable');
    expect(refused.calls).toEqual([`remember ${id(99)}`, 'forget']);
  });

  it('keeps the receipt when no answer arrives, so it can be asked about', async () => {
    const lost = deps();
    expect(
      await requestAccountDeletion(
        owner(() => Promise.reject(new Error('offline'))),
        lost.deps,
      ),
    ).toBe('unconfirmed');
    expect(lost.calls).toEqual([`remember ${id(99)}`]);
  });
});
