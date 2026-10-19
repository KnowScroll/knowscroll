import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { content, layer, space, spacing, target } from '@knowscroll/design-tokens';
import { Text } from '../text/text';

export interface TopBarProps {
  /** The tab-root title ("Keep", "Talk", "Your universe"); a heading for screen readers. */
  readonly title?: string;
  /** `page` for tab roots on paper (36), `heading` for the universe header (26). */
  readonly titleVariant?: 'page' | 'heading';
  /** Back (an IconButton named "Back to …"), when the screen is not a root. */
  readonly leading?: ReactNode;
  /** The format switch on encounters, or a topic tag. */
  readonly center?: ReactNode;
  /** The account avatar on every tab (D-006 c), and screen actions. */
  readonly trailing?: ReactNode;
  readonly tone?: 'paper' | 'space';
}

/**
 * The header row of a screen: Back, title or format switch, and the account avatar. It starts
 * below the platform status bar (the caller passes the safe-area inset as padding).
 */
export function TopBar({ title, titleVariant = 'page', leading, center, trailing, tone = 'paper' }: TopBarProps) {
  return (
    <View style={styles.bar}>
      {leading}
      <View style={styles.middle}>
        {title === undefined ? null : (
          <Text variant={titleVariant} color={tone === 'space' ? space.label : content.ink} heading={1}>
            {title}
          </Text>
        )}
        {center}
      </View>
      {trailing === undefined ? null : <View style={styles.trailing}>{trailing}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    zIndex: layer.topBar,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: target.comfortable,
  },
  middle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
});
