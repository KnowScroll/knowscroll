import type * as React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import type { RoomStation } from '@knowscroll/contracts';
import { STATION_REFRESH_MS, useRoomStationsOnMap } from './use-room-stations';

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return { useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]) };
});
const mockRead = jest.fn();
jest.mock('@knowscroll/client-core', () => ({ readRoomStations: (...args: unknown[]): unknown => mockRead(...args) }));
jest.mock('../../platform/command-id', () => ({ newCommandId: () => 'read-id' }));

/** A labelled fixture station: only the fields the hook passes through. */
const station = (live: boolean) => ({ room: { roomId: 'room-1' }, ...(live ? { live: 'launch' } : {}) }) as RoomStation;

function Probe({ scope }: { readonly scope: AccountScope }) {
  const stations = useRoomStationsOnMap(scope);
  return <Text testID="live">{stations.map((entry) => (entry.live !== undefined ? 'live' : 'quiet')).join(',')}</Text>;
}

describe('the room stations on the Universe map', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRead.mockReset();
  });
  afterEach(() => jest.useRealTimers());

  it('shows a Launch that starts and ends in a room while the map stays on screen, and stops asking when it is left', async () => {
    mockRead.mockResolvedValueOnce([station(false)]);
    const { unmount } = await render(<Probe scope={{} as AccountScope} />);
    await act(() => Promise.resolve());
    expect(screen.getByTestId('live')).toHaveTextContent('quiet');

    mockRead.mockResolvedValueOnce([station(true)]);
    await act(() => jest.advanceTimersByTimeAsync(STATION_REFRESH_MS));
    expect(screen.getByTestId('live')).toHaveTextContent('live');

    mockRead.mockResolvedValueOnce([station(false)]);
    await act(() => jest.advanceTimersByTimeAsync(STATION_REFRESH_MS));
    expect(screen.getByTestId('live')).toHaveTextContent('quiet');

    const reads = mockRead.mock.calls.length;
    await unmount();
    jest.advanceTimersByTime(STATION_REFRESH_MS * 3);
    expect(mockRead).toHaveBeenCalledTimes(reads);
  });
});
