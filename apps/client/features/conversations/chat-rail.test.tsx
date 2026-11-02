import { fireEvent, render, screen } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { ChatRail } from './chat-rail';
import type { SharedHere } from './shared-here';

const peer = {
  kind: 'person' as const,
  personId: '0199a000-0000-7000-8000-000000000002',
  handle: 'ci.ravi',
  displayName: 'Ravi',
};
const card: SharedHere = {
  messageId: '0199a000-0000-7000-8000-000000000101',
  title: 'Why the Moon and Sun make tides',
  kind: 'scroll',
  by: 'Ravi',
  at: new Date('2026-10-26T08:00:00.000Z'),
};
const inDisplay = (node: React.ReactElement) => (
  <DisplayProvider value={{ width: 1440, textScale: 1, reducedMotion: true }}>{node}</DisplayProvider>
);

describe('the "In this chat" rail', () => {
  it('names the person, lists what was shared here, and starts a thread from it', async () => {
    const onStartThread = jest.fn();
    const onVisit = jest.fn();
    await render(
      inDisplay(<ChatRail peer={peer} shared={[card]} complete onVisit={onVisit} onStartThread={onStartThread} />),
    );
    expect(screen.getByTestId('chat-rail')).toBeOnTheScreen();
    expect(screen.getByText('Ravi')).toBeOnTheScreen();
    expect(screen.getByText('SHARED HERE · 1')).toBeOnTheScreen();
    expect(screen.getByText('Why the Moon and Sun make tides')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Start a thread from this' }));
    expect(onStartThread).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Visit Ravi’s universe' }));
    expect(onVisit).toHaveBeenCalledTimes(1);
  });

  it('gives no count and never says nothing was shared while older messages are still unread', async () => {
    await render(
      inDisplay(<ChatRail peer={peer} shared={[]} complete={false} onVisit={undefined} onStartThread={undefined} />),
    );
    expect(screen.getByText('SHARED HERE')).toBeOnTheScreen();
    expect(screen.getByText('None in the recent messages.')).toBeOnTheScreen();
    expect(screen.queryByText(/Nothing has been shared/)).toBeNull();
    expect(screen.queryByText(/SHARED HERE ·/)).toBeNull();
  });

  it('offers no thread when nothing can be one, and says plainly that nothing was shared', async () => {
    await render(
      inDisplay(<ChatRail peer={peer} shared={[]} complete onVisit={undefined} onStartThread={undefined} />),
    );
    expect(screen.getByTestId('shared-here-empty')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Start a thread from this' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Visit/ })).toBeNull();
  });
});
