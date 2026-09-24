import type { ReaderApi } from '../../src/api/client.ts';
import type {
  AccountDeletionReceipt,
  AccountDeletionRequest,
  EncounterFeedbackReceipt,
  EncounterFeedbackRequest,
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
  WhyResponse,
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
  // `take()` treats a plain `undefined` element as "queue empty" (`next === undefined` above), so
  // a void success is queued as the sentinel `'ok'` here rather than `undefined` itself.
  sessionRevokeQueue: Array<'ok' | Error> = [];
  accountDeleteQueue: Array<AccountDeletionReceipt | Error> = [];
  /** #133: `null` is the honest 404 ("no recorded explanation"), exactly as `ApiClient.getWhy` returns it. */
  whyQueue: Array<WhyResponse | null | Error> = [];
  feedbackQueue: Array<EncounterFeedbackReceipt | Error> = [];

  exposureCalls: Array<{ decisionId: string; assetId: string; clientExposureId: string }> = [];
  interactionCalls: Array<{ clientEventId: string; exposureId: string; assetId: string; kind: 'keep' }> = [];
  pauseCalls: PrivacyLifecycleRequest[] = [];
  resumeCalls: PrivacyLifecycleRequest[] = [];
  privacyExportCalls: PrivacyLifecycleRequest[] = [];
  resetCalls: PrivacyResetRequest[] = [];
  sessionRevokeCalls = 0;
  accountDeleteCalls: AccountDeletionRequest[] = [];
  whyCalls: Array<{ decisionId: string; assetId: string }> = [];
  feedbackCalls: EncounterFeedbackRequest[] = [];
  /** When set, `postEncounterFeedback` stays in flight until this resolves (a correction still being sent). */
  feedbackGate: Promise<void> | null = null;
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
  /** When set, `postExposure` stays in flight until this resolves (an exposure still being recorded). */
  exposureGate: Promise<void> | null = null;
  async postExposure(body: { decisionId: string; assetId: string; clientExposureId: string }): Promise<ExposureResponse> {
    this.exposureCalls.push(body);
    if (this.exposureGate) await this.exposureGate;
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
  async postSessionRevoke(): Promise<void> {
    this.sessionRevokeCalls++;
    await this.take(this.sessionRevokeQueue, 'postSessionRevoke');
  }
  async postAccountDelete(body: AccountDeletionRequest): Promise<AccountDeletionReceipt> {
    this.accountDeleteCalls.push(body);
    return this.take(this.accountDeleteQueue, 'postAccountDelete');
  }
  async getWhy(decisionId: string, assetId: string): Promise<WhyResponse | null> {
    this.whyCalls.push({ decisionId, assetId });
    return this.take(this.whyQueue, 'getWhy');
  }
  async postEncounterFeedback(body: EncounterFeedbackRequest): Promise<EncounterFeedbackReceipt> {
    this.feedbackCalls.push(body);
    if (this.feedbackGate) await this.feedbackGate;
    return this.take(this.feedbackQueue, 'postEncounterFeedback');
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
      askAnswers: 0,
      inquiries: 0,
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
    askAnswers: [],
    inquiries: { consent: [], consentRequests: [], mail: [], inquiries: [] },
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

/** #133: a recorded "why" for a bridge encounter -- a keep, then the sourced connection it crossed
 * (the shape `composer-semantic-v3` records; see tests/composer-semantic-http.test.ts). */
export function whyOf(overrides: Partial<WhyResponse> = {}): WhyResponse {
  return {
    decisionId: '40000000-0000-4000-8000-000000000001',
    assetId: feedItem().assetId,
    policyVersion: 'composer-semantic-v3',
    family: 'bridge',
    reason: 'A sourced connection from “A rhythm the ocean keeps”: Tides is explained by Gravity',
    evidence: [
      {
        kind: 'mark',
        markKind: 'keep',
        assetId: '10000000-0000-4000-8000-000000000002',
        title: 'A rhythm the ocean keeps',
        at: '2026-09-24T10:00:00.000Z',
        eventId: '50000000-0000-4000-8000-000000000001',
      },
      { kind: 'bridge', bridgeId: '60000000-0000-4000-8000-000000000001', sentence: 'Tides is explained by Gravity' },
    ],
    terms: { continuity: 0, useful: 0.2, depth: 1.2, novelty: 0.5, returnRelevance: 0, prior: 0, redundancy: 0, fatigue: 0, seen: 0 },
    quotas: ['exploration:bridge'],
    corrections: ['less_like_this', 'wrong_connection'],
    corrected: [],
    ...overrides,
  };
}

export function encounterFeedbackReceiptOf(overrides: Partial<EncounterFeedbackReceipt> = {}): EncounterFeedbackReceipt {
  return {
    feedbackId: '70000000-0000-4000-8000-000000000001',
    kind: 'less_like_this',
    suppressed: { family: 'bridge', concept: 'earth.tides', bridgeId: '60000000-0000-4000-8000-000000000001', until: '2026-10-08T10:00:00.000Z' },
    ...overrides,
  };
}
