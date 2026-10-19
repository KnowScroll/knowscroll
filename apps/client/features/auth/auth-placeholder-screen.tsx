import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Ellipse } from 'react-native-svg';
import { layout, space, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Text } from '@knowscroll/ui';
import { useDocumentTitle } from '../../platform/document-title';

/** A01's ground: one calm star with its glow rings and a hairline orbit. */
function CalmStar() {
  return (
    <Svg width={300} height={220} viewBox="0 0 300 220">
      <Ellipse cx={170} cy={110} rx={150} ry={46} fill="none" stroke={space.orbit} strokeWidth={1.5} />
      <Circle cx={170} cy={110} r={54} fill={space.star} opacity={0.08} />
      <Circle cx={170} cy={110} r={32} fill={space.star} opacity={0.16} />
      <Circle cx={170} cy={110} r={16} fill={space.star} />
    </Svg>
  );
}

/**
 * The `(auth)` routes (`/welcome`, `/signin`, `/signin/link`, `/recover`) are reserved here and
 * filled by S1.3 (#226). Until sign-in exists they show the A01 ground, say plainly that sign-in
 * is not available (a notice, not an error), and offer the one thing that works: Explore.
 */
export function AuthPlaceholderScreen({ pageTitle }: { pageTitle: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  useDocumentTitle(pageTitle);
  return (
    <View
      role="main"
      style={[styles.ground, { paddingTop: insets.top + spacing[12], paddingBottom: insets.bottom + spacing[8] }]}
    >
      <View style={styles.column}>
        <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <CalmStar />
        </View>
        <Text variant="displayXl" color={space.label} heading={1}>
          KnowScroll
        </Text>
        <Text variant="body" color={space.label}>
          Thoughtful Reels and Scrolls. A universe that grows from what you explore.
        </Text>
        <Banner kind="info" lead="Sign-in isn't available yet." message="This build has no accounts." />
        <Button
          label="Go to Explore"
          variant="space"
          role="link"
          href="/explore"
          icon="explore"
          onPress={() => router.replace('/explore')}
        />
        <Text variant="meta" color={space.label2}>
          No questions to answer first. Your universe starts quiet.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: space.s0, paddingHorizontal: layout.gutter + spacing[1] },
  column: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'flex-start',
    gap: spacing[5],
    maxWidth: layout.entryCard,
    width: '100%',
    alignSelf: 'center',
  },
});
