import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { borderWidth, content, elevation, radius, space, spacing } from '@knowscroll/design-tokens';
import { Button, Icon, Text, useDisplay, type IconName } from '@knowscroll/ui';
import { usesRail } from '../shell/app-navigation';
import { ScreenFrame } from '../shell/screen-frame';
import { UniverseBackdrop } from '../universe/universe-backdrop';

function HintLine({ icon, children }: { icon: IconName; children: string }) {
  return (
    <View style={styles.hintLine}>
      <Icon name={icon} size={18} />
      <Text variant="ui">{children}</Text>
    </View>
  );
}

/**
 * A03 "First arrival": how to move around, on the spatial ground, with no survey. The export
 * draws a Reel already playing underneath; no starter Reel or Scroll exists yet (the experience
 * API arrives with the thin journey), so the screen says plainly that nothing is ready instead of
 * showing authored content, and the hint says the gestures apply once something plays (there is
 * nothing to swipe and no Continue tab yet). "Got it" dismisses the hint for this session
 * (remembering it per account and device needs the AccountScope store, #226). With no title bar,
 * the status line is the screen heading. Without the Reel, the hint stacks above the status
 * instead of floating at y≈470 over it as drawn.
 */
export function FirstArrivalScreen() {
  const [hintVisible, setHintVisible] = useState(true);
  const { breakpoint } = useDisplay();
  return (
    <ScreenFrame
      tone="space"
      pageTitle="Explore"
      backdrop={<UniverseBackdrop glow={false} />}
      bodyPlacement={usesRail(breakpoint) ? 'center' : 'end'}
    >
      <View style={styles.column}>
        {hintVisible ? (
          <View role="note" accessibilityLabel="How to move around" style={styles.hint}>
            <Text variant="uiS" color={content.ink2}>
              Once a Reel is playing:
            </Text>
            <HintLine icon="arrowUp">Swipe up for something new</HintLine>
            <HintLine icon="arrowRight">Go deeper with the tab on the right</HintLine>
            <Text variant="meta" color={content.ink2}>
              Prefer buttons? Every swipe also has a button and a key.
            </Text>
            <Button label="Got it" variant="ink" size="sm" onPress={() => setHintVisible(false)} />
          </View>
        ) : null}
        <View role="status" style={styles.status}>
          <Text variant="displayL" color={space.label} heading={1}>
            Nothing is ready to play yet.
          </Text>
          <Text variant="body" color={space.label2}>
            Reels and Scrolls play here. There are no questions to answer first.
          </Text>
        </View>
      </View>
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  column: { gap: spacing[8], maxWidth: 560, width: '100%', alignSelf: 'center' },
  hint: {
    gap: spacing['2.5'],
    padding: spacing[4],
    borderRadius: radius.edgeTab,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
    boxShadow: elevation.hint,
    alignItems: 'flex-start',
  },
  hintLine: { flexDirection: 'row', alignItems: 'center', gap: spacing['1.5'] },
  status: { gap: spacing[3] },
});
