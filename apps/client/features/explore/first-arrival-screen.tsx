import { useState } from 'react';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { space, spacing } from '@knowscroll/design-tokens';
import { Button, Text, useDisplay } from '@knowscroll/ui';
import { usesRail } from '../shell/app-navigation';
import { ScreenFrame } from '../shell/screen-frame';
import { UniverseBackdrop } from '../universe/universe-backdrop';
import { FirstArrivalHint } from './first-arrival-hint';

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
  const router = useRouter();
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
          <FirstArrivalHint
            lead="Once a Reel is playing:"
            lines={[
              { icon: 'arrowUp', text: 'Swipe up for something new' },
              { icon: 'arrowRight', text: 'Go deeper with the tab on the right' },
            ]}
            footnote="Prefer buttons? Every swipe also has a button and a key."
            onDismiss={() => setHintVisible(false)}
          />
        ) : null}
        <View role="status" style={styles.status}>
          <Text variant="displayL" color={space.label} heading={1}>
            Nothing is ready to play yet.
          </Text>
          <Text variant="body" color={space.label2}>
            Sign in to discover Reels and Scrolls. There are no questions to answer first.
          </Text>
        </View>
        <Button
          label="Sign in"
          role="link"
          href="/welcome"
          variant="space"
          onPress={() => router.navigate('/welcome')}
        />
      </View>
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  column: { gap: spacing[8], maxWidth: 560, width: '100%', alignSelf: 'center' },
  status: { gap: spacing[3] },
});
