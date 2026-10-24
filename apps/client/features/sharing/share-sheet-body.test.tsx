import type * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { AccountScopeState } from '@knowscroll/client-core';
import { conversation, id, peer, talkServer } from '@knowscroll/client-core/talk-fixture';
import { DisplayProvider } from '@knowscroll/ui';
import { ShareSheetBody } from './share-sheet-body';

const mockNavigate = jest.fn();
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useRouter: () => ({ navigate: mockNavigate }),
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});
let mockAccount: AccountScopeState = { status: 'signed_out', reason: 'none' };
jest.mock('../../providers/account-scope', () => ({
  useAccountScope: () => ({ state: mockAccount, manager: { refresh: jest.fn() } }),
}));
jest.mock('../../platform/api', () => ({
  appApiOrigin: () => ({ ok: true, baseUrl: 'https://app.fixture.test' }),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve(true)) }));
jest.mock('../../platform/command-id', () => ({
  newCommandId: () => jest.requireActual<{ randomUUID: () => string }>('node:crypto').randomUUID(),
}));

const target = { assetId: id(40), assetRevision: 2 };

function show(onClose: () => void) {
  return render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <ShareSheetBody target={target} title="The edge you can’t come back from" onClose={onClose} />
    </DisplayProvider>,
  );
}

afterEach(() => {
  mockNavigate.mockClear();
  mockAccount = { status: 'signed_out', reason: 'none' };
});

describe('ShareSheetBody', () => {
  it('asks a signed-out person to sign in instead of offering to share', async () => {
    await show(jest.fn());
    expect(screen.getByText('Sign in to share this.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
    await screen.unmount();
  });

  it('closes the sheet, then opens the conversation with the person’s own reference', async () => {
    const server = talkServer();
    mockAccount = { status: 'signed_in', scope: server.scope };
    const onClose = jest.fn();
    await show(onClose);
    await fireEvent.press(screen.getByRole('button', { name: 'Send to a conversation' }));
    await fireEvent.press(await screen.findByRole('radio', { name: peer.displayName }));
    await fireEvent.press(screen.getByRole('button', { name: `Send to ${peer.displayName}` }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Open chat' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));
    expect(mockNavigate).toHaveBeenCalledWith(
      `/conversations/${conversation.conversationId}?m=${conversation.membershipId}&r=${String(conversation.membershipRevision)}`,
    );
    await screen.unmount();
    server.scope.end();
  });
});
