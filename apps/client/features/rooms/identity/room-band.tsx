import { useMemo, type ReactNode } from 'react';
import {
  Animated,
  Image,
  StyleSheet,
  View,
  type ImageSourcePropType,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { borderWidth } from '@knowscroll/design-tokens';
import type { RoomIdentity, RoomKit } from '@knowscroll/contracts';
import { useDisplay } from '@knowscroll/ui';
import { useAccountScopeIfPresent } from '../../../providers/account-scope';
import { useBandMotion } from './band-motion';
import { BandToneContext, SPACE_TONE, toneOf, type BandTone } from './band-tone';
import { Motif } from './motif';

/** What stands on a band: nodes, or a function that receives the tone for a component that draws its own text. */
type BandChildren = ReactNode | ((tone: BandTone) => ReactNode);

/**
 * The art behind a room's header (D-170, R3 D): the kit's ground, its faint pattern with one slow loop, and, when an
 * operator approved one, the painted backdrop under a wash of the ground so words on it keep their contrast. What stands
 * on the band reads the kit's ink through `useBandTone`. A room with no face (an older server) keeps the dark space band it
 * always had. Reduced motion draws the still frame, and the art is hidden from screen readers.
 *
 * This is the drawing, from plain values; `RoomBand` reads the device's motion setting and the signed-in session for the
 * picture's address.
 */
export function RoomBandView({
  kit,
  backdrop,
  reducedMotion,
  style,
  children,
  testID,
}: {
  readonly kit: RoomKit | undefined;
  /** The picture's source, with the headers a signed-in request needs; absent when there is none to show. */
  readonly backdrop?: ImageSourcePropType | undefined;
  readonly reducedMotion: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly children: BandChildren;
  readonly testID?: string;
}) {
  // A band with no kit draws nothing that could move, so it starts no loop.
  const motion = useBandMotion(kit?.motion ?? 'twinkle', reducedMotion || kit === undefined);
  const tone = useMemo(() => (kit === undefined ? SPACE_TONE : toneOf(kit)), [kit]);
  return (
    <View
      style={[
        { backgroundColor: tone.ground },
        // A hairline in the kit's ink where the band ends, so a pale ground still reads as a header over a pale page.
        kit === undefined ? null : { borderBottomWidth: borderWidth.hairline, borderBottomColor: tone.edge },
        style,
      ]}
      testID={testID}
    >
      {kit === undefined ? null : (
        <View style={StyleSheet.absoluteFill} pointerEvents="none" aria-hidden accessibilityElementsHidden>
          {backdrop === undefined ? null : (
            <>
              <Image source={backdrop} style={StyleSheet.absoluteFill} resizeMode="cover" testID="room-backdrop" />
              <View style={[StyleSheet.absoluteFill, { backgroundColor: `${tone.ground}CC` }]} />
            </>
          )}
          <View style={[StyleSheet.absoluteFill, styles.faint]}>
            <Animated.View style={[StyleSheet.absoluteFill, motion]} testID="room-motif">
              <Motif kit={kit} />
            </Animated.View>
          </View>
        </View>
      )}
      <BandToneContext.Provider value={tone}>
        {typeof children === 'function' ? children(tone) : children}
      </BandToneContext.Provider>
    </View>
  );
}

/** A room's band, for the room's identity as the server sent it. */
export function RoomBand({
  identity,
  style,
  children,
  testID,
}: {
  readonly identity: RoomIdentity | undefined;
  readonly style?: StyleProp<ViewStyle>;
  readonly children: BandChildren;
  readonly testID?: string;
}) {
  const { reducedMotion } = useDisplay();
  const { state } = useAccountScopeIfPresent();
  const path = identity?.backdrop?.path;
  const backdrop = useMemo(() => {
    if (path === undefined || state.status !== 'signed_in') return undefined;
    try {
      return state.scope.mediaSource?.(path);
    } catch {
      // The account scope ended while this rendered: no picture, and the kit alone is drawn.
      return undefined;
    }
  }, [path, state]);
  return (
    <RoomBandView
      kit={identity?.kit}
      backdrop={backdrop}
      reducedMotion={reducedMotion}
      {...(style === undefined ? {} : { style })}
      {...(testID === undefined ? {} : { testID })}
    >
      {children}
    </RoomBandView>
  );
}

const styles = StyleSheet.create({
  // Faint on purpose: the pattern says "you are somewhere" and never competes with the words over it.
  faint: { opacity: 0.32, overflow: 'hidden' },
});
