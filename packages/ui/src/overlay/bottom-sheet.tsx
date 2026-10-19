import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Easing, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  borderWidth,
  content,
  dimension,
  easing,
  layer,
  motion,
  opacity,
  overlay,
  radius,
  sheetRise,
  spacing,
} from '@knowscroll/design-tokens';
import { IconButton } from '../actions/icon-button';
import { useDisplay } from '../display/display';
import { dialogHostSemantics, dialogSemantics } from '../display/semantics';
import { Text } from '../text/text';
import { useOverlayHistory } from './overlay-history';

/**
 * The dimmed layer behind an overlay. Tapping it closes the overlay; it is not focusable, since
 * the overlay's own Close button and Back / Esc do the same.
 */
export function Scrim({ onPress, testID }: { onPress: () => void; testID?: string }) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessible={false}
      importantForAccessibility="no"
      focusable={false}
      style={styles.scrim}
    />
  );
}

export interface BottomSheetProps {
  readonly visible: boolean;
  /** The sheet's title, also its accessible name. */
  readonly title: string;
  /** Close, Back, Esc and a tap on the scrim all call this; the sheet never enters history. */
  readonly onClose: () => void;
  readonly closeLabel?: string;
  readonly children?: ReactNode;
  readonly testID?: string;
}

/**
 * A bottom sheet over a scrim (Components "Share sheet"; `.msheet` + `.grab`). It is an overlay,
 * not a route: closing it returns to exactly where the person was (N01, D-006 k). Close, the
 * scrim, Esc, Android back and browser Back all close only the sheet (on the web through one
 * transient history entry, `overlay-history.web.ts`). It rises 24 px over 240 ms (ease-out);
 * under reduced motion it fades in over 140 ms.
 */
export function BottomSheet({ visible, title, onClose, closeLabel = 'Close', children, testID }: BottomSheetProps) {
  const { reducedMotion, breakpoint } = useDisplay();
  const insets = useSafeAreaInsets();
  const [progress] = useState(() => new Animated.Value(0));
  useOverlayHistory(visible, onClose);

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

  const translateY = reducedMotion ? 0 : progress.interpolate({ inputRange: [0, 1], outputRange: [sheetRise, 0] });
  const wide = breakpoint === 'tablet' || breakpoint === 'desktop';

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
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: progress }]}>
          <Scrim onPress={onClose} testID={testID === undefined ? undefined : `${testID}-scrim`} />
        </Animated.View>
        <Animated.View
          testID={testID}
          {...dialogSemantics(title)}
          style={[
            styles.sheet,
            wide ? styles.sheetWide : null,
            { paddingBottom: spacing[7] + insets.bottom, opacity: progress, transform: [{ translateY }] },
          ]}
        >
          <View
            style={styles.grab}
            aria-hidden
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
          />
          <View style={styles.header}>
            <View style={styles.title}>
              <Text variant="displayL" heading={2}>
                {title}
              </Text>
            </View>
            <IconButton icon="close" label={closeLabel} onPress={onClose} />
          </View>
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1, justifyContent: 'flex-end' },
  scrim: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: overlay.scrim,
    zIndex: layer.scrim,
  },
  sheet: {
    zIndex: layer.sheet,
    gap: spacing['3.5'],
    paddingTop: spacing['2.5'],
    paddingHorizontal: spacing[5],
    backgroundColor: content.paper,
    borderTopWidth: borderWidth.regular,
    borderColor: content.ink,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
  },
  sheetWide: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 560,
    borderLeftWidth: borderWidth.regular,
    borderRightWidth: borderWidth.regular,
  },
  grab: {
    alignSelf: 'center',
    width: dimension.grabHandle.width,
    height: dimension.grabHandle.height,
    borderRadius: dimension.grabHandle.radius,
    backgroundColor: content.ink,
    opacity: opacity.grabHandle,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  title: { flex: 1 },
});
