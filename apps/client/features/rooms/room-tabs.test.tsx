import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text as NativeText } from 'react-native';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { ROOM_SWATCHES } from '@knowscroll/contracts';
import { focusHalo, focusRing, talkThemes } from '@knowscroll/design-tokens';
import { Button, DisplayProvider, TalkThemeProvider } from '@knowscroll/ui';
import { RoomGround, contrastOf, focusHaloFor, useGroundColour, useGroundInk } from './identity/room-ground';
import { RoomPanels, RoomTabBar, type RoomTab } from './room-tabs';

jest.mock('expo-router', () => ({ useIsFocused: () => true }));

/** Stands for what General holds on to: a typed draft, a scroll place. */
function Held() {
  const [taps, setTaps] = useState(0);
  return (
    <Pressable testID="held" onPress={() => setTaps(taps + 1)}>
      <NativeText testID="held-count">{String(taps)}</NativeText>
    </Pressable>
  );
}

function Harness({ initial = 'general' }: { initial?: RoomTab }) {
  const [tab, setTab] = useState<RoomTab>(initial);
  return (
    <RoomGround testID="ground">
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

  it.each([
    ['Dark', 'sky'],
    ['Light', 'paper'],
  ] as const)(
    'is the conversation ground of %s, and what stands on it reads that ground’s words (#666)',
    async (_appearance, theme) => {
      await wrap(
        <TalkThemeProvider name={theme}>
          <RoomGround testID="ground">
            <Probe />
          </RoomGround>
        </TalkThemeProvider>,
      );
      expect(StyleSheet.flatten(screen.getByTestId('ground').props.style as object)).toMatchObject({
        backgroundColor: talkThemes[theme].ground,
      });
      expect(screen.getByTestId('probe').props.children).toBe(`${talkThemes[theme].ground}|${talkThemes[theme].text}`);
    },
  );

  it('draws no ground off a room’s page: a plain page keeps its own colours', async () => {
    await wrap(<Probe />);
    expect(screen.getByTestId('probe').props.children).toBe('fallback-ground|fallback-ink');
  });

  it.each([['sky'], ['paper']] as const)(
    'draws the bar’s words at AA on what is really behind them, on the %s ground: the ground for a tab that is not open, its own fill for the open one',
    async (theme) => {
      await wrap(
        <TalkThemeProvider name={theme}>
          <Harness />
        </TalkThemeProvider>,
      );
      const ground = StyleSheet.flatten(screen.getByTestId('ground').props.style as object) as {
        backgroundColor: string;
      };
      const colourOf = (testID: string) => {
        const tab = screen.getByTestId(testID);
        const label = within(tab).getByText(String(tab.props.accessibilityLabel));
        return (StyleSheet.flatten(label.props.style as object) as { color: string }).color;
      };
      const fillOf = (testID: string) =>
        (StyleSheet.flatten(screen.getByTestId(testID).props.style as object) as { backgroundColor?: string })
          .backgroundColor;
      // Nothing is laid between a closed tab's words and the ground (no wash), so its pair is the kit's own.
      expect(fillOf('room-tab-feed')).toBeUndefined();
      expect(
        StyleSheet.flatten(screen.getByTestId('room-tabs').props.style as object) as { backgroundColor?: string },
      ).not.toHaveProperty('backgroundColor');
      expect(contrastOf(colourOf('room-tab-feed'), ground.backgroundColor)).toBeGreaterThanOrEqual(4.5);
      expect(contrastOf(colourOf('room-tab-general'), fillOf('room-tab-general')!)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('gives the cobalt focus ring a halo on every ground it cannot be seen on alone, so no ground leaves it under 3:1', () => {
    for (const ground of Object.values(ROOM_SWATCHES)) {
      const halo = focusHaloFor(ground);
      const seen =
        halo === undefined
          ? contrastOf(focusRing.onLight.color, ground)
          : Math.min(contrastOf(focusHalo[halo], ground), contrastOf(focusRing.onLight.color, focusHalo[halo]));
      expect(seen).toBeGreaterThanOrEqual(3);
    }
    expect(focusHaloFor(ROOM_SWATCHES.midnight)).toBe('light');
    expect(focusHaloFor(ROOM_SWATCHES.paper)).toBeUndefined();
  });

  it.each([['sky'], ['paper']] as const)(
    'draws a control’s ring with no halo on the %s ground, where the ring reads at 3:1 alone',
    async (theme) => {
      expect(contrastOf(focusRing.onLight.color, talkThemes[theme].ground)).toBeGreaterThanOrEqual(3);
      expect(focusHaloFor(talkThemes[theme].ground, talkThemes[theme].focus)).toBeUndefined();
      await wrap(
        <TalkThemeProvider name={theme}>
          <RoomGround>
            <Button label="Post" testID="control" />
          </RoomGround>
        </TalkThemeProvider>,
      );
      await fireEvent(screen.getByTestId('control'), 'focus');
      const ring = StyleSheet.flatten(screen.getByTestId('control').props.style as object) as {
        outlineColor?: string;
        boxShadow?: unknown;
      };
      expect(ring.outlineColor).toBe(focusRing.onLight.color);
      expect(JSON.stringify(ring.boxShadow ?? null)).not.toContain(focusHalo.light);
    },
  );
});
