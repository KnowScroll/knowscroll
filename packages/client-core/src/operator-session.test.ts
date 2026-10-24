import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { problemDetails, type JourneyResponse, type OperatorPanelsResponse } from '@knowscroll/contracts';
import type { ApiClient } from './api-client';
import { createOperatorSession } from './operator-session';

const notFound = () => {
  const details = problemDetails('NOT_FOUND');
  return new ORPCError('NOT_FOUND', { status: details.status, message: details.title, data: details });
};
const unavailable = { status: 'unavailable', reason: 'no_tier0_source' } as const;
const panels = {
  generatedAt: '2026-10-24T10:00:00.000Z',
  overview: {
    queues: { status: 'available', data: [] },
    providerOutcomes: { status: 'available', data: [] },
    recentErrors: { status: 'available', data: [] },
    serviceHealth: unavailable,
    requestLatency: unavailable,
    mediaDisk: unavailable,
  },
  production: {
    runs: { status: 'available', data: [] },
    refusedAnswers: { status: 'available', data: [] },
    reelOrders: { status: 'available', data: [] },
    usage: { status: 'unavailable', reason: 'view_missing' },
  },
  universeChange: { cartographer: { status: 'unavailable', reason: 'read_failed' } },
  safety: { reports: { status: 'available', data: { last24Hours: 0, recent: [] } } },
  realtime: { delivery: unavailable },
  privacy: {
    operations: { status: 'available', data: { groups: [], failed: [] } },
    retentionJobs: { status: 'available', data: [] },
    droppedDiagnostics: unavailable,
  },
} satisfies OperatorPanelsResponse;
const requestId = '0199a000-0000-7000-8000-000000000001';
const journey: JourneyResponse = { subject: 'request', subjectId: requestId, steps: [], gaps: [], truncated: false };

function fixture(
  overrides: { panels?: () => Promise<OperatorPanelsResponse>; journey?: () => Promise<JourneyResponse> } = {},
) {
  const calls: string[] = [];
  const owner = {
    active: true,
    api: {
      operator: {
        panels: () => {
          calls.push('panels');
          return (overrides.panels ?? (() => Promise.resolve(panels)))();
        },
        journey: (input: { id: string }) => {
          calls.push(`journey ${input.id}`);
          return (overrides.journey ?? (() => Promise.resolve(journey)))();
        },
      },
    } as unknown as Pick<ApiClient, 'operator'>,
  };
  return { owner, calls };
}

describe('the Operator session', () => {
  it('starts loading and holds the panels with when they were read', async () => {
    const { owner } = fixture();
    const session = createOperatorSession(owner);
    expect(session.getState().panels).toEqual({ status: 'loading' });
    await session.refresh();
    expect(session.getState().panels).toMatchObject({ status: 'ready', panels, stale: false });
  });

  it('reports an account that is not an operator, and keeps no panels', async () => {
    const { owner } = fixture({ panels: () => Promise.reject(notFound()) });
    const session = createOperatorSession(owner);
    await session.refresh();
    expect(session.getState().panels).toEqual({ status: 'not_operator' });
  });

  it('keeps the last good panels, marked stale, when a refresh fails', async () => {
    let fail = false;
    const { owner } = fixture({
      panels: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve(panels)),
    });
    const session = createOperatorSession(owner);
    await session.refresh();
    fail = true;
    await session.refresh();
    expect(session.getState().panels).toMatchObject({ status: 'ready', stale: true });
  });

  it('is unavailable when the first read fails for a reason other than refusal', async () => {
    const { owner } = fixture({ panels: () => Promise.reject(new Error('offline')) });
    const session = createOperatorSession(owner);
    await session.refresh();
    expect(session.getState().panels).toEqual({ status: 'unavailable' });
  });

  it('looks up a journey by ID, ignoring spaces around it', async () => {
    const { owner, calls } = fixture();
    const session = createOperatorSession(owner);
    await session.lookUp(`  ${requestId}\n`);
    expect(calls).toEqual([`journey ${requestId}`]);
    expect(session.getState().journey).toEqual({ status: 'found', journey });
  });

  it('never sends what is not an ID', async () => {
    const { owner, calls } = fixture();
    const session = createOperatorSession(owner);
    await session.lookUp('person@example.com');
    expect(calls).toEqual([]);
    expect(session.getState().journey).toEqual({ status: 'invalid' });
  });

  it('says so when no record carries the ID, and when the lookup could not be made', async () => {
    let failure: Error = notFound();
    const { owner } = fixture({ journey: () => Promise.reject(failure) });
    const session = createOperatorSession(owner);
    await session.lookUp(requestId);
    expect(session.getState().journey).toEqual({ status: 'not_found', id: requestId });
    failure = new Error('offline');
    await session.lookUp(requestId);
    expect(session.getState().journey).toEqual({ status: 'unavailable', id: requestId });
  });

  it('shows only the newest lookup, and nothing after it is cleared', async () => {
    const first = requestId;
    const second = '0199a000-0000-7000-8000-000000000002';
    const resolvers = new Map<string, (value: JourneyResponse) => void>();
    const owner = {
      active: true,
      api: {
        operator: {
          panels: () => Promise.resolve(panels),
          journey: ({ id }: { id: string }) =>
            new Promise<JourneyResponse>((resolve) => resolvers.set(id, (value) => resolve(value))),
        },
      } as unknown as Pick<ApiClient, 'operator'>,
    };
    const session = createOperatorSession(owner);
    const slow = session.lookUp(first);
    const fast = session.lookUp(second);
    resolvers.get(second)?.({ ...journey, subjectId: second });
    await fast;
    resolvers.get(first)?.(journey);
    await slow;
    expect(session.getState().journey).toMatchObject({ status: 'found', journey: { subjectId: second } });
    session.clearLookup();
    expect(session.getState().journey).toEqual({ status: 'idle' });
  });

  it('drops answers once its scope has ended', async () => {
    const { owner } = fixture();
    const ended = { ...owner, active: false };
    const session = createOperatorSession(ended);
    await session.refresh();
    expect(session.getState().panels).toEqual({ status: 'loading' });
  });
});
