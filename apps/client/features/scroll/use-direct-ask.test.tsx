import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useEffect } from 'react';
import type { ContentRequestStatus } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import pictureDocument from '@knowscroll/scroll-model/fixtures/seasons-v3-ci.json';
import { beatsOfV3, type ScrollDocumentV3 } from '@knowscroll/scroll-model';
import { RequestNotice } from '../encounter/encounter-notices';
import { id } from '../encounter/encounter-session.fixture';
import { requestHarness } from '../requests/request-session.fixture';
import type { OpenedScrollFolio } from './scroll-session';
import { SLOW_READ_EVERY_MS } from '../requests/request-session';
import { useDirectAsk } from './use-direct-ask';

const mockPush = jest.fn();
// One router object for every render, as expo-router's is: a new one would replace the session.
const mockRouter = {
  push: (path: string): void => {
    mockPush(path);
  },
};
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
let mockCounter = 5000;
jest.mock('../../platform/command-id', () => ({
  newCommandId: () => `0199a000-0000-7000-8000-${String(++mockCounter).padStart(12, '0')}`,
}));

/** A labelled fixture Scroll: only the fields the hook reads. */
const scroll = {
  exposureId: id(4),
  assetId: id(5),
  assetRevision: 2,
  document: { stops: [{ id: 'stop-one' }, { id: 'stop-two' }] },
} as unknown as OpenedScrollFolio;

const harness = requestHarness();
let latest: ReturnType<typeof useDirectAsk>;
/** The Scroll and the place on screen the probe asks from; a test changes them before it mounts. */
let asked: { scroll: OpenedScrollFolio; place: string | undefined } = { scroll, place: 'stop-one' };

function Probe() {
  const direct = useDirectAsk(harness.scope, asked.scroll, () => asked.place);
  useEffect(() => {
    latest = direct;
  });
  return (
    <>
      <RequestNotice
        requests={direct.session}
        exposureId={scroll.exposureId}
        onOpen={() => {
          void direct.openReady();
        }}
      />
    </>
  );
}

const readsOfStatus = () => harness.calls.filter((call) => call.path.startsWith('/v1/content/requests/')).length;
const ready = (): ContentRequestStatus => ({
  ...harness.fields,
  requestRevision: 3,
  status: 'ready',
  content: {
    assetId: id(44),
    assetRevision: 7,
    explanationUnitId: 'fixture-only',
    metadata: { kind: 'scroll', title: 'Ready fixture', summary: 'CI only', language: 'en' },
  },
});

async function mounted() {
  const view = await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <Probe />
    </DisplayProvider>,
  );
  await act(() => {
    latest.openAsk();
  });
  await act(() => {
    latest.session.edit({ text: 'Why is the far side cold?' });
    latest.session.submit();
  });
  await act(() => jest.advanceTimersByTimeAsync(1000));
  expect(latest.session.getState().phase).toBe('accepted');
  return view;
}

describe('Ask on a Scroll’s own address (D-262)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockPush.mockReset();
  });
  afterEach(() => jest.useRealTimers());

  it('goes on reading a slow order with the sheet shut, shows the ready notice, and Open goes to the answer and puts the notice away', async () => {
    await mounted();
    await act(() => {
      latest.close();
    });
    expect(screen.getByText(/We'll let you know when your answer is ready/)).toBeOnTheScreen();
    // More than the session's own twelve quick reads (about a minute) have passed and the order is still preparing.
    await act(() => jest.advanceTimersByTimeAsync(5 * 60_000));
    expect(latest.session.getState().status?.status).toBe('preparing');
    harness.setStatus(ready());
    await act(() => jest.advanceTimersByTimeAsync(SLOW_READ_EVERY_MS + 100));
    expect(screen.getByText(/Your answer is ready: “Ready fixture”/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByText('Open'));
    await act(() => jest.advanceTimersByTimeAsync(10));
    expect(mockPush).toHaveBeenCalledWith(`/scroll/${id(44)}`);
    expect(screen.queryByText(/Your answer is ready/)).not.toBeOnTheScreen();
  });

  it('stops every read when the screen is left', async () => {
    const view = await mounted();
    await act(() => {
      latest.close();
    });
    await view.unmount();
    const before = readsOfStatus();
    await act(() => jest.advanceTimersByTimeAsync(5 * 60_000));
    expect(readsOfStatus()).toBe(before);
  });
});

describe('Ask on a document v3 Scroll’s own address', () => {
  const document3 = pictureDocument as unknown as ScrollDocumentV3;
  const beats = beatsOfV3(document3);
  const scroll3 = {
    exposureId: id(4),
    assetId: id(5),
    assetRevision: 2,
    document: document3,
  } as unknown as OpenedScrollFolio;
  const shown = beats[1]!.id;

  beforeEach(() => {
    asked = { scroll: scroll3, place: shown };
  });
  afterEach(() => {
    asked = { scroll, place: 'stop-one' };
  });

  async function opened() {
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <Probe />
      </DisplayProvider>,
    );
  }

  it('anchors the question to the beat on screen', async () => {
    await opened();
    await act(() => {
      expect(latest.openAsk()).toBe(true);
    });
    expect(latest.open).toBe(true);
    expect(latest.session.getState().anchor).toEqual({ stopId: shown });
  });

  it('anchors it to the last beat at the end of the Scroll, where none is on screen', async () => {
    asked = { scroll: scroll3, place: undefined };
    await opened();
    await act(() => {
      expect(latest.openAsk()).toBe(true);
    });
    expect(latest.session.getState().anchor).toEqual({ stopId: beats.at(-1)!.id });
  });

  it('opens “Make it a full Scroll” at the beat a Quick answer was asked at, with the words as the first draft', async () => {
    await opened();
    await act(() => {
      latest.openAbout(beats[0]!.id, 'a tilted axis');
    });
    expect(latest.session.getState().anchor).toEqual({ stopId: beats[0]!.id });
    expect(latest.session.getState().text).toBe('Tell me more about “a tilted axis”');
  });
});
