import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import type { RoomIdentity } from '@knowscroll/contracts';
import { BandToneContext, SPACE_TONE, toneOf, type BandTone } from './band-tone';

/** The tone of the room's ground where one is drawn; `undefined` on a page of the app that has none. */
const RoomGroundContext = createContext<BandTone | undefined>(undefined);

/**
 * The ink for text that sits straight on the page behind a room's panels: the kit's own ink where the room has laid its
 * ground (its contrast against the ground is checked before a kit can be shown, D-170), and `fallback` on a plain paper page.
 * Text on a card keeps its card's own ink and does not use this.
 */
export function useGroundInk(fallback: string): string {
  return useContext(RoomGroundContext)?.ink ?? fallback;
}

/** A quiet button reads as plain words on paper; on a room's ground it needs its card, or it would vanish into a dark kit. */
export function useQuietButton(): 'ghost' | 'default' {
  return useContext(RoomGroundContext) === undefined ? 'ghost' : 'default';
}

/** The ground colour a list should paint where a room's ground is laid, or `fallback` on a plain page. */
export function useGroundColour(fallback: string): string {
  return useContext(RoomGroundContext)?.ground ?? fallback;
}

/**
 * The room's ground (T3 "Rooms with residents"): the kit's ground colour behind everything under the band, with cream cards
 * standing on it. A room without a face keeps the dark space ground. The band's tone is provided too, so a pill or a tab that
 * reads `useBandTone` draws in the kit's ink here as it does on the band.
 */
export function RoomGround({
  identity,
  style,
  children,
  testID,
}: {
  readonly identity: RoomIdentity | undefined;
  readonly style?: StyleProp<ViewStyle>;
  readonly children: ReactNode;
  readonly testID?: string;
}) {
  const kit = identity?.kit;
  const tone = useMemo(() => (kit === undefined ? SPACE_TONE : toneOf(kit)), [kit]);
  return (
    <RoomGroundContext.Provider value={tone}>
      <BandToneContext.Provider value={tone}>
        <View style={[styles.ground, { backgroundColor: tone.ground }, style]} testID={testID}>
          {children}
        </View>
      </BandToneContext.Provider>
    </RoomGroundContext.Provider>
  );
}

/** Whether a `#RRGGBB` ground is dark enough that a yellow focus ring shows on it and a cobalt one would not. */
export function groundIsDark(ground: string): boolean {
  const channel = (offset: number) => Number.parseInt(ground.slice(offset, offset + 2), 16) / 255;
  const linear = (value: number) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * linear(channel(1)) + 0.7152 * linear(channel(3)) + 0.0722 * linear(channel(5));
  return luminance < 0.3;
}

const styles = StyleSheet.create({
  ground: { flex: 1, minHeight: 0 },
});
