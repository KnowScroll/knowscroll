import type * as React from 'react';
import type * as ReactNative from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { AccountScope, ContentThreadState, ScenarioBoardState } from '@knowscroll/client-core';
import type { ScenarioCard } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { BranchScreen } from './branch-screen';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const mockBack = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useRouter: () => ({ back: mockBack, replace: mockReplace, push: jest.fn(), canGoBack: () => true }),
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});
const stored = new Map<string, string>();
const mockScope = {
  active: true,
  storage: {
    get: (key: string) => stored.get(key),
    set: (key: string, value: string) => void stored.set(key, value),
    remove: (key: string) => void stored.delete(key),
  },
} as unknown as AccountScope;
jest.mock('../../providers/account-scope', () => ({
  useAccountScope: () => ({ state: { status: 'signed_in', scope: mockScope }, manager: { refresh: jest.fn() } }),
}));
let mockBoard: Pick<ScenarioBoardState, 'cards' | 'phase' | 'suggestions'> = {
  cards: [],
  phase: 'ready',
  suggestions: [],
};
const mockLoad = jest.fn();
const mockRefresh = jest.fn();
jest.mock('./use-scenarios', () => ({
  useScenarioBoard: () => ({ controller: { load: mockLoad }, state: mockBoard }),
  useScenarioComposer: jest.fn(),
}));
let mockThreadPhase: ContentThreadState['phase'] = 'ready';
const mockThread = {
  name: undefined,
  root: {
    status: 'available',
    target: { assetId: '0199a000-0000-7000-8000-0000000000a1', assetRevision: 1 },
    metadata: { kind: 'scroll', title: 'Black holes', summary: '', language: 'en' },
  },
  participants: [{ you: true, person: { personId: '0199a000-0000-7000-8000-00000000000a' } }],
  episodes: [
    { assetId: id(0xa1), kind: 'scroll', part: 1, title: 'The edge', state: 'available', visited: false },
    { assetId: id(0xa2), kind: 'scroll', part: 2, title: 'Falling in', state: 'available', visited: false },
  ],
} as unknown as ContentThreadState;
jest.mock('../threads/use-content-thread', () => ({
  useContentThread: () => ({ controller: { refresh: mockRefresh }, state: { ...mockThread, phase: mockThreadPhase } }),
}));
jest.mock('../threads/scroll-open', () => {
  const { Text } = jest.requireActual<typeof ReactNative>('react-native');
  return {
    OpenScroll: ({ assetId, children }: { assetId: string; children: (scroll: unknown) => React.ReactNode }) => (
      <>
        <Text>{`Scroll ${assetId}`}</Text>
        {children({})}
      </>
    ),
    ThreadScrollArticle: ({ chrome, endSlot }: { chrome: string; endSlot?: React.ReactNode }) => (
      <>
        <Text>{`Article, chrome ${chrome}`}</Text>
        {endSlot}
      </>
    ),
  };
});

const asha = { kind: 'person' as const, personId: id(0xa), handle: 'ci.asha', displayName: 'Asha' };
const card = (patch: Partial<ScenarioCard> = {}): ScenarioCard => ({
  nodeId: id(9),
  kind: 'what_if',
  origin: 'root',
  title: 'a black hole were a portal',
  changes: [{ subject: 'Black hole', statement: 'A black hole is a portal' }],
  kept: [],
  hypothetical: true,
  speculative: false,
  assumptions: [{ subject: 'Black hole', statement: 'A black hole is a portal' }],
  startedBy: asha,
  status: 'ready',
  revision: 1,
  createdAt: '2026-10-24T10:00:00.000Z',
  content: { kind: 'scroll', assetId: id(0xb1), assetRevision: 1, title: 'A portal' },
  ...patch,
});

async function open(cards: ScenarioCard[], phase: ScenarioBoardState['phase'] = 'ready') {
  mockBoard = { cards, phase, suggestions: [] };
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <BranchScreen threadId={id(1)} nodeId={id(9)} m={id(2)} r="1" />
    </DisplayProvider>,
  );
}

afterEach(() => {
  mockThreadPhase = 'ready';
  mockLoad.mockClear();
  mockRefresh.mockClear();
  stored.clear();
  mockBack.mockClear();
  mockReplace.mockClear();
});

describe('a branch opened from its card or the map', () => {
  it('shows the thread, what the branch is, its one item, and the way back naming where it goes', async () => {
    stored.set(`thread.selected.${id(1)}`, id(0xa2));
    await open([card()]);
    expect(screen.getByRole('header', { name: 'Black holes' })).toBeOnTheScreen();
    expect(screen.getByText('What if · a black hole were a portal')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Back to Black holes, Part 2' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Item 1, current')).toBeOnTheScreen();
    expect(screen.getByText(`Scroll ${id(0xb1)}`)).toBeOnTheScreen();
    expect(screen.getByText('Article, chrome own')).toBeOnTheScreen();
    expect(screen.queryByText(/Speculative/)).toBeNull();
  });

  it('marks the member as in this branch on this device, and goes back on the return chip', async () => {
    await open([card()]);
    expect(stored.get(`thread.here.${id(1)}`)).toBe(id(9));
    await fireEvent.press(screen.getByRole('button', { name: /^Back to Black holes/ }));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('offers the map once the thread has several branches, with the member’s place on this one', async () => {
    await open([card()]);
    expect(screen.queryByRole('button', { name: 'Map' })).toBeNull();
    await screen.unmount();
    await open([card(), card({ nodeId: id(10), title: 'the Moon were larger', kind: 'perspective' })]);
    await fireEvent.press(screen.getByRole('button', { name: 'Map' }));
    expect(await screen.findByText('Map of this thread')).toBeOnTheScreen();
    expect(screen.getAllByLabelText('You are here')).toHaveLength(1);
    expect(screen.getByLabelText(/^What if · a black hole were a portal.*you are here/)).toBeOnTheScreen();
  });

  it('says a speculative branch is, in words, over its Scroll', async () => {
    await open([card({ speculative: true })]);
    expect(screen.getByText('Speculative scenario · not established science')).toBeOnTheScreen();
  });

  it('offers another assumption from here, and can be put away', async () => {
    await open([card()]);
    expect(screen.getByLabelText('Try another assumption')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByLabelText('Try another assumption')).toBeNull();
  });

  it('says a branch still being prepared is, and only offers the way back', async () => {
    await open([card({ status: 'preparing', content: undefined })]);
    expect(screen.getByText('Preparing the first Scroll')).toBeOnTheScreen();
    expect(screen.getByLabelText('Item 1, preparing')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Try another assumption')).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Back to Black holes/ }).length).toBeGreaterThan(0);
  });

  it('says a branch was removed only when it is there and its card says removed, and shows nothing it said', async () => {
    await open([card({ status: 'removed', content: undefined, title: 'Removed', changes: [], assumptions: [] })]);
    expect(screen.getByText('This branch was removed')).toBeOnTheScreen();
    expect(screen.queryByText(/black hole were a portal/)).toBeNull();
    expect(screen.queryByLabelText(/^Item 1/)).toBeNull();
  });

  it('says an unknown branch, or one the member cannot see, is not available, and never that it was removed', async () => {
    await open([]);
    expect(screen.getByText('This branch isn’t available')).toBeOnTheScreen();
    expect(screen.queryByText(/removed/)).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Back to the thread' }));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('says the thread is not available, as the thread’s own address does, when the member cannot open it', async () => {
    mockThreadPhase = 'unavailable';
    await open([card()]);
    expect(screen.getByText('This thread isn’t available')).toBeOnTheScreen();
    expect(screen.queryByText(/removed/)).toBeNull();
    expect(screen.queryByText(/black hole were a portal/)).toBeNull();
    await fireEvent.press(screen.getByRole('link', { name: 'Back to Talk' }));
    expect(mockReplace).toHaveBeenCalledWith('/conversations');
  });

  it('says the same when the branches say the member has no place in the thread', async () => {
    await open([], 'unavailable');
    expect(screen.getByText('This thread isn’t available')).toBeOnTheScreen();
    expect(screen.queryByText(/removed/)).toBeNull();
  });

  it('says it could not open the branch when a read failed, offers to try again, and says nothing of the branch', async () => {
    await open([], 'failed');
    expect(screen.getByText('Can’t open this branch')).toBeOnTheScreen();
    expect(screen.queryByText(/removed/)).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('says the same when it is the thread that could not be read', async () => {
    mockThreadPhase = 'failed';
    await open([card()]);
    expect(screen.getByText('Can’t open this branch')).toBeOnTheScreen();
  });

  it('waits for the thread and its branches to be read before saying anything is missing', async () => {
    await open([], 'loading');
    expect(screen.getByLabelText('Opening the branch')).toBeOnTheScreen();
    await screen.unmount();
    mockThreadPhase = 'loading';
    await open([card()]);
    expect(screen.getByLabelText('Opening the branch')).toBeOnTheScreen();
    expect(screen.queryByText(/black hole were a portal/)).toBeNull();
  });
});
