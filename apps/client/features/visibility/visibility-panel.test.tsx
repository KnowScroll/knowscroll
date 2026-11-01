import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { friend, id, visitServer } from '@knowscroll/client-core/visit-fixture';
import { DisplayProvider } from '@knowscroll/ui';
import { VisibilityPanel } from './visibility-panel';

jest.mock('../../platform/command-id', () => {
  let next = 50000;
  return { newCommandId: () => `0199a000-0000-7000-8000-${(next++).toString(16).padStart(12, '0')}` };
});

const panel = (server: ReturnType<typeof visitServer>) => (
  <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
    <VisibilityPanel scope={server.scope} />
  </DisplayProvider>
);
const commandsTo = (server: ReturnType<typeof visitServer>, path: string) =>
  server.requests.filter((request) => request.path === path && 'commandId' in request.body);
const checkedOf = (element: ReturnType<typeof screen.getByRole>) =>
  (element.props as { accessibilityState: { checked: boolean } }).accessibilityState.checked;
const checked = (name: string, role: 'radio' | 'switch') => checkedOf(screen.getByRole(role, { name }));

describe('sharing and visibility settings (labelled in-memory server)', () => {
  it('starts with nothing shared: nobody may visit, no system is shared and availability is hidden', async () => {
    const server = visitServer();
    const rendered = await render(panel(server));
    await screen.findByRole('radio', { name: 'Nobody' });
    expect(checked('Nobody', 'radio')).toBe(true);
    expect(checked('Friends I choose', 'radio')).toBe(false);
    expect(checked('All friends', 'radio')).toBe(false);
    expect(checked('Earth and climate', 'switch')).toBe(false);
    expect(screen.getAllByText('Private · not shown to visitors')).toHaveLength(2);
    expect(checked('Don’t show', 'radio')).toBe(true);
    expect(commandsTo(server, '/v1/social/visibility')).toHaveLength(0);
    await rendered.unmount();
    server.scope.end();
  });

  it('says what a change means: it applies at once, and what was seen cannot be taken back', async () => {
    const server = visitServer();
    const rendered = await render(panel(server));
    await screen.findByRole('radio', { name: 'Nobody' });
    expect(screen.getByText(/can’t\s+be taken back/)).toBeOnTheScreen();
    expect(screen.getByText(/Never shows what you’re watching/)).toBeOnTheScreen();
    expect(screen.getByText(/Regions are never shared/)).toBeOnTheScreen();
    await rendered.unmount();
    server.scope.end();
  });

  it('shares a system with all friends as one saved command, and shows Saved', async () => {
    const server = visitServer();
    const rendered = await render(panel(server));
    await fireEvent.press(await screen.findByRole('radio', { name: 'All friends' }));
    await fireEvent.press(screen.getByRole('switch', { name: 'Earth and climate' }));
    await waitFor(() => expect(checked('Earth and climate', 'switch')).toBe(true));
    expect(screen.getByText('Shared · visitors see its planets')).toBeOnTheScreen();
    await screen.findByText(/Saved\./);
    const last = commandsTo(server, '/v1/social/visibility').at(-1);
    expect(last?.body).toMatchObject({ audience: { mode: 'all_friends' }, sharedSystemIds: [id(100)] });
    expect(checked('All friends', 'radio')).toBe(true);
    await rendered.unmount();
    server.scope.end();
  });

  it('lists friends to choose from under "Friends I choose", and shares with only the ticked ones', async () => {
    const server = visitServer();
    const rendered = await render(panel(server));
    await fireEvent.press(await screen.findByRole('radio', { name: 'Friends I choose' }));
    await fireEvent.press(await screen.findByRole('switch', { name: 'Ravi fixture' }));
    await waitFor(() =>
      expect(commandsTo(server, '/v1/social/visibility').at(-1)?.body).toMatchObject({
        audience: { mode: 'chosen_friends', personIds: [friend.personId] },
      }),
    );
    expect(checkedOf(screen.getByRole('switch', { name: 'Meera fixture' }))).toBe(false);
    await rendered.unmount();
    server.scope.end();
  });

  it('offers Retry when a save gets no answer, and leaves the page as the person set it', async () => {
    const server = visitServer();
    const rendered = await render(panel(server));
    await screen.findByRole('radio', { name: 'Nobody' });
    server.failNext('/v1/social/visibility', 'network');
    await fireEvent.press(screen.getByRole('switch', { name: 'Space' }));
    await screen.findByText('Couldn’t save.');
    expect(checked('Space', 'switch')).toBe(true);
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText(/Saved\./);
    expect(server.own.systems.find((system) => system.systemId === id(101))?.shared).toBe(true);
    await rendered.unmount();
    server.scope.end();
  });

  it('changes availability on its own, and never from a heartbeat', async () => {
    const server = visitServer();
    const rendered = await render(panel(server));
    await fireEvent.press(await screen.findByRole('radio', { name: 'Recently active' }));
    await waitFor(() => expect(checked('Recently active', 'radio')).toBe(true));
    expect(server.presence.preference).toBe('recently_active');
    expect(commandsTo(server, '/v1/social/visibility')).toHaveLength(0);
    await rendered.unmount();
    server.scope.end();
  });

  it('starts with SEEN on, turns it off with its own command, and says it works both ways', async () => {
    const server = visitServer();
    const rendered = await render(panel(server));
    await screen.findByRole('switch', { name: 'Show SEEN in direct conversations' });
    expect(checked('Show SEEN in direct conversations', 'switch')).toBe(true);
    expect(screen.getByText(/If you hide yours, you won’t see theirs/)).toBeOnTheScreen();
    expect(screen.getByText(/never in threads or rooms/)).toBeOnTheScreen();
    expect(commandsTo(server, '/v1/social/read-receipts')).toHaveLength(0);
    await fireEvent.press(screen.getByRole('switch', { name: 'Show SEEN in direct conversations' }));
    await waitFor(() => expect(checked('Show SEEN in direct conversations', 'switch')).toBe(false));
    expect(server.readReceipts).toEqual({ shared: false, revision: 2 });
    expect(
      screen.getByText(/What you read while it’s off stays unseen, even if you turn it on later/),
    ).toBeOnTheScreen();
    // The audience and the availability choice were not touched.
    expect(commandsTo(server, '/v1/social/visibility')).toHaveLength(0);
    expect(commandsTo(server, '/v1/social/presence/preference')).toHaveLength(0);
    await fireEvent.press(screen.getByRole('switch', { name: 'Show SEEN in direct conversations' }));
    await waitFor(() => expect(server.readReceipts).toEqual({ shared: true, revision: 3 }));
    await rendered.unmount();
    server.scope.end();
  });

  it('says the account is being cleared, not that the settings could not load, and loads them when it is done', async () => {
    const server = visitServer();
    server.failNext('/v1/social/visibility', 'network');
    const clear = { title: 'Clearing', text: 'Your exploration history and universe are being removed.' };
    const view = (progress: typeof clear | undefined) => (
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <VisibilityPanel scope={server.scope} clear={progress} />
      </DisplayProvider>
    );
    const rendered = await render(view(clear));
    await screen.findByText('Clearing exploration.');
    expect(screen.getByText(/Your sharing settings are back when it is done./)).toBeOnTheScreen();
    expect(screen.queryByText('Couldn’t load your settings.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await rendered.rerender(view(undefined));
    await screen.findByRole('radio', { name: 'Nobody' });
    expect(screen.queryByText('Clearing exploration.')).toBeNull();
    await rendered.unmount();
    server.scope.end();
  });

  it('says it could not load rather than showing switches that are not there', async () => {
    const server = visitServer();
    server.failNext('/v1/social/visibility', 'network');
    const rendered = await render(panel(server));
    await screen.findByText('Couldn’t load your settings.');
    expect(screen.queryByRole('radio', { name: 'Nobody' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('radio', { name: 'Nobody' });
    await rendered.unmount();
    server.scope.end();
  });
});
