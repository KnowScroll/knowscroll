import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Ellipse } from 'react-native-svg';
import { content, layout, space, spacing } from '@knowscroll/design-tokens';
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
 * The frame of the sign-in and recovery screens (A01–A02): safe areas, one centred column no wider
 * than the desktop entry card (V01: 480 px), and optionally the calm star. The first screen
 * (A01 sign-in) sits on the dark spatial ground; the screens after it (link sent, signed out, link
 * failed) are drawn on paper. Each screen names the page.
 */
export function AuthFrame({
  pageTitle,
  star = false,
  ground = 'space',
  leading,
  children,
}: {
  readonly pageTitle: string;
  readonly star?: boolean;
  /** `space` is the dark ground of the first screen; `paper` is the cream ground of the screens after it. */
  readonly ground?: 'space' | 'paper';
  readonly leading?: ReactNode;
  readonly children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  useDocumentTitle(pageTitle);
  return (
    <View
      role="main"
      style={[
        styles.ground,
        ground === 'paper' ? styles.paper : null,
        { paddingTop: insets.top + spacing[6], paddingBottom: insets.bottom + spacing[8] },
      ]}
    >
      {leading === undefined ? null : <View style={styles.leading}>{leading}</View>}
      <View style={styles.column}>
        {star ? (
          <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
            <CalmStar />
          </View>
        ) : null}
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: space.s0, paddingHorizontal: layout.gutter + spacing[1] },
  paper: { backgroundColor: content.paper },
  leading: { alignSelf: 'stretch', maxWidth: layout.entryCard, width: '100%', marginHorizontal: 'auto' },
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
