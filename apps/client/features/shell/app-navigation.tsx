import { useRouter } from 'expo-router';
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { StyleSheet, View } from 'react-native';
import { content, layout, type Breakpoint } from '@knowscroll/design-tokens';
import { NavRail, TabBar, useDisplay, type Destination } from '@knowscroll/ui';

const destinationRoutes: readonly Destination[] = ['explore', 'universe', 'conversations', 'saved'];

function asDestination(routeName: string | undefined): Destination | null {
  return destinationRoutes.find((destination) => destination === routeName) ?? null;
}

/** Whether this display navigates with a side rail instead of the floating tab bar (V01). */
export function usesRail(breakpoint: Breakpoint): boolean {
  return breakpoint === 'tablet' || breakpoint === 'desktop';
}

/**
 * The tabs navigator's bar, by size (V01): the floating pill on phones (icon-only ≤ 360), the
 * 76 px rail on tablets, the 88 px rail with the account avatar on desktops. The account stack
 * belongs to no tab, so nothing is current there except the rail's avatar.
 */
export function AppNavigation({ state, navigateToTab, insets }: BottomTabBarProps) {
  const router = useRouter();
  const { breakpoint } = useDisplay();
  const routeName = state.routes[state.index]?.name;
  const active = asDestination(routeName);
  const tone = routeName === 'universe' ? 'space' : 'paper';
  const select = (destination: Destination) => {
    const route = state.routes.find((candidate) => candidate.name === destination);
    if (route !== undefined) navigateToTab(route.key);
  };

  if (usesRail(breakpoint)) {
    return (
      <View style={[styles.rail, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <NavRail
          active={active}
          onSelect={select}
          size={breakpoint === 'desktop' ? 'desktop' : 'tablet'}
          tone={tone}
          account={{ onPress: () => router.navigate('/account'), current: routeName === 'account' }}
        />
      </View>
    );
  }
  return (
    <View
      pointerEvents="box-none"
      style={[styles.slot, { height: layout.tabBarSlot + insets.bottom, paddingBottom: insets.bottom }]}
    >
      <TabBar active={active} onSelect={select} tone={tone} />
    </View>
  );
}

const styles = StyleSheet.create({
  rail: { backgroundColor: content.nav, flexDirection: 'row' },
  slot: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
});
