import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { spacing } from '@knowscroll/design-tokens';
import { Icon, Text, useDisplay, useFocusRing } from '@knowscroll/ui';

/**
 * The paper of the Simple views (`simple-views-finalized.html`, "Do not change") and of the desktop
 * panel: cream ground, ink text, white grouped rows, yellow for where the person was. These are the
 * file's own values, kept here once so the two screens cannot drift apart.
 */
export const SIMPLE = {
  ink: '#15302A',
  // The file draws 62 %; that measures 4.18:1 on its paper, under AA's 4.5:1, so the secondary text is 74 %.
  ink2: 'rgba(21,48,42,0.74)',
  line: 'rgba(21,48,42,0.1)',
  chevron: 'rgba(21,48,42,0.4)',
  group: '#FFFFFF',
  mode: '#F4EDD8',
  here: '#FFEC7A',
  orange: '#FF684C',
  red: '#FF3B30',
} as const;

/** A white rounded group of rows (`.group`). */
export function RowGroup({ children, label }: { readonly children: ReactNode; readonly label?: string }) {
  return (
    <View style={styles.group}>
      {/* The first row's top line sits one pixel above the group and is clipped (`.row:first-child`). */}
      <View role="list" {...(label === undefined ? {} : { 'aria-label': label })} style={styles.rows}>
        {children}
      </View>
    </View>
  );
}

/**
 * One row of a group (`.row`): a title, a line under it, and a chevron when it opens something. The
 * row where the person was is a plain yellow fill with a small red dot that sends out single ripples.
 */
export function PlaceRow({
  title,
  meta,
  here = false,
  current = false,
  picked = false,
  tail,
  onPress,
  accessibilityLabel,
  testID,
}: {
  readonly title: string;
  readonly meta?: string;
  /** An orange dot before the meta line ("You were here · Deployment"). */
  readonly here?: boolean;
  /** The yellow row with the rippling red dot: where the person was, on the planet's own list. */
  readonly current?: boolean;
  /** The planet picked on the desktop map, awaiting Land: a quiet paper fill. */
  readonly picked?: boolean;
  /** Replaces the chevron (the "picked" tag of the desktop panel). */
  readonly tail?: ReactNode;
  readonly onPress?: () => void;
  readonly accessibilityLabel?: string;
  readonly testID?: string;
}) {
  const focus = useFocusRing('onLight');
  const body = (
    <>
      <View style={styles.words}>
        <Text variant="ui" color={SIMPLE.ink} numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        {meta === undefined ? null : (
          <View style={styles.meta}>
            {here ? <View style={styles.hereDot} /> : null}
            <Text variant="meta" color={current ? SIMPLE.ink : SIMPLE.ink2}>
              {meta}
            </Text>
          </View>
        )}
      </View>
      {current ? <RippleDot /> : null}
      {tail ?? (onPress ? <Icon name="forward" size={18} color={SIMPLE.chevron} strokeWidth={2.4} /> : null)}
    </>
  );
  return (
    <View role="listitem" style={[styles.item, current ? styles.current : null, picked ? styles.picked : null]}>
      {onPress ? (
        <Pressable
          testID={testID}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? title}
          aria-current={current ? 'true' : undefined}
          onPress={onPress}
          {...focus.props}
          style={[styles.row, focus.style]}
        >
          {body}
        </Pressable>
      ) : (
        <View testID={testID} style={styles.row}>
          {body}
        </View>
      )}
    </View>
  );
}

/** The little red dot that sends out one ring at a time. Under reduced motion only the dot stays. */
function RippleDot() {
  const { reducedMotion } = useDisplay();
  const [ring] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reducedMotion) return;
    const loop = Animated.loop(
      Animated.timing(ring, { toValue: 1, duration: 2200, easing: Easing.out((t) => t * t), useNativeDriver: false }),
    );
    loop.start();
    return () => loop.stop();
  }, [reducedMotion, ring]);
  return (
    <View style={styles.pulse} aria-hidden importantForAccessibility="no-hide-descendants">
      {reducedMotion ? null : (
        <Animated.View
          style={[
            styles.ring,
            {
              opacity: ring.interpolate({ inputRange: [0, 0.65, 1], outputRange: [0.9, 0, 0] }),
              transform: [{ scale: ring.interpolate({ inputRange: [0, 0.65, 1], outputRange: [1, 3.6, 3.6] }) }],
            },
          ]}
        />
      )}
      <View style={styles.dot} />
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    borderRadius: 18,
    backgroundColor: SIMPLE.group,
    borderWidth: 1,
    borderColor: SIMPLE.line,
    overflow: 'hidden',
  },
  rows: { marginTop: -1 },
  item: { borderTopWidth: 1, borderTopColor: SIMPLE.line },
  current: { backgroundColor: SIMPLE.here },
  picked: { backgroundColor: SIMPLE.mode },
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['2.5'],
    paddingVertical: spacing[2],
    paddingLeft: spacing[4],
    paddingRight: spacing[3],
    cursor: 'pointer' as const,
  },
  words: { flex: 1, minWidth: 0 },
  title: { fontWeight: '700' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  hereDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: SIMPLE.orange },
  pulse: { width: 8, height: 8, marginRight: spacing['2.5'] },
  ring: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: SIMPLE.red,
  },
  dot: { flex: 1, borderRadius: 4, backgroundColor: SIMPLE.red },
});
