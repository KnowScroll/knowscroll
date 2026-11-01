import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useEffect } from 'react';
import type { ContentRequestStatus } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { RequestNotice } from '../encounter/encounter-notices';
import { id } from '../encounter/encounter-session.fixture';
import { requestHarness } from '../requests/request-session.fixture';
import type { OpenedStageScroll } from './scroll-session';
import { WATCH_EVERY_MS, useDirectAsk } from './use-direct-ask';

const mockPush = jest.fn();
const mockRouter = {
  push: (path: string): void => {
    mockPush(path);
  },
};
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
let mockCounter = 7000;
jest.mock('../../platform/command-id', () => ({
  newCommandId: () => `0199a000-0000-7000-8000-${String(++mockCounter).padStart(12, '0')}`,
}));

const scroll = {
  exposureId: id(4),
  assetId: id(5),
  assetRevision: 2,
  document: { stops: [{ id: 'stop-one' }] },
} as unknown as OpenedStageScroll;

const harness = requestHarness();
let latest: ReturnType<typeof useDirectAsk>;

function Probe() {
  const direct = useDirectAsk(harness.scope, scroll, () => 'stop-one');
  useEffect(() => {
    latest = direct;
  });
  return (
    <RequestNotice
      requests={direct.session}
      exposureId={scroll.exposureId}
      onOpen={() => {
        void direct.openReady();
      }}
    />
  );
}

const readyReel = (): ContentRequestStatus => ({
  ...harness.fields,
  requestRevision: 3,
  status: 'ready',
  content: {
    assetId: id(44),
    assetRevision: 7,
    explanationUnitId: 'fixture-only',
    metadata: { kind: 'reel', title: 'Ready Reel fixture', summary: 'CI only', language: 'en' },
  },
});

describe('asking for the other format on a Scroll’s own address (D-269)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockPush.mockReset();
  });
  afterEach(() => jest.useRealTimers());

  it('asks for a Reel on the same sheet as a variant of this Scroll, and a Reel that is ready opens as a Reel', async () => {
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <Probe />
      </DisplayProvider>,
    );
    await act(() => {
      latest.openFormat('reel');
    });
    expect(latest.open).toBe(true);
    expect(latest.session.getState().mode).toBe('reel');
    await act(() => {
      latest.session.submit();
    });
    await act(() => jest.advanceTimersByTimeAsync(1000));
    expect(harness.calls.filter((call) => call.path === '/v1/content/requests').at(-1)?.body).toMatchObject({
      intent: { kind: 'variant', to: 'reel', source: { exposureId: scroll.exposureId, assetId: scroll.assetId } },
    });
    await act(() => {
      latest.close();
    });
    harness.setStatus(readyReel());
    await act(() => jest.advanceTimersByTimeAsync(WATCH_EVERY_MS + 100));
    await fireEvent.press(screen.getByText('Open'));
    await act(() => jest.advanceTimersByTimeAsync(10));
    expect(mockPush).toHaveBeenCalledWith(`/reel/${id(44)}`);
  });
});
