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
