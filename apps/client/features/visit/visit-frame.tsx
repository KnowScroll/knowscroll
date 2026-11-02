import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { space } from '@knowscroll/design-tokens';
import { useDisplay, type Destination } from '@knowscroll/ui';
import { destinationHref, FloatingTabBar, PrimaryRail, railWidth, usesRail } from '../shell/app-navigation';

/**
 * A friend's universe keeps the primary navigation (U06): the floating tab bar on phones and the rail on
 * tablets and desktops, with Universe current, because the visit is still a place in the Universe tab. The
 * visit is not a tab route, so it draws the bar itself, as Talk's thread pages draw the rail. It carries no unread
 * dot: a visit reads only the friend's list, never the person's own inbox.
 */
export function VisitFrame({ children }: { readonly children: ReactNode }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { breakpoint } = useDisplay();
  const railed = usesRail(breakpoint);
  const select = (destination: Destination) => router.navigate(destinationHref(destination));
  return (
    <View style={styles.frame}>
      <View style={[styles.main, railed ? { marginLeft: railWidth(breakpoint) + insets.left } : null]}>{children}</View>
      {railed ? (
        <PrimaryRail
          active="universe"
          accountCurrent={false}
          tone="space"
          mark="dot"
          insets={insets}
          unread={false}
          onSelect={select}
        />
      ) : (
        <FloatingTabBar active="universe" onSelect={select} tone="space" unread={false} mark="glass" insets={insets} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, backgroundColor: space.s0 },
  main: { flex: 1, minHeight: 0 },
});
