import { fireEvent, render, screen } from '@testing-library/react-native';
import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import type { ThreadEpisode } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { ThreadEncounter } from './thread-encounter';

// The real component with the router as a stand-in: only what Read does is under test.
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }), useIsFocused: () => true }));

const scope = createAccountScope({
  account: {
    accountId: '0199a000-0000-7000-8000-000000000001',
    universeId: '0199a000-0000-7000-8000-000000000002',
    privacyEpoch: 1,
    email: 'encounter@threads.test',
  },
  baseUrl: 'https://encounter.threads.test',
  authorization: () => undefined,
  store: memoryStore(),
  fetch: () => Promise.resolve(new Response('{}', { status: 404 })),
});

const episode: ThreadEpisode = {
  assetId: '0199a000-0000-7000-8000-000000000301',
  assetRevision: 1,
  kind: 'scroll',
  part: 2,
  title: 'CI part 2',
  state: 'ready',
  visited: false,
};

function show(onPlace: jest.Mock, folded: boolean) {
  return render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <ThreadEncounter
        scope={scope}
        readHref={(assetId) => `/threads/fixture/read/${assetId}`}
        episode={episode}
        series
        total={3}
        folded={folded}
        onToggleFold={() => undefined}
        onShareMoment={() => undefined}
        paused={false}
        positionRef={{ current: null }}
        onPlace={onPlace}
        dock
      />
    </DisplayProvider>,
  );
}

describe('a Scroll in the thread’s player', () => {
  afterEach(() => mockPush.mockClear());

  it('opens the thread’s reader when Read is pressed and tells the thread nothing: the reader tells once it has opened', async () => {
    const onPlace = jest.fn();
    await show(onPlace, true);
    await fireEvent.press(screen.getByRole('button', { name: 'Read' }));
    expect(mockPush).toHaveBeenCalledWith(`/threads/fixture/read/${episode.assetId}`);
    expect(onPlace).not.toHaveBeenCalled();
  });

  it('does the same from the open player’s Read this Scroll', async () => {
    const onPlace = jest.fn();
    await show(onPlace, false);
    await fireEvent.press(screen.getByRole('button', { name: 'Read this Scroll' }));
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(onPlace).not.toHaveBeenCalled();
  });
});
