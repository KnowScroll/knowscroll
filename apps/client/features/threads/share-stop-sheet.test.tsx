import { fireEvent, render, screen } from '@testing-library/react-native';
import stageDocument from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { AccountScope } from '@knowscroll/client-core';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { momentAnchorOf, momentOf } from '@knowscroll/scroll-model';
import { DisplayProvider } from '@knowscroll/ui';
import type { OpenedStageScroll } from '../scroll/scroll-session';
import { ShareStopSheet } from './share-stop-sheet';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const sends: { body: Record<string, unknown> }[] = [];
let sendOutcome: 'ok' | 'lost' = 'ok';
const mockScope = {
  active: true,
  api: {
    threads: {
      send: (input: { body: Record<string, unknown> }) => {
        sends.push(input);
        return sendOutcome === 'ok' ? Promise.resolve({}) : Promise.reject(new Error('network'));
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
const mockThreads = [
  {
    thread: { threadId: id(1), membershipId: id(2), membershipRevision: 1 },
    name: 'Seasons with Ravi',
    state: 'joined',
  },
  { thread: { threadId: id(3), membershipId: id(4), membershipRevision: 1 }, name: 'Not yet', state: 'invited' },
].map((item) => ({
  ...item,
  root: { status: 'unavailable' },
  people: [],
  ownPersonId: id(9),
  latestMessageSequence: 0,
  own: { readThroughSequence: 0 },
  lastActivityAt: '2026-11-01T10:00:00.000Z',
}));
jest.mock('./use-thread-inbox', () => ({
  useThreadInbox: () => ({ items: mockThreads, loading: false, failed: false, retry: jest.fn() }),
}));

const document = stageDocument as unknown as ScrollDocumentV2;
const scroll = { assetId: id(40), assetRevision: 3, document } as unknown as OpenedStageScroll;
const readStop = document.stops.find((stop) => stop.kind === 'read')!;
const callStop = document.stops.find((stop) => stop.kind === 'call_it')!;

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
  sends.length = 0;
  sendOutcome = 'ok';
});

describe('Share a moment', () => {
  it('sends the stop into the thread it is read in, as an anchor with a hash and no words', async () => {
    await show({ thread: { ref: mockThreads[0]!.thread, name: 'this thread' } });
    const moment = momentOf(document, readStop.id)!;
    expect(await screen.findByTestId('moment-quote')).toHaveTextContent(`“${moment.quote}”`);
    await fireEvent.changeText(screen.getByLabelText('Message (optional)'), '  Does this hold?  ');
    await fireEvent.press(screen.getByRole('button', { name: 'Share this moment' }));
    expect(await screen.findByText('Shared.')).toBeOnTheScreen();
    expect(sends).toHaveLength(1);
    const { body } = sends[0]!;
    expect(body).toEqual({
      kind: 'snippet',
      target: { assetId: scroll.assetId, assetRevision: 3 },
      anchor: momentAnchorOf(moment),
      note: 'Does this hold?',
    });
    expect(JSON.stringify(body)).not.toContain(moment.quote.slice(0, 15));
  });

  it('asks which thread when it is read outside one, and offers only the threads the person has joined', async () => {
    await show({});
    expect(await screen.findByText('Share into a thread')).toBeOnTheScreen();
    expect(screen.getByText('Seasons with Ravi')).toBeOnTheScreen();
    expect(screen.queryByText('Not yet')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Seasons with Ravi' }));
    expect(await screen.findByText('To · Seasons with Ravi')).toBeOnTheScreen();
    expect(sends).toEqual([]);
  });

  it('keeps one command for an unconfirmed send, so sharing again cannot arrive twice', async () => {
    sendOutcome = 'lost';
    await show({ thread: { ref: mockThreads[0]!.thread, name: 'this thread' } });
    await fireEvent.press(await screen.findByRole('button', { name: 'Share this moment' }));
    expect(await screen.findByText('Couldn’t confirm it was shared.')).toBeOnTheScreen();
    sendOutcome = 'ok';
    await fireEvent.press(screen.getByRole('button', { name: 'Share again' }));
    expect(await screen.findByText('Shared.')).toBeOnTheScreen();
    const commands = sends.map((input) => JSON.stringify(input.body));
    expect(new Set(commands).size).toBe(1);
  });

  it('shares a read stop only: a call would give its answer away', async () => {
    await show({ stopId: callStop.id });
    expect(await screen.findByText(/Only a reading stop can be shared as a moment/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Share this moment' })).toBeNull();
  });
});
