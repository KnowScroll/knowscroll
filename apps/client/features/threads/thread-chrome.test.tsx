import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ContentThreadState } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { InvitationView, ThreadHeader, ThreadPeople, ThreadStrip, threadEyebrow, threadTitle } from './thread-chrome';

const asha = {
  kind: 'person' as const,
  personId: '0199a000-0000-7000-8000-00000000000a',
  handle: 'ci.asha',
  displayName: 'Asha',
};
const root = {
  status: 'available' as const,
  target: { assetId: '0199a000-0000-7000-8000-000000000001', assetRevision: 1 },
  metadata: { kind: 'reel' as const, title: 'The edge', summary: 'Past this line.', language: 'en' },
};
const state = (patch: Partial<ContentThreadState>): ContentThreadState => ({
  phase: 'invitation',
  name: undefined,
  root,
  participants: [],
  sequence: 'single',
  episodes: [],
  invitedBy: asha,
  messages: [],
  outgoing: [],
  hasOlder: false,
  loadingOlder: false,
  offline: false,
  awayAfterSequence: undefined,
  responding: false,
  ...patch,
});

async function show(thread: ContentThreadState) {
  const onJoin = jest.fn();
  const onDecline = jest.fn();
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <InvitationView state={thread} onJoin={onJoin} onDecline={onDecline} />
    </DisplayProvider>,
  );
  return { onJoin, onDecline };
}

describe('a thread invitation', () => {
  it('says who invited and what it is about, and promises nothing about what is seen', async () => {
    const { onJoin, onDecline } = await show(state({}));
    expect(screen.getByText('Asha invited you to explore this')).toBeOnTheScreen();
    expect(screen.getByText('The edge')).toBeOnTheScreen();
    expect(screen.getByText(/Joining does not tell anyone what you have seen/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Join this thread' }));
    expect(onJoin).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Ignore' }));
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it('still lets the person join when the content is gone', async () => {
    await show(state({ root: { status: 'unavailable', target: root.target } }));
    expect(
      screen.getByText(/This isn’t available any more, but you can still join the conversation/),
    ).toBeOnTheScreen();
  });

  it('is titled by the name its starter gave, else by what it is about', () => {
    expect(threadTitle({ name: 'Black holes', root })).toBe('Black holes');
    expect(threadTitle({ name: undefined, root })).toBe('The edge');
    expect(threadTitle({ name: undefined, root: undefined })).toBe('Shared thread');
  });
});

describe('the thread header', () => {
  const header = async (onMap?: () => void) => {
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <ThreadHeader title="Black holes" people="Asha, Ravi" onBack={jest.fn()} onMap={onMap} onMenu={jest.fn()} />
      </DisplayProvider>,
    );
  };

  it('offers the map only once there is one to open', async () => {
    await header(undefined);
    expect(screen.queryByRole('button', { name: 'Map' })).toBeNull();
  });

  it('opens the map from its own button', async () => {
    const onMap = jest.fn();
    await header(onMap);
    await fireEvent.press(screen.getByRole('button', { name: 'Map' }));
    expect(onMap).toHaveBeenCalledTimes(1);
  });
});

describe('the thread strip', () => {
  const strip = async (series?: { open: boolean; onPress: () => void }, onMenu = jest.fn()) => {
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <ThreadStrip
          title="Black holes"
          eyebrow="A THREAD · 3 PARTS · 2 PEOPLE"
          onBack={jest.fn()}
          series={series}
          onMenu={onMenu}
        />
      </DisplayProvider>,
    );
    return onMenu;
  };

  it('says what it is above the title, with the title as the page heading', async () => {
    await strip();
    expect(screen.getByText('A THREAD · 3 PARTS · 2 PEOPLE')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Black holes' })).toBeOnTheScreen();
  });

  it('pulls the parts down from its Series button, and only where the parts are not always shown', async () => {
    const onPress = jest.fn();
    await strip({ open: false, onPress });
    await fireEvent.press(screen.getByRole('button', { name: 'Series' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('has no Series button beside the conversation, and keeps the options', async () => {
    const onMenu = await strip();
    expect(screen.queryByRole('button', { name: 'Series' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Thread options' }));
    expect(onMenu).toHaveBeenCalledTimes(1);
  });

  it('counts parts in a declared series and items in any other thread', () => {
    const participants = [{}, {}] as never;
    expect(threadEyebrow({ sequence: 'series', episodes: [{}, {}, {}] as never, participants }, true)).toBe(
      'A THREAD · 3 PARTS · 2 PEOPLE',
    );
    expect(threadEyebrow({ sequence: 'series', episodes: [{}, {}, {}] as never, participants }, false)).toBe(
      'A THREAD · 3 PARTS',
    );
    expect(threadEyebrow({ sequence: 'single', episodes: [{}] as never, participants: [{}] as never }, true)).toBe(
      'A THREAD · 1 ITEM · 1 PERSON',
    );
    expect(threadEyebrow({ sequence: 'single', episodes: [], participants: [] }, true)).toBe('A THREAD');
  });
});

describe('the people in a thread', () => {
  it('lists names only, the starter and the invited marked, and says nobody sees anyone’s place', async () => {
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <ThreadPeople
          participants={[
            { person: asha, role: 'starter', joined: true, you: true },
            {
              person: {
                ...asha,
                personId: '0199a000-0000-7000-8000-00000000000b',
                displayName: 'Ravi',
                handle: 'ci.ravi',
              },
              role: 'member',
              joined: false,
              you: false,
            },
          ]}
        />
      </DisplayProvider>,
    );
    expect(screen.getByText('Asha (you)')).toBeOnTheScreen();
    expect(screen.getByText('Started it')).toBeOnTheScreen();
    expect(screen.getByText('Invited')).toBeOnTheScreen();
    expect(screen.getByText(/Nobody sees where anyone else is/)).toBeOnTheScreen();
  });
});
