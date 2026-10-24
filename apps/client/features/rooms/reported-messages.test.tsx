import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { AccountScope } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { ReportedMessages } from './reported-messages';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('../../platform/command-id', () => ({
  newCommandId: () => jest.requireActual<{ randomUUID: () => string }>('node:crypto').randomUUID(),
}));

const id = (n: number) => `0199c000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const roomId = id(1);
const report = {
  messageId: id(10),
  discussionId: id(11),
  discussionTitle: 'Where should it run?',
  sequence: 4,
  count: 2,
  categories: ['harassment', 'spam'],
  lastReportedAt: '2026-10-24T09:30:00.000Z',
};

async function show(reports: (input: unknown) => Promise<unknown>) {
  const scope = { active: true, api: { rooms: { reports } } } as unknown as AccountScope;
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <ReportedMessages scope={scope} roomId={roomId} />
    </DisplayProvider>,
  );
}

afterEach(() => mockPush.mockClear());

describe('the reported messages a moderator sees', () => {
  it('lists each message with its reasons and how often, and opens its discussion', async () => {
    const reports = jest.fn(() => Promise.resolve({ reports: [report] }));
    await show(reports);
    expect(reports).toHaveBeenCalledWith({ version: 'rooms.v1', readId: expect.any(String) as string, roomId });
    const row = await screen.findByRole('link', {
      name: 'Message 4 in Where should it run?, reported 2 times',
    });
    expect(screen.getByText('Harassment, Spam · 2 reports')).toBeOnTheScreen();
    await fireEvent.press(row);
    expect(mockPush).toHaveBeenCalledWith(`/rooms/${roomId}/t/${id(11)}`);
  });

  it('says plainly when nothing was reported, and names no one', async () => {
    await show(jest.fn(() => Promise.resolve({ reports: [] })));
    expect(await screen.findByText('No message in this room has been reported.')).toBeOnTheScreen();
  });

  it('says when the reports could not be read', async () => {
    await show(jest.fn(() => Promise.reject(new Error('offline'))));
    await waitFor(() => expect(screen.getByText('Reports couldn’t be read right now.')).toBeOnTheScreen());
  });
});
