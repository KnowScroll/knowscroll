import type * as React from 'react';
import * as Clipboard from 'expo-clipboard';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { conversation, createdThread, id, peer, talkServer } from '@knowscroll/client-core/talk-fixture';
import { DisplayProvider } from '@knowscroll/ui';
import { ShareSheetContent, type ShareSheetContentProps } from './share-sheet-content';

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return { useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]) };
});
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve(true)) }));
jest.mock('../../platform/command-id', () => ({
  newCommandId: () => jest.requireActual<{ randomUUID: () => string }>('node:crypto').randomUUID(),
}));

const target = { assetId: id(40), assetRevision: 2 };

async function open(server: ReturnType<typeof talkServer>, extra: Partial<ShareSheetContentProps> = {}) {
  const onClose = jest.fn();
  const onOpenConversation = jest.fn();
  const onOpenThread = jest.fn();
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <ShareSheetContent
        scope={server.scope}
        target={target}
        title="The edge you can’t come back from"
        kind="reel"
        origin="https://app.fixture.test"
        onClose={onClose}
        onOpenConversation={onOpenConversation}
        onOpenThread={onOpenThread}
        {...extra}
      />
    </DisplayProvider>,
  );
  return { onClose, onOpenConversation, onOpenThread };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('share sheet (labelled in-memory server)', () => {
  it('offers send, explore and copy', async () => {
    const server = talkServer();
    await open(server);
    expect(screen.getByRole('button', { name: 'Send to a conversation' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Explore with friends' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Copy link / Share elsewhere' })).toBeOnTheScreen();
    await screen.unmount();
    server.scope.end();
  });

  it('creates a thread with the chosen friends and shows it only after the receipt, then opens it', async () => {
    const server = talkServer();
    const { onOpenThread } = await open(server);
    await fireEvent.press(screen.getByRole('button', { name: 'Explore with friends' }));
    expect(screen.getByRole('button', { name: 'Choose friends' })).toBeDisabled();
    await fireEvent.press(await screen.findByRole('checkbox', { name: peer.displayName }));
    await fireEvent.changeText(screen.getByLabelText('Thread name (optional)'), 'Black holes');
    await fireEvent.press(screen.getByRole('button', { name: 'Create thread · 1 friend' }));
    expect(await screen.findByText('Thread created')).toBeOnTheScreen();
    const create = server.requests.find((request) => request.path.endsWith('/threads/create'));
    expect(create?.body).toMatchObject({ root: target, friendPersonIds: [peer.personId], name: 'Black holes' });
    await fireEvent.press(screen.getByRole('button', { name: 'Open thread' }));
    expect(onOpenThread).toHaveBeenCalledWith(createdThread);
    await screen.unmount();
    server.scope.end();
  });

  it('keeps Retry for an unknown outcome and creates the thread once', async () => {
    const server = talkServer();
    await open(server);
    await fireEvent.press(screen.getByRole('button', { name: 'Explore with friends' }));
    await fireEvent.press(await screen.findByRole('checkbox', { name: peer.displayName }));
    server.failNext('/v1/social/threads/create', 'lost_response');
    await fireEvent.press(screen.getByRole('button', { name: 'Create thread · 1 friend' }));
    expect(await screen.findByText('Couldn’t confirm it was created.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Thread created')).toBeOnTheScreen();
    const creates = server.requests.filter((request) => request.path.endsWith('/threads/create'));
    expect(creates).toHaveLength(2);
    expect(creates[0]?.body['commandId']).toBe(creates[1]?.body['commandId']);
    await screen.unmount();
    server.scope.end();
  });

  it('sends the card to a friend and shows Sent only after the receipt, then opens the chat', async () => {
    const server = talkServer();
    const { onOpenConversation } = await open(server);
    await fireEvent.press(screen.getByRole('button', { name: 'Send to a conversation' }));
    await fireEvent.press(await screen.findByRole('radio', { name: peer.displayName }));
    await fireEvent.changeText(screen.getByLabelText('Add a note (optional)'), 'This is the bit I meant');
    await fireEvent.press(screen.getByRole('button', { name: `Send to ${peer.displayName}` }));
    expect(await screen.findByText(`Sent to ${peer.displayName}`)).toBeOnTheScreen();
    const send = server.requests.find((request) => request.path.endsWith('/conversations/send'));
    expect(send?.body['body']).toEqual({ kind: 'content', target, note: 'This is the bit I meant' });
    await fireEvent.press(screen.getByRole('button', { name: 'Open chat' }));
    expect(onOpenConversation).toHaveBeenCalledWith(conversation);
    await screen.unmount();
    server.scope.end();
  });

  it('keeps Retry for an unknown outcome and sends the same message once', async () => {
    const server = talkServer();
    await open(server);
    await fireEvent.press(screen.getByRole('button', { name: 'Send to a conversation' }));
    await fireEvent.press(await screen.findByRole('radio', { name: peer.displayName }));
    server.failNext('/v1/social/conversations/send', 'lost_response');
    await fireEvent.press(screen.getByRole('button', { name: `Send to ${peer.displayName}` }));
    expect(await screen.findByText('Couldn’t confirm it was sent.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(`Sent to ${peer.displayName}`)).toBeOnTheScreen();
    expect(server.messageCount()).toBe(1);
    await screen.unmount();
    server.scope.end();
  });

  it('copies a public link and stops it on request', async () => {
    const server = talkServer();
    await open(server);
    await fireEvent.press(screen.getByRole('button', { name: 'Copy link / Share elsewhere' }));
    expect(await screen.findByText('Link copied')).toBeOnTheScreen();
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/app\.fixture\.test\/s\/kssh_/),
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Stop sharing this link' }));
    await waitFor(() => expect(screen.getByText('Link stopped.')).toBeOnTheScreen());
    expect(server.sharesOf().every(([, share]) => share.revoked)).toBe(true);
    await screen.unmount();
    server.scope.end();
  });

  it('shows who is around only for friends who show it, and their handle otherwise', async () => {
    const server = talkServer();
    await open(server);
    await fireEvent.press(screen.getByRole('button', { name: 'Send to a conversation' }));
    expect(await screen.findByText(`@${peer.handle}`)).toBeOnTheScreen();
    expect(screen.queryByText('Online')).toBeNull();
    await screen.unmount();
    server.scope.end();

    const showing = talkServer();
    showing.peerShowsAvailability('online');
    await open(showing);
    await fireEvent.press(screen.getByRole('button', { name: 'Explore with friends' }));
    expect(await screen.findByText('Online')).toBeOnTheScreen();
    expect(screen.queryByText(`@${peer.handle}`)).toBeNull();
    await screen.unmount();
    showing.scope.end();
  });

  it('reads availability only while a picker is open, not on the first view', async () => {
    const server = talkServer();
    await open(server);
    expect(server.requests.filter((request) => request.path.endsWith('/friends/page'))).toEqual([]);
    await fireEvent.press(screen.getByRole('button', { name: 'Send to a conversation' }));
    await screen.findByText(`@${peer.handle}`);
    expect(server.requests.some((request) => request.path.endsWith('/friends/page'))).toBe(true);
    await screen.unmount();
    server.scope.end();
  });

  it('groups people already talked to under Recent, with a search box and the thread name as placeholder', async () => {
    const server = talkServer();
    server.peerSays('hello');
    await open(server);
    await fireEvent.press(screen.getByRole('button', { name: 'Send to a conversation' }));
    expect(await screen.findByText('Recent')).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('Search friends by name or @handle')).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText('Search friends'), 'nobody by that name');
    expect(screen.queryByRole('radio', { name: peer.displayName })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Explore with friends' }));
    expect(await screen.findByPlaceholderText('The edge you can’t come back from')).toBeOnTheScreen();
    expect(screen.getByText(/Everyone keeps their own place in the Reels/)).toBeOnTheScreen();
    await screen.unmount();
    server.scope.end();
  });

  it('closes silently with Cancel', async () => {
    const server = talkServer();
    const { onClose } = await open(server);
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(server.requests).toEqual([]);
    await screen.unmount();
    server.scope.end();
  });
});
