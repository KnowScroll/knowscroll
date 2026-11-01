import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text as NativeText } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ROOM_SWATCHES, type RoomIdentity, type RoomKit } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { SPACE_TONE, toneOf } from './identity/band-tone';
import { RoomGround, groundIsDark, useGroundColour, useGroundInk } from './identity/room-ground';
import { RoomPanels, RoomTabBar, type RoomTab } from './room-tabs';

/** Labelled fixture kits: a dark one and a pale one, words from the closed vocabulary. */
const kitOf = (ground: keyof typeof ROOM_SWATCHES, ink: keyof typeof ROOM_SWATCHES): RoomKit => ({
  version: 'station-kit.v1',
  palette: { ground, accent: 'sun', ink },
  emblem: { frame: 'circle', glyph: 'ringed-planet' },
  motif: 'constellation',
  motion: 'twinkle',
  cast: { explainer: 'star', skeptic: 'atom' },
});
const dark: RoomIdentity = { kit: kitOf('midnight', 'cream') };
const pale: RoomIdentity = { kit: kitOf('paper', 'soot') };

jest.mock('expo-router', () => ({ useIsFocused: () => true }));

const luminance = (hex: string) => {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};
const contrast = (first: string, second: string) => {
  const [light, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light! + 0.05) / (darker! + 0.05);
};

/** Stands for what General holds on to: a typed draft, a scroll place. */
function Held() {
  const [taps, setTaps] = useState(0);
  return (
    <Pressable testID="held" onPress={() => setTaps(taps + 1)}>
      <NativeText testID="held-count">{String(taps)}</NativeText>
    </Pressable>
  );
}

function Harness({ initial = 'general', identity = dark }: { initial?: RoomTab; identity?: RoomIdentity | undefined }) {
  const [tab, setTab] = useState<RoomTab>(initial);
  return (
    <RoomGround identity={identity} testID="ground">
      <RoomTabBar tab={tab} onSelect={setTab} />
      <RoomPanels
        tab={tab}
        general={<Held />}
        feed={<NativeText testID="feed-body">The feed</NativeText>}
        topics={<NativeText testID="topics-body">The topics</NativeText>}
      />
    </RoomGround>
  );
}
const wrap = (node: ReactNode) =>
  render(<DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{node}</DisplayProvider>);

describe('the room’s General / Feed / Topics bar', () => {
  it('names the three tabs and marks the open one', async () => {
    await wrap(<Harness />);
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    for (const label of ['General', 'Feed', 'Topics'])
      expect(screen.getByRole('tab', { name: label })).toBeOnTheScreen();
    expect(screen.getByTestId('room-tab-general')).toBeSelected();
    expect(screen.getByTestId('room-tab-feed')).not.toBeSelected();
  });

  it('opens on the tab the address asked for: the Feed from /rooms/<id>/feed', async () => {
    await wrap(<Harness initial="feed" />);
    expect(screen.getByTestId('room-tab-feed')).toBeSelected();
    expect(screen.getByTestId('feed-body')).toBeOnTheScreen();
    // General is still mounted but out of the way: a screen reader is not given it.
    expect(screen.getByTestId('room-panel-general', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByTestId('room-panel-general')).toBeNull();
    expect(screen.queryByTestId('topics-body', { includeHiddenElements: true })).toBeNull();
  });

  it('switches in place and keeps what a tab held: what General held is still there after a visit to the Feed', async () => {
    await wrap(<Harness />);
    await fireEvent.press(screen.getByTestId('held'));
    await fireEvent.press(screen.getByTestId('room-tab-feed'));
    expect(screen.getByTestId('room-tab-feed')).toBeSelected();
    expect(screen.queryByTestId('room-panel-general')).toBeNull();
    await fireEvent.press(screen.getByTestId('room-tab-topics'));
    await fireEvent.press(screen.getByTestId('room-tab-general'));
    expect(screen.getByTestId('held-count')).toHaveTextContent('1');
    expect(screen.queryByTestId('room-panel-feed')).toBeNull();
  });

  it('reads a tab only the first time it is opened', async () => {
    await wrap(<Harness />);
    expect(screen.queryByTestId('feed-body', { includeHiddenElements: true })).toBeNull();
    await fireEvent.press(screen.getByTestId('room-tab-feed'));
    expect(screen.getByTestId('feed-body')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('room-tab-general'));
    expect(screen.getByTestId('feed-body', { includeHiddenElements: true })).toBeTruthy();
  });
});

describe('the room’s ground', () => {
  function Probe() {
    return (
      <NativeText testID="probe">{`${useGroundColour('fallback-ground')}|${useGroundInk('fallback-ink')}`}</NativeText>
    );
  }

  it('is the kit’s ground, and what stands on it reads the kit’s ink', async () => {
    await wrap(
      <RoomGround identity={pale} testID="ground">
        <Probe />
      </RoomGround>,
    );
    expect(StyleSheet.flatten(screen.getByTestId('ground').props.style as object)).toMatchObject({
      backgroundColor: ROOM_SWATCHES.paper,
    });
    expect(screen.getByTestId('probe').props.children).toBe(`${ROOM_SWATCHES.paper}|${ROOM_SWATCHES.soot}`);
  });

  it('keeps the dark space ground for a room with no face', async () => {
    await wrap(
      <RoomGround identity={undefined} testID="ground">
        <Probe />
      </RoomGround>,
    );
    expect(StyleSheet.flatten(screen.getByTestId('ground').props.style as object)).toMatchObject({
      backgroundColor: SPACE_TONE.ground,
    });
  });

  it('draws no ground off a room’s page: a plain page keeps its own colours', async () => {
    await wrap(<Probe />);
    expect(screen.getByTestId('probe').props.children).toBe('fallback-ground|fallback-ink');
  });

  it('keeps AA contrast for words on the ground and for the open tab’s words on its fill, in a dark kit, a pale one and the default', () => {
    for (const tone of [toneOf(dark.kit), toneOf(pale.kit), SPACE_TONE]) {
      expect(contrast(tone.ink, tone.ground)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('tells a dark ground from a pale one, for the colour of the focus ring', () => {
    expect(groundIsDark(ROOM_SWATCHES.midnight)).toBe(true);
    expect(groundIsDark(ROOM_SWATCHES.forest)).toBe(true);
    expect(groundIsDark(ROOM_SWATCHES.paper)).toBe(false);
    expect(groundIsDark(ROOM_SWATCHES.mist)).toBe(false);
  });
});
