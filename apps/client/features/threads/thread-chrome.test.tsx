import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ContentThreadState } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { InvitationView, threadTitle } from './thread-chrome';

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
    await fireEvent.press(screen.getByRole('button', { name: 'Not now' }));
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it('still lets the person join when the content is gone', async () => {
    await show(state({ root: { status: 'unavailable', target: root.target } }));
    expect(
      screen.getByText(/This isn’t available any more, but you can still join the conversation/),
    ).toBeOnTheScreen();
  });

  it('is titled by the name its starter gave, else by what it is about', async () => {
    expect(threadTitle({ name: 'Black holes', root })).toBe('Black holes');
    expect(threadTitle({ name: undefined, root })).toBe('The edge');
    expect(threadTitle({ name: undefined, root: undefined })).toBe('Shared thread');
  });
});
