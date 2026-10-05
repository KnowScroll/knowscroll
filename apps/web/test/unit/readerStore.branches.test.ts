import { beforeEach, describe, expect, it } from 'vitest';
import type { WebEncounterBranch, WebEncounterBranchesResponse, WebBranchOpenResponse } from '@knowscroll/contracts/semantic';
import { ReaderStore } from '../../src/state/readerStore.ts';
import { MemoryStorageBackend, ReaderStorage } from '../../src/state/storage.ts';
import { FakeApi, feedItem, universeOf } from './fakeApi.ts';

const originId = feedItem().assetId;
const targetId = '10000000-0000-4000-8000-000000000002';
const bridgeId = '10000000-0000-4000-8000-000000000003';
const branchId = '10000000-0000-4000-8000-000000000004';

function branchResponse(overrides: Partial<WebEncounterBranchesResponse> = {}): WebEncounterBranchesResponse {
  const branch: WebEncounterBranch = {
    branchId, bridgeId, relationType: 'explains', direction: 'forward', relationPhrase: 'explains',
    fromConcept: { code: 'astro.gravity', name: 'Gravity' }, toConcept: { code: 'astro.tides', name: 'Tides' },
    mechanism: 'A shared physical mechanism.', limitations: [], prerequisites: [], evidence: [],
    target: { assetId: targetId, revision: 1, kind: 'Scroll', title: 'Tides', summary: 'A summary.' }, seen: false,
  };
  return { assetId: originId, revision: 1, privacyEpoch: 0, branches: [branch], emptyReason: null, ...overrides };
}

function branchReceipt(overrides: Partial<WebBranchOpenResponse> = {}): WebBranchOpenResponse {
  const branch: WebBranchOpenResponse['branch'] = { branchOpenId: '30000000-0000-4000-8000-000000000001', recorded: true, bridgeId, relationType: 'explains', direction: 'forward' };
  return {
    decisionId: '30000000-0000-4000-8000-000000000002', universeId: universeOf().universeId, accountRevision: 1, privacyEpoch: 0,
    items: [{ ...feedItem({ assetId: targetId, title: 'Tides' }), reason: 'Gravity explains Tides.', webArtifact: null }], branch,
    ...overrides,
  };
}

async function tick(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)); }
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await tick();
  }
}

describe('ReaderStore horizontal branches', () => {
  let api: FakeApi;
  let storage: ReaderStorage;
  let store: ReaderStore;

  beforeEach(() => {
    api = new FakeApi();
    storage = new ReaderStorage(new MemoryStorageBackend());
    store = new ReaderStore(api, storage);
  });

  async function enterOrigin(): Promise<void> {
    api.universeQueue.push(universeOf());
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');
    api.feedQueue.push({ decisionId: 'feed-decision', universeId: universeOf().universeId, accountRevision: 1, privacyEpoch: 0, items: [feedItem()] });
    store.enterScroll();
    await waitFor(() => store.getState().scroll.status === 'reading');
  }

  async function exposeOrigin(): Promise<void> {
    api.exposureQueue.push({ exposureId: 'origin-exposure', eventId: 'origin-event' });
    store.onVisible(originId);
    await waitFor(() => {
      const scroll = store.getState().scroll;
      return scroll.status === 'reading' && scroll.exposureId === 'origin-exposure';
    });
  }

  it('does not list before explicit Explore; a pending exposure disables branch opening', async () => {
    await enterOrigin();
    expect(api.branchesQueue).toHaveLength(0);
    let release!: () => void;
    api.exposureGate = new Promise<void>(resolve => { release = resolve; });
    api.exposureQueue.push({ exposureId: 'origin-exposure', eventId: 'origin-event' });
    store.onVisible(originId);
    store.refreshBranches();
    expect(api.branchOpenCalls).toHaveLength(0);
    expect(store.getState().branches).toMatchObject({ status: 'loading', canOpen: false });
    api.branchesQueue.push(branchResponse());
    release();
    await waitFor(() => store.getState().branches.status === 'loaded');
    await waitFor(() => {
      const branches = store.getState().branches;
      return branches.status === 'loaded' && branches.canOpen;
    });
    expect(api.branchesQueue).toHaveLength(0);
  });

  it('opens only a listed branch and restores the exact origin position on return', async () => {
    await enterOrigin();
    await exposeOrigin();
    const reading = store.getState().scroll;
    if (reading.status !== 'reading') throw new Error('expected origin Scroll');
    store.updateReadingPosition(originId, 0.63);
    api.branchesQueue.push(branchResponse());
    store.refreshBranches();
    await waitFor(() => store.getState().branches.status === 'loaded');
    api.branchOpenQueue.push(branchReceipt());
    store.openBranch(branchId);
    await waitFor(() => {
      const scroll = store.getState().scroll;
      return scroll.status === 'reading' && scroll.item.assetId === targetId;
    });
    const target = store.getState().scroll;
    if (target.status !== 'reading') throw new Error('expected branch target');
    expect(target.origin).toEqual({ type: 'branch', fromAssetId: originId, fromTitle: feedItem().title, relationPhrase: 'explains', recorded: true });
    expect(api.branchOpenCalls[0]?.fromExposureId).toBe('origin-exposure');
    expect(store.returnAlongBranch()).toBe(true);
    const returned = store.getState().scroll;
    expect(returned.status).toBe('reading');
    if (returned.status === 'reading') expect(returned.readingPosition).toBe(0.63);
  });

  it('reuses the saved clientBranchId after an ambiguous failure', async () => {
    await enterOrigin();
    await exposeOrigin();
    api.branchesQueue.push(branchResponse());
    store.refreshBranches();
    await waitFor(() => store.getState().branches.status === 'loaded');
    api.branchOpenQueue.push(new Error('response was lost'));
    store.openBranch(branchId);
    await waitFor(() => {
      const branches = store.getState().branches;
      return branches.status === 'loaded' && branches.opening === null;
    });
    const first = api.branchOpenCalls[0]!;
    expect(storage.readPendingBranch()?.request).toEqual(first);
    api.branchOpenQueue.push(branchReceipt());
    store.openBranch(branchId);
    await waitFor(() => {
      const scroll = store.getState().scroll;
      return scroll.status === 'reading' && scroll.item.assetId === targetId;
    });
    expect(api.branchOpenCalls[1]).toEqual(first);
    expect(storage.readPendingBranch()).toBeNull();
  });

  it('serves an unrecorded paused target without exposure or Keep', async () => {
    await enterOrigin();
    await exposeOrigin();
    api.branchesQueue.push(branchResponse());
    store.refreshBranches();
    await waitFor(() => store.getState().branches.status === 'loaded');
    api.branchOpenQueue.push(branchReceipt({ decisionId: null, branch: { ...branchReceipt().branch, branchOpenId: null, recorded: false } }));
    store.openBranch(branchId);
    await waitFor(() => {
      const scroll = store.getState().scroll;
      return scroll.status === 'reading' && scroll.item.assetId === targetId;
    });
    store.onVisible(targetId);
    store.keep();
    await tick();
    const target = store.getState().scroll;
    expect(target.status).toBe('reading');
    if (target.status === 'reading') expect(target.origin).toMatchObject({ type: 'branch', recorded: false });
    expect(api.exposureCalls).toHaveLength(1);
    expect(api.interactionCalls).toHaveLength(0);
  });
});
