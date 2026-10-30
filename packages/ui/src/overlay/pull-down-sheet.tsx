import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Easing, Modal, Platform, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { borderWidth, content, easing, layer, motion, radius, sheetRise, spacing } from '@knowscroll/design-tokens';
import { IconButton } from '../actions/icon-button';
import { useDisplay } from '../display/display';
import { dialogHostSemantics, dialogSemantics } from '../display/semantics';
import { Text } from '../text/text';
import { Scrim } from './bottom-sheet';
import { useOverlayHistory } from './overlay-history';
import { usePageInert } from './page-inert';

export interface PullDownSheetProps {
  readonly visible: boolean;
  /** The sheet's title, also its accessible name. */
  readonly title: string;
  /** Close, the scrim, Esc, Android back and browser Back all call this; the sheet never enters history. */
  readonly onClose: () => void;
  /** Where the sheet hangs from, in px from the top of the window: the bottom edge of the header it was pulled from. */
  readonly top: number;
  readonly closeLabel?: string;
  readonly children?: ReactNode;
  readonly testID?: string;
}

/**
 * A sheet pulled down from a header (T3 "Series, pulled down"): it hangs from `top`, leaves the
 * header in view and dims only what is below it, so the conversation behind it stays where it was.
 * Like `BottomSheet` it is an overlay, not a route: Close, the scrim, Esc, Android back and browser
 * Back close only the sheet (D-006 k), and the page behind it is inert while it is open. It drops
 * 24 px over 240 ms; under reduced motion it fades in over 140 ms.
 */
export function PullDownSheet({
  visible,
  title,
  onClose,
  top,
  closeLabel = 'Close',
  children,
  testID,
}: PullDownSheetProps) {
  const { reducedMotion } = useDisplay();
  const { height } = useWindowDimensions();
  const [progress] = useState(() => new Animated.Value(0));
  useOverlayHistory(visible, onClose);
  usePageInert(visible);

  useEffect(() => {
    if (!visible) {
      progress.setValue(0);
      return undefined;
    }
    const token = motion.sheet;
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: reducedMotion ? token.reduced.duration : token.duration,
      easing: Easing.bezier(...easing.easeOut),
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start();
    return () => animation.stop();
  }, [progress, reducedMotion, visible]);

  const translateY = reducedMotion ? 0 : progress.interpolate({ inputRange: [0, 1], outputRange: [-sheetRise, 0] });
  const available = Math.max(height - top, 0);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
      testID={testID === undefined ? undefined : `${testID}-modal`}
      {...dialogHostSemantics(title)}
    >
      <View style={styles.host}>
        <Animated.View style={[styles.scrimLayer, { top, opacity: progress }]}>
          <Scrim onPress={onClose} testID={testID === undefined ? undefined : `${testID}-scrim`} />
        </Animated.View>
        <Animated.View
          testID={testID}
          {...dialogSemantics(title)}
          style={[styles.sheet, { top, maxHeight: available * 0.8, opacity: progress, transform: [{ translateY }] }]}
        >
          <View style={styles.header}>
            <View style={styles.title}>
              <Text variant="monoXs" color={content.ink2}>
                {title}
              </Text>
            </View>
            <IconButton icon="close" label={closeLabel} onPress={onClose} />
          </View>
          <ScrollView contentContainerStyle={styles.body}>{children}</ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1 },
  scrimLayer: { position: 'absolute', right: 0, bottom: 0, left: 0 },
  sheet: {
    position: 'absolute',
    right: 0,
    left: 0,
    zIndex: layer.sheet,
    paddingHorizontal: spacing[5],
    paddingBottom: spacing[3],
    backgroundColor: content.paper,
    borderBottomWidth: borderWidth.regular,
    borderColor: content.ink,
    borderBottomLeftRadius: radius.sheet,
    borderBottomRightRadius: radius.sheet,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  title: { flex: 1 },
  body: { gap: spacing[3], paddingBottom: spacing[2] },
});
