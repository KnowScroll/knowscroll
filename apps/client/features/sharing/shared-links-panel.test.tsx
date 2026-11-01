import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { createShareSession } from '@knowscroll/client-core';
import { id, talkServer } from '@knowscroll/client-core/talk-fixture';
import { DisplayProvider } from '@knowscroll/ui';
import { SharedLinksPanel } from './shared-links-panel';

jest.mock('../../platform/command-id', () => ({
  newCommandId: () => jest.requireActual<{ randomUUID: () => string }>('node:crypto').randomUUID(),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve(true)) }));

describe('links you’ve shared (labelled in-memory server)', () => {
  it('says so when there are none', async () => {
    const server = talkServer();
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <SharedLinksPanel scope={server.scope} />
      </DisplayProvider>,
    );
    expect(await screen.findByText(/You haven’t shared any links/)).toBeOnTheScreen();
    await screen.unmount();
    server.scope.end();
  });

  it('says the account is being cleared, not that the links could not load, and reads them again when it is done', async () => {
    const server = talkServer();
    await createShareSession({
      scope: server.scope,
      target: { assetId: id(40), assetRevision: 1 },
      origin: 'https://app.fixture.test',
      newId: () => jest.requireActual<{ randomUUID: () => string }>('node:crypto').randomUUID(),
      copyText: () => Promise.resolve(),
    }).copyLink();
    server.failNext('/v1/social/content-shares/list', 'network');
    const clear = { title: 'Clearing', text: 'Your exploration history and universe are being removed.' };
    const asked = jest.fn();
    const view = (progress: typeof clear | undefined) => (
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <SharedLinksPanel scope={server.scope} clear={progress} onLoadFailed={asked} />
      </DisplayProvider>
    );
    const rendered = await render(view(clear));
    expect(await screen.findByText('Clearing exploration.')).toBeOnTheScreen();
    expect(screen.getByText(/being removed. Your links are back when it is done./)).toBeOnTheScreen();
    expect(screen.queryByText('Couldn’t load your links.')).toBeNull();
    expect(asked).toHaveBeenCalled();
    await rendered.rerender(view(undefined));
    expect(await screen.findByText('What one answer costs to serve')).toBeOnTheScreen();
    expect(screen.queryByText('Clearing exploration.')).toBeNull();
    await screen.unmount();
    server.scope.end();
  });

  it('still says the links could not load when no Clear is the reason', async () => {
    const server = talkServer();
    server.failNext('/v1/social/content-shares/list', 'network');
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <SharedLinksPanel scope={server.scope} />
      </DisplayProvider>,
    );
    expect(await screen.findByText('Couldn’t load your links.')).toBeOnTheScreen();
    await screen.unmount();
    server.scope.end();
  });

  it('lists a live link with its title and stops it', async () => {
    const server = talkServer();
    await createShareSession({
      scope: server.scope,
      target: { assetId: id(40), assetRevision: 1 },
      origin: 'https://app.fixture.test',
      newId: () => jest.requireActual<{ randomUUID: () => string }>('node:crypto').randomUUID(),
      copyText: () => Promise.resolve(),
    }).copyLink();
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <SharedLinksPanel scope={server.scope} />
      </DisplayProvider>,
    );
    expect(await screen.findByText('What one answer costs to serve')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Stop sharing' }));
    await waitFor(() => expect(screen.queryByText('What one answer costs to serve')).toBeNull());
    expect(server.sharesOf().every(([, share]) => share.revoked)).toBe(true);
    await screen.unmount();
    server.scope.end();
  });
});
