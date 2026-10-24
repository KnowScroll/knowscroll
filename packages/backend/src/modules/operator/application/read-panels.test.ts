import { describe, expect, it } from 'vitest';
import { RETENTION_QUEUES, type Piece, type QueueRow } from '../domain/panels.js';
import type { PanelStore } from './ports.js';
import { makeReadOperatorPanels } from './read-panels.js';

const available = <T>(data: T): Piece<T> => ({ status: 'available', data });
const queue = (name: string): QueueRow => ({
  queue: name,
  ready: 0,
  scheduled: 0,
  retrying: 0,
  active: 0,
  failed: 0,
  oldestWaitingSeconds: null,
  lastCompletedAt: null,
});

function store(overrides: Partial<PanelStore> = {}): PanelStore {
  return {
    queues: () => Promise.resolve(available([queue('supply.resolve-request'), queue(RETENTION_QUEUES[0] ?? '')])),
    providerOutcomes: () => Promise.resolve(available([{ state: 'succeeded', count: 3 }])),
    usage: () =>
      Promise.resolve(available({ windowHours: 24, attempts: 3, tokensReported: 90, attemptsWithoutReportedUsage: 0 })),
    recentErrors: () => Promise.resolve(available([])),
    productionRuns: () => Promise.resolve(available([])),
    refusedAnswers: () => Promise.resolve(available([])),
    reelOrders: () => Promise.resolve(available([])),
    cartographer: () => Promise.resolve(available({ counts: [], recent: [] })),
    privacy: () => Promise.resolve(available({ groups: [], failed: [] })),
    reports: () => Promise.resolve(available({ last24Hours: 0, recent: [] })),
    ...overrides,
  };
}

const now = () => new Date('2026-10-24T10:00:00.000Z');

describe('the Operator panels', () => {
  it('marks the pieces Tier 0 has no source for as unavailable, never estimated', async () => {
    const panels = await makeReadOperatorPanels({ store: store(), now })();
    for (const piece of [
      panels.overview.serviceHealth,
      panels.overview.requestLatency,
      panels.overview.mediaDisk,
      panels.realtime.delivery,
      panels.privacy.droppedDiagnostics,
    ])
      expect(piece).toEqual({ status: 'unavailable', reason: 'no_tier0_source' });
    expect(panels.generatedAt).toEqual(now());
  });

  it('shows only the retention jobs among the queues', async () => {
    const panels = await makeReadOperatorPanels({ store: store(), now })();
    expect(panels.privacy.retentionJobs).toEqual(available([queue(RETENTION_QUEUES[0] ?? '')]));
  });

  it('reads at most three views at a time, so the panels cannot take the connection pool', async () => {
    let running = 0;
    let most = 0;
    const slow =
      <T>(piece: Piece<T>) =>
      async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return piece;
      };
    const base = store();
    const bounded: PanelStore = {
      queues: slow(available([queue('supply.resolve-request')])),
      providerOutcomes: slow(available([])),
      usage: slow(available({ windowHours: 24, attempts: 0, tokensReported: 0, attemptsWithoutReportedUsage: 0 })),
      recentErrors: slow(available([])),
      productionRuns: slow(available([])),
      refusedAnswers: slow(available([])),
      reelOrders: slow(available([])),
      cartographer: slow(available({ counts: [], recent: [] })),
      privacy: slow(available({ groups: [], failed: [] })),
      reports: slow(available({ last24Hours: 0, recent: [] })),
    };
    expect(Object.keys(bounded)).toEqual(Object.keys(base));
    const panels = await makeReadOperatorPanels({ store: bounded, now })();
    expect(most).toBe(3);
    expect(panels.overview.queues.status).toBe('available');
  });

  it('lists the reports to the safety team beside the other panels', async () => {
    const recent = [
      {
        reportId: '5b7f8d25-9a9c-4c1e-9a3a-0a4c2b7a8e11',
        kind: 'abuse' as const,
        category: 'harassment',
        targetKind: 'room_message' as const,
        assetId: null,
        messageId: '0f3c9c5e-5d2c-4a37-8b0b-4f5fdc3e2d10',
        roomId: 'a8d9d0e2-3c0e-4b8c-9c1b-6d0c9b3c4f21',
        hasNote: true,
        createdAt: new Date('2026-10-24T09:30:00.000Z'),
      },
    ];
    const panels = await makeReadOperatorPanels({
      store: store({ reports: () => Promise.resolve(available({ last24Hours: 1, recent })) }),
      now,
    })();
    expect(panels.safety.reports).toEqual(available({ last24Hours: 1, recent }));
  });

  it('keeps answering when one view cannot be read', async () => {
    const unavailable: Piece<never> = { status: 'unavailable', reason: 'view_missing' };
    const panels = await makeReadOperatorPanels({
      store: store({ queues: () => Promise.resolve(unavailable) }),
      now,
    })();
    expect(panels.overview.queues).toEqual(unavailable);
    expect(panels.privacy.retentionJobs).toEqual(unavailable);
    expect(panels.overview.providerOutcomes.status).toBe('available');
  });
});
