import { StrictMode, type useEffect } from 'react';
import { AppState } from 'react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react-native';
import {
  createAccountScope,
  memoryStore,
  type AccountScope,
  type ScrollRecorder,
  type ScrollRecorderOptions,
} from '@knowscroll/client-core';
import type * as Core from '@knowscroll/client-core';
import type { InteractionEvent } from '@knowscroll/contracts';
import { parseDocument } from '@knowscroll/scroll-model';
import document from '@knowscroll/scroll-model/fixtures/spring-neap-tides.json';
import { DisplayProvider } from '@knowscroll/ui';
import { ScrollScreen } from './scroll-screen';
import type { OpenedScroll } from './scroll-session';

// Real screen, article, activity/visibility hooks and recorder. Only opening, router, clock and
// outbox delivery are fixtures; this is effect-ordering evidence, not a native/browser journey.
let mockScope: AccountScope;
let mockScroll: OpenedScroll;
let mockNow = 5_000;
const mockEvents: InteractionEvent[] = [];
const mockRecorders: { recorder: ScrollRecorder; start: jest.SpyInstance; end: jest.SpyInstance }[] = [];
const mockIntervals = new Map<object, () => void>();
const mockSession = { start: jest.fn(), dispose: jest.fn() };

jest.mock('../../providers/account-scope', () => ({
  useAccountScope: () => ({ state: { status: 'signed_in', scope: mockScope } }),
}));
jest.mock('./use-scroll-session', () => ({
  useScrollSession: () => ({ session: mockSession, state: { status: 'ready', scroll: mockScroll } }),
}));
jest.mock('../diagnostics/evidence-panel', () => ({ EvidencePanel: () => null }));
jest.mock('../../platform/command-id', () => {
  let next = 0;
  return { newCommandId: () => `0199a000-0000-7000-8000-${String(++next).padStart(12, '0')}` };
});
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) =>
    jest.requireActual<{ useEffect: typeof useEffect }>('react').useEffect(effect, [effect]),
  useLocalSearchParams: () => ({ assetId: '0199a000-0000-7000-8000-0000000000a1' }),
  useRouter: () => ({ canGoBack: () => false, back: jest.fn(), replace: jest.fn() }),
}));
jest.mock('@knowscroll/client-core', () => {
  const actual = jest.requireActual<typeof Core>('@knowscroll/client-core');
  return {
    ...actual,
    createScrollRecorder: (options: ScrollRecorderOptions) => {
      const recorder = actual.createScrollRecorder({
        ...options,
        timers: {
          setInterval: (callback) => {
            const handle = {};
            mockIntervals.set(handle, callback);
            return handle;
          },
          clearInterval: (handle) => void mockIntervals.delete(handle as object),
        },
        outbox: {
          enqueue: (events) => void mockEvents.push(...events),
          drain: () => Promise.resolve(),
          status: () => ({ pendingBatches: 0, pendingEvents: 0, dropped: 0, stopped: false }),
          dispose: () => undefined,
        },
      });
      const start = jest.spyOn(recorder, 'start');
      const end = jest.spyOn(recorder, 'end');
      mockRecorders.push({ recorder, start, end });
      return recorder;
    },
  };
});

describe('the direct Scroll recorder lifecycle', () => {
  it('keeps real activity and visibility after StrictMode cleanup/setup and fences callbacks after unmount', async () => {
    mockNow = 5_000;
    mockEvents.length = 0;
    mockRecorders.length = 0;
    mockIntervals.clear();
    const appState = AppState as unknown as { currentState: unknown };
    const previousState = appState.currentState;
    appState.currentState = 'active';
    jest.spyOn(performance, 'now').mockImplementation(() => mockNow);
    const parsed = parseDocument(document);
    if (parsed.kind !== 'valid') throw new Error('Labelled fixture must parse');
    mockScroll = {
      exposureId: '0199a000-0000-7000-8000-0000000000e1',
      assetId: '0199a000-0000-7000-8000-0000000000a1',
      assetRevision: 1,
      recordingGeneration: 1,
      recordingSessionId: '0199a000-0000-7000-8000-0000000000d1',
      document: parsed.document,
      degradedEssential: [],
    };
    mockScope = createAccountScope({
      account: {
        accountId: mockScroll.assetId,
        universeId: mockScroll.exposureId,
        privacyEpoch: 1,
        email: 'fixture@scroll.test',
      },
      baseUrl: 'https://fixture.scroll.test',
      store: memoryStore(),
      authorization: () => undefined,
      fetch: async (request) => {
        // The format switch reads the exposure context; this fixture has no twin to report.
        if (request.url.endsWith('/context'))
          return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
        if (!request.url.endsWith('/v1/privacy/recording/read'))
          throw new Error('Only the current-policy fixture is expected');
        const input = (await request.json()) as { readId: string; target: unknown };
        return new Response(
          JSON.stringify({
            version: 'recording-policy.v1',
            ...input,
            scope: { accountId: mockScroll.assetId, privacyEpoch: 1 },
            revision: 0,
            policy: { on: true, generation: 1 },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });
    mockScope.recording?.useIdSource(() => '0199a000-0000-7000-8000-0000000000d2');
    await mockScope.recording?.refresh();
    try {
      const app = await render(
        <StrictMode>
          <QueryClientProvider client={mockScope.queryClient}>
            <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
              <ScrollScreen />
            </DisplayProvider>
          </QueryClientProvider>
        </StrictMode>,
      );
      const lifecycle = mockRecorders.find((candidate) => candidate.start.mock.calls.length > 0);
      if (!lifecycle) throw new Error('Screen must own a recorder');
      const { recorder } = lifecycle;
      // Prove StrictMode really performed cleanup/setup; a single mount would miss the regression.
      expect(lifecycle.start).toHaveBeenCalledTimes(2);
      expect(lifecycle.end).toHaveBeenCalledTimes(1);
      expect(mockIntervals.size).toBe(1);
      // Actual renderer visibility comes from host layout events, after commit; activity already
      // came from its real passive effect. Neither callback is injected directly into the recorder.
      const layout = (y: number, height: number) => ({ nativeEvent: { layout: { x: 0, y, width: 390, height } } });
      await fireEvent(screen.getByTestId('scroll-article'), 'layout', layout(0, 800));
      await fireEvent(screen.getByTestId('block-pulls-p1'), 'layout', layout(150, 100));
      mockNow += 1_000;
      recorder.flush();
      expect(
        mockEvents.filter((event) => event.kind === 'scroll.active_dwell').map((event) => event.payload),
      ).toContainEqual({
        activeIntervalsMs: [[0, 1_000]],
      });
      expect(
        mockEvents.filter((event) => event.kind === 'scroll.block_coverage').map((event) => event.payload),
      ).toContainEqual({
        blocks: [{ blockId: 'pulls-p1', intervalsMs: [[0, 1_000]], peakFraction: 1 }],
      });
      await app.unmount();
      expect(mockIntervals.size).toBe(0);
      const count = mockEvents.length;
      recorder.observer.onActivity({ active: true, at: mockNow });
      recorder.observer.onBlockVisibility({ blockId: 'late', visibleFraction: 1, at: mockNow });
      recorder.observer.onBlockInteraction({ blockId: 'late', kind: 'expanded', at: mockNow });
      mockNow += 10_000;
      recorder.resume();
      recorder.flush();
      expect(mockEvents).toHaveLength(count);
    } finally {
      mockScope.end();
      appState.currentState = previousState;
      jest.restoreAllMocks();
    }
  });
});
