import type { ReaderApi } from '../../src/api/client.ts';
import type { EventStatus, ExposureResponse, FeedResponse, InteractionResponse, TraceRevisit, Universe, WorldSystemResponse } from '../../src/api/types.ts';

/** A hand-written fake of the seven bootstrap endpoints the reader store calls. Never a live/product proof. */
export class FakeApi implements ReaderApi {
  universeQueue: Array<Universe | Error> = [];
  feedQueue: Array<FeedResponse | Error> = [];
  exposureQueue: Array<ExposureResponse | Error> = [];
  interactionQueue: Array<InteractionResponse | Error> = [];
  eventQueue: Array<EventStatus | Error> = [];
  traceRevisitQueue: Array<TraceRevisit | Error> = [];
  worldsQueue: Array<WorldSystemResponse | Error> = [];

  exposureCalls: Array<{ decisionId: string; assetId: string; clientExposureId: string }> = [];
  interactionCalls: Array<{ clientEventId: string; exposureId: string; assetId: string; kind: 'keep' }> = [];
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
  async getFeed(): Promise<FeedResponse> {
    this.feedCalls++;
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
