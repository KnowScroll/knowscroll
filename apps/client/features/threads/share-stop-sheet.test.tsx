import { fireEvent, render, screen } from '@testing-library/react-native';
import stageDocument from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { createApiClient, type AccountScope } from '@knowscroll/client-core';
import { problemDetails, type ProblemCode } from '@knowscroll/contracts';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { momentAnchorOf, momentOf } from '@knowscroll/scroll-model';
import { DisplayProvider } from '@knowscroll/ui';
import type { OpenedStageScroll } from '../scroll/scroll-session';
import { ShareStopSheet } from './share-stop-sheet';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ASSET = id(40);
const mockSends: { commandId: string; body: Record<string, unknown> }[] = [];
const mockReads: string[] = [];
const mockState: { outcome: 'ok' | 'lost' | Error } = { outcome: 'ok' };
/** What each thread's own series holds, as its view says: only the first holds the Scroll being read. */
const mockHolds = new Map<string, string[]>([
  [id(1), [id(41), ASSET]],
  [id(3), [id(42)]],
  [id(5), [id(43)]],
]);
const mockScope = {
  active: true,
  api: {
    threads: {
      send: (input: { commandId: string; body: Record<string, unknown> }) => {
        mockSends.push(input);
        if (mockState.outcome === 'ok') return Promise.resolve({});
        return Promise.reject(mockState.outcome === 'lost' ? new Error('network') : mockState.outcome);
      },
      read: (input: { thread: { threadId: string } }) => {
        mockReads.push(input.thread.threadId);
        const assets = mockHolds.get(input.thread.threadId);
        if (assets === undefined) return Promise.reject(new Error('network'));
        return Promise.resolve({
          status: 'ready',
          episodes: assets.map((assetId) => ({
            assetId,
            assetRevision: 3,
            kind: 'scroll',
            title: 'x',
            state: 'ready',
          })),
        });
      },
    },
  },
} as unknown as AccountScope;
jest.mock('../../providers/account-scope', () => ({
  useAccountScope: () => ({ state: { status: 'signed_in', scope: mockScope } }),
}));
jest.mock('../../platform/command-id', () => ({
  newCommandId: () => jest.requireActual<{ randomUUID: () => string }>('node:crypto').randomUUID(),
}));
const summary = (threadId: string, name: string, state: 'joined' | 'invited') => ({
  thread: { threadId, membershipId: id(2), membershipRevision: 1 },
  name,
  state,
  root: { status: 'unavailable' },
  people: [],
  ownPersonId: id(9),
  latestMessageSequence: 0,
  own: { readThroughSequence: 0 },
  lastActivityAt: '2026-11-01T10:00:00.000Z',
});
const mockInbox = [
  summary(id(1), 'Seasons with Ravi', 'joined'),
  summary(id(3), 'The Moon, with Asha', 'joined'),
  summary(id(5), 'Not yet joined', 'invited'),
];
jest.mock('./use-thread-inbox', () => ({
  useThreadInbox: () => ({ items: mockInbox, loading: false, failed: false, retry: jest.fn() }),
}));

const document = stageDocument as unknown as ScrollDocumentV2;
const scroll = { assetId: ASSET, assetRevision: 3, document } as unknown as OpenedStageScroll;
const readStop = document.stops.find((stop) => stop.kind === 'read')!;
const callStop = document.stops.find((stop) => stop.kind === 'call_it')!;
const here = { ref: mockInbox[0]!.thread, name: 'this thread' };

/** What the API client throws for a problem answer: the real error, made by answering a request with it. */
async function problem(code: ProblemCode): Promise<Error> {
  const details = problemDetails(code);
  const api = createApiClient({
    baseUrl: 'https://app.fixture.test',
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify(details), {
          status: details.status,
          headers: { 'content-type': 'application/problem+json' },
        }),
      ),
  });
  return api.threads
    .send({ version: 'content-thread.v1', commandId: id(30), thread: here.ref, body: { kind: 'text', text: 'x' } })
    .then(
      () => {
        throw new Error('the fixture answer was not a problem');
      },
      (error: unknown) => error as Error,
    );
}

async function show(props: Partial<Parameters<typeof ShareStopSheet>[0]>) {
  const onClose = jest.fn();
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <ShareStopSheet scroll={scroll} stopId={readStop.id} onClose={onClose} {...props} />
    </DisplayProvider>,
  );
  return onClose;
}

beforeEach(() => {
  mockSends.length = 0;
  mockReads.length = 0;
  mockState.outcome = 'ok';
});

describe('Share a moment', () => {
  it('sends the stop into the thread it is read in, as an anchor with a hash and no words', async () => {
    await show({ thread: here });
    const moment = momentOf(document, readStop.id)!;
    expect(await screen.findByTestId('moment-quote')).toHaveTextContent(`“${moment.quote}”`);
    await fireEvent.changeText(screen.getByLabelText('Message (optional)'), '  Does this hold?  ');
    await fireEvent.press(screen.getByRole('button', { name: 'Share this moment' }));
    expect(await screen.findByText('Shared.')).toBeOnTheScreen();
    expect(mockSends).toHaveLength(1);
    const { body } = mockSends[0]!;
    expect(body).toEqual({
      kind: 'snippet',
      target: { assetId: ASSET, assetRevision: 3 },
      anchor: momentAnchorOf(moment),
      note: 'Does this hold?',
    });
    expect(JSON.stringify(body)).not.toContain(moment.quote.slice(0, 15));
  });

  it('offers only the joined threads whose series holds the Scroll, and asks each one once', async () => {
    await show({});
    expect(await screen.findByText('Share into a thread')).toBeOnTheScreen();
    expect(screen.getByText('Seasons with Ravi')).toBeOnTheScreen();
    // A thread about something else would refuse it, an invitation is not a thread the person takes part in yet.
    expect(screen.queryByText('The Moon, with Asha')).toBeNull();
    expect(screen.queryByText('Not yet joined')).toBeNull();
    expect([...mockReads].sort()).toEqual([id(1), id(3)].sort());
    await fireEvent.press(screen.getByRole('button', { name: 'Seasons with Ravi' }));
    expect(await screen.findByText('To · Seasons with Ravi')).toBeOnTheScreen();
    expect(mockSends).toEqual([]);
  });

  it('says plainly when none of the joined threads holds the Scroll, and when a thread could not be asked', async () => {
    mockHolds.delete(id(3));
    mockHolds.set(id(1), [id(41)]);
    try {
      await show({});
      const none = await screen.findByTestId('moment-no-threads');
      expect(none).toHaveTextContent(/None of your threads holds this Scroll/);
      expect(none).toHaveTextContent(/Start one from Share, Explore with friends/);
      expect(none).toHaveTextContent(/One of your threads could not be checked/);
      expect(screen.queryByText('Share into a thread')).toBeNull();
    } finally {
      mockHolds.set(id(1), [id(41), ASSET]);
      mockHolds.set(id(3), [id(42)]);
    }
  });

  it('keeps one command for an unconfirmed send, so sharing again cannot arrive twice', async () => {
    mockState.outcome = 'lost';
    await show({ thread: here });
    await fireEvent.press(await screen.findByRole('button', { name: 'Share this moment' }));
    expect(await screen.findByText('Couldn’t confirm it was shared.')).toBeOnTheScreen();
    mockState.outcome = 'ok';
    await fireEvent.press(screen.getByRole('button', { name: 'Share again' }));
    expect(await screen.findByText('Shared.')).toBeOnTheScreen();
    expect(mockSends).toHaveLength(2);
    expect(new Set(mockSends.map((input) => JSON.stringify(input.body))).size).toBe(1);
  });

  it('says the thread cannot take it when the server refuses the anchor, and not that the Scroll was updated', async () => {
    mockState.outcome = await problem('INVALID_REQUEST');
    await show({ thread: here });
    await fireEvent.press(await screen.findByRole('button', { name: 'Share this moment' }));
    expect(await screen.findByText('This thread can’t take it.', { exact: false })).toBeOnTheScreen();
    expect(
      screen.getByText('doesn’t hold this Scroll, or this stop can’t be shared as a moment.', { exact: false }),
    ).toBeOnTheScreen();
    expect(screen.queryByText('may have been updated', { exact: false })).toBeNull();
  });

  it('shares a read stop only, and says why a call is not offered', async () => {
    await show({ stopId: callStop.id });
    expect(await screen.findByTestId('moment-not-shareable')).toHaveTextContent(/A call would give its answer away/);
    expect(screen.queryByRole('button', { name: 'Share this moment' })).toBeNull();
  });
});
