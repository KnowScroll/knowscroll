import { useRouter } from 'expo-router';
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { StyleSheet, View } from 'react-native';
import { content, layout, type Breakpoint } from '@knowscroll/design-tokens';
import { NavRail, TabBar, useDisplay, type Destination } from '@knowscroll/ui';
import { useAccountInitial, useAccountScopeIfPresent } from '../../providers/account-scope';
import { useTalkInbox } from '../conversations/use-talk-inbox';

const destinationRoutes: readonly Destination[] = ['explore', 'universe', 'conversations', 'saved'];

function asDestination(routeName: string | undefined): Destination | null {
  return destinationRoutes.find((destination) => destination === routeName) ?? null;
}

/** Whether this display navigates with a side rail instead of the floating tab bar (V01). */
export function usesRail(breakpoint: Breakpoint): boolean {
  return breakpoint === 'tablet' || breakpoint === 'desktop';
}

/** The rail's width at this size, or 0 where the floating tab bar is used. */
export function railWidth(breakpoint: Breakpoint): number {
  if (breakpoint === 'desktop') return layout.railDesktop;
  if (breakpoint === 'tablet') return layout.railTablet;
  return 0;
}

/** The address of a destination: a real link target on the web (Enter, middle-click, new tab). */
export function destinationHref(destination: Destination): `/${Destination}` {
  return `/${destination}`;
}

/**
 * The tabs navigator's bar, by size (V01): the floating pill on phones (icon-only ≤ 360), the
 * 76 px rail on tablets, the 88 px rail with the account avatar on desktops. The account stack
 * belongs to no tab, so nothing is current there except the rail's avatar.
 */
export function AppNavigation({ state, navigateToTab, insets }: BottomTabBarProps) {
  const router = useRouter();
  const { breakpoint } = useDisplay();
  const initial = useAccountInitial();
  const { state: account } = useAccountScopeIfPresent();
  // Talk shows a dot (never a count) while a friend's message waits.
  const unread = useTalkInbox(account.status === 'signed_in' ? account.scope : undefined).unread;
  const routeName = state.routes[state.index]?.name;
  const active = asDestination(routeName);
  const tone = routeName === 'universe' ? 'space' : 'paper';
  const select = (destination: Destination) => {
    const route = state.routes.find((candidate) => candidate.name === destination);
    if (route !== undefined) navigateToTab(route.key);
  };

  if (usesRail(breakpoint)) {
    // The rail comes after the screens in the document (tab order: content, then navigation,
    // V01) and is drawn over the left edge, which the screens leave free (`sceneStyle`).
    return (
      <View
        style={[
          styles.rail,
          { width: railWidth(breakpoint) + insets.left, paddingTop: insets.top, paddingBottom: insets.bottom },
        ]}
      >
        <NavRail
          active={active}
          onSelect={select}
          hrefFor={destinationHref}
          size={breakpoint === 'desktop' ? 'desktop' : 'tablet'}
          tone={tone}
          unread={unread}
          account={{
            onPress: () => router.navigate('/account'),
            href: '/account',
            current: routeName === 'account',
            ...(initial === undefined ? {} : { initial }),
          }}
        />
      </View>
    );
  }
  return (
    <View
      pointerEvents="box-none"
      style={[styles.slot, { height: layout.tabBarSlot + insets.bottom, paddingBottom: insets.bottom }]}
    >
      <TabBar active={active} onSelect={select} hrefFor={destinationHref} tone={tone} unread={unread} />
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: content.nav,
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  slot: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
});
