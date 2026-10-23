import { StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';

/**
 * The small tile on a Keep card (S01). It is a drawn stand-in, not the content's art: a cobalt
 * poster for a Reel, a page with lines for a Scroll, a dashed blank for what is gone.
 */
export function KeepThumb({ kind, withdrawn }: { readonly kind: 'reel' | 'scroll'; readonly withdrawn: boolean }) {
  return (
    <View
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[styles.tile, withdrawn ? styles.withdrawn : kind === 'reel' ? styles.reel : styles.scroll]}
    >
      {kind === 'scroll' && !withdrawn ? (
        <View style={styles.lines}>
          <View style={styles.line} />
          <View style={[styles.line, styles.short]} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { width: 56, height: 64, borderRadius: radius.md, justifyContent: 'center', paddingHorizontal: spacing[2] },
  reel: { backgroundColor: content.accent },
  scroll: { backgroundColor: content.paper, borderWidth: borderWidth.regular, borderColor: content.ink },
  withdrawn: {
    backgroundColor: content.paper2,
    borderWidth: borderWidth.light,
    borderColor: content.muted,
    borderStyle: 'dashed',
  },
  lines: { gap: spacing[1] },
  line: { height: 4, borderRadius: 2, backgroundColor: content.ink },
  short: { width: '60%' },
});
