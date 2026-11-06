import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { focusHalo, printed, type FocusHalo, type TalkTheme } from '@knowscroll/design-tokens';
import { FocusHaloProvider, useTalkTheme } from '@knowscroll/ui';
import { BandToneContext, type BandTone } from './band-tone';

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
 * The tone of the conversation ground in the person's Appearance (#666): the Talk theme's own ground and words, so a
 * room under its band reads like Talk does, on the sky in Dark and on Paper in Light. Concrete values, so contrast and
 * the focus halo can be judged on them.
 */
export function toneOfTalkTheme(theme: TalkTheme): BandTone {
  return {
    ground: theme.ground,
    ink: theme.text,
    inkSoft: theme.textQuiet,
    edge: theme.capsule.edge,
    wash: theme.capsule.fill,
  };
}

/**
 * The room's ground: what is behind everything under the band, with cream cards standing on it. It follows Appearance
 * (#666, amending T3 "Rooms with residents", which laid the kit's ground here): the room's face (its band, emblem and
 * residents' marks) keeps its kit in both appearances, while the ground the conversation sits on is the one Talk uses, so a
 * room never puts a dark canvas between light side panels or the other way round. The tone is provided too, so a pill or a
 * tab that reads `useBandTone` draws in the ground's words here as it does on the band.
 */
export function RoomGround({
  style,
  children,
  testID,
}: {
  readonly style?: StyleProp<ViewStyle>;
  readonly children: ReactNode;
  readonly testID?: string;
}) {
  const theme = useTalkTheme();
  const tone = useMemo(() => toneOfTalkTheme(theme), [theme]);
  return (
    <RoomGroundContext.Provider value={tone}>
      <BandToneContext.Provider value={tone}>
        <FocusHaloProvider value={focusHaloFor(tone.ground, ringOn(theme))}>
          <View style={[styles.ground, { backgroundColor: tone.ground }, style]} testID={testID}>
            {children}
          </View>
        </FocusHaloProvider>
      </BandToneContext.Provider>
    </RoomGroundContext.Provider>
  );
}

/** The ring a control draws on this ground: the web's follows Appearance (`--ks-focus`); native's stays cobalt. */
const ringOn = (theme: TalkTheme): string => (Platform.OS === 'web' ? theme.focus : printed.accent);

const luminanceOf = (colour: string): number => {
  const channel = (offset: number) => {
    const value = Number.parseInt(colour.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

/** The WCAG contrast ratio of two `#RRGGBB` colours, from 1 to 21. */
export function contrastOf(first: string, second: string): number {
  const [lighter, darker] = [luminanceOf(first), luminanceOf(second)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

/**
 * The halo the focus ring needs on this ground to be seen at 3:1 (WCAG 2.4.11 and 1.4.11): none on a ground the ring reads
 * on, white on one it does not and white does, black on the mid-tones between (a lilac kit). `ring` is the colour actually
 * drawn: cobalt by default; the Talk theme's own on a room's ground (yellow on the sky). Both are concrete `#RRGGBB`.
 */
export function focusHaloFor(ground: string, ring: string = printed.accent): FocusHalo | undefined {
  if (contrastOf(ring, ground) >= 3) return undefined;
  return contrastOf(focusHalo.light, ground) >= 3 ? 'light' : 'dark';
}

const styles = StyleSheet.create({
  ground: { flex: 1, minHeight: 0 },
});
