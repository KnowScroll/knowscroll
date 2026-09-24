import type { ReaderApi } from '../../src/api/client.ts';
import type {
  EventStatus,
  ExposureResponse,
  FeedResponse,
  InteractionResponse,
  PrivacyExportResult,
  PrivacyLifecycleRequest,
  PrivacyRecordingReceipt,
  PrivacyResetReceipt,
  PrivacyResetRequest,
  TraceRevisit,
  Universe,
  WorldSystemResponse,
} from '../../src/api/types.ts';

/** A hand-written fake of the seven bootstrap endpoints the reader store calls. Never a live/product proof. */
export class FakeApi implements ReaderApi {
  universeQueue: Array<Universe | Error> = [];
  feedQueue: Array<FeedResponse | Error> = [];
  exposureQueue: Array<ExposureResponse | Error> = [];
  interactionQueue: Array<InteractionResponse | Error> = [];
  eventQueue: Array<EventStatus | Error> = [];
  traceRevisitQueue: Array<TraceRevisit | Error> = [];
  worldsQueue: Array<WorldSystemResponse | Error> = [];

  pauseQueue: Array<PrivacyRecordingReceipt | Error> = [];
  resumeQueue: Array<PrivacyRecordingReceipt | Error> = [];
  privacyExportQueue: Array<PrivacyExportResult | Error> = [];
  resetQueue: Array<PrivacyResetReceipt | Error> = [];

  exposureCalls: Array<{ decisionId: string; assetId: string; clientExposureId: string }> = [];
  interactionCalls: Array<{ clientEventId: string; exposureId: string; assetId: string; kind: 'keep' }> = [];
  pauseCalls: PrivacyLifecycleRequest[] = [];
  resumeCalls: PrivacyLifecycleRequest[] = [];
  privacyExportCalls: PrivacyLifecycleRequest[] = [];
  resetCalls: PrivacyResetRequest[] = [];
  feedCalls = 0;
  universeCalls = 0;
  worldsCalls = 0;

  private async take<T>(queue: Array<T | Error>, label: string): Promise<T> {
    const next = queue.shift();
    if (next === undefined) throw new Error(`FakeApi.${label} called with an empty queue`);
    if (next instanceof Error) throw next;
    return next;
  }

  async getUniverse(): Promise<Universe> {
    this.universeCalls++;
    return this.take(this.universeQueue, 'getUniverse');
  }
  feedExcludes: string[][] = [];
  async getFeed(exclude: Iterable<string> = []): Promise<FeedResponse> {
    this.feedCalls++;
    this.feedExcludes.push([...exclude]);
    return this.take(this.feedQueue, 'getFeed');
  }
  async postExposure(body: { decisionId: string; assetId: string; clientExposureId: string }): Promise<ExposureResponse> {
    this.exposureCalls.push(body);
    return this.take(this.exposureQueue, 'postExposure');
  }
  async postInteraction(body: { clientEventId: string; exposureId: string; assetId: string; kind: 'keep' }): Promise<InteractionResponse> {
    this.interactionCalls.push(body);
    return this.take(this.interactionQueue, 'postInteraction');
  }
  async getEvent(_eventId: string): Promise<EventStatus> {
    return this.take(this.eventQueue, 'getEvent');
  }
  async getTraceRevisit(_eventId: string): Promise<TraceRevisit> {
    return this.take(this.traceRevisitQueue, 'getTraceRevisit');
  }
  async getWorlds(): Promise<WorldSystemResponse> {
    this.worldsCalls++;
    return this.take(this.worldsQueue, 'getWorlds');
  }
  async postPrivacyPause(body: PrivacyLifecycleRequest): Promise<PrivacyRecordingReceipt> {
    this.pauseCalls.push(body);
    return this.take(this.pauseQueue, 'postPrivacyPause');
  }
  async postPrivacyResume(body: PrivacyLifecycleRequest): Promise<PrivacyRecordingReceipt> {
    this.resumeCalls.push(body);
    return this.take(this.resumeQueue, 'postPrivacyResume');
  }
  async postPrivacyExport(body: PrivacyLifecycleRequest): Promise<PrivacyExportResult> {
    this.privacyExportCalls.push(body);
    return this.take(this.privacyExportQueue, 'postPrivacyExport');
  }
  async postPrivacyReset(body: PrivacyResetRequest): Promise<PrivacyResetReceipt> {
    this.resetCalls.push(body);
    return this.take(this.resetQueue, 'postPrivacyReset');
  }
}

export function feedItem(overrides: Partial<FeedResponse['items'][number]> = {}): FeedResponse['items'][number] {
  return {
    assetId: '10000000-0000-4000-8000-000000000001',
    revision: 1,
    kind: 'Scroll',
    title: 'An orbit is not a perfect circle',
    summary: 'A small change in shape changes how a planet moves.',
    body: 'Body text.',
    sourceTitle: 'NASA',
    sourceUrl: 'https://example.com/orbits',
    truthState: 'documented',
    reason: 'An editorial starting encounter. No interests have been inferred.',
    ...overrides,
  };
}

export function universeOf(overrides: Partial<Universe> = {}): Universe {
  return {
    universeId: 'aaaaaaaa-0000-4000-8000-000000000000',
    revision: 1,
    privacyEpoch: 0,
    recordingPausedAt: null,
    traces: [],
    capabilities: { reasoning: false, reels: false, worldEvolution: false },
    ...overrides,
  };
}

export function worldSystemOf(overrides: Partial<WorldSystemResponse> = {}): WorldSystemResponse {
  return {
    derivationMethod: 'shared_source_v1',
    system: {
      systemId: 'sys-1',
      worlds: [
        { worldId: 'world-orbits', sourceTitle: "NASA · Orbits and Kepler's Laws", sourceUrl: 'https://example.com/orbits', scrollCount: 9, seenCount: 2 },
        { worldId: 'world-stars', sourceTitle: 'NASA · Stars', sourceUrl: 'https://example.com/stars', scrollCount: 8, seenCount: 8 },
      ],
    },
    ...overrides,
  };
}

export function privacyRecordingReceiptOf(overrides: Partial<PrivacyRecordingReceipt> = {}): PrivacyRecordingReceipt {
  return {
    receiptId: 'recording-receipt-1',
    action: 'pause',
    privacyEpoch: 0,
    recordingPausedAt: '2026-09-21T10:00:00.000Z',
    appliedAt: '2026-09-21T10:00:00.000Z',
    ...overrides,
  };
}

export function privacyExportResultOf(overrides: Partial<PrivacyExportResult> = {}): PrivacyExportResult {
  return {
    receiptId: 'export-receipt-1',
    privacyEpoch: 0,
    exportedAt: '2026-09-21T10:00:00.000Z',
    rowCounts: {
      decisions: 3,
      ledger: 5,
      exposures: 3,
      traces: 1,
      jobs: 1,
      deviceSessions: 1,
      reasoningJobs: 0,
      reasoningSteps: 0,
      reasoningReceipts: 0,
      reasoningAccounting: 0,
      branchOpens: 0,
      connectionFeedback: 0,
      semanticProposals: 0,
      attentionAccounts: 0,
      hypotheses: 0,
      encounterFeedback: 0,
    },
    account: { email: 'owner@example.com' },
    universe: { id: universeOf().universeId, revision: 1, privacyEpoch: 0, recordingPausedAt: null },
    accounts: { keptAssetIds: [], revision: 1 },
    decisions: [],
    ledger: [],
    exposures: [],
    traces: [],
    jobs: [],
    deviceSessions: [],
    reasoning: { jobs: [], steps: [], receipts: [], accounting: [] },
    semantic: { branchOpens: [], connectionFeedback: [], proposals: [], bridges: [] },
    personalModel: { attentionAccounts: [], attentionTransitions: [], hypotheses: [], encounterFeedback: [], atlasPlaces: [], atlasDeltas: [] },
    ...overrides,
  };
}

export function privacyResetReceiptOf(overrides: Partial<PrivacyResetReceipt> = {}): PrivacyResetReceipt {
  return {
    receiptId: 'reset-receipt-1',
    epochBefore: 0,
    epochAfter: 1,
    sessionsRevoked: 1,
    resetAt: '2026-09-21T10:00:00.000Z',
    ...overrides,
  };
}
