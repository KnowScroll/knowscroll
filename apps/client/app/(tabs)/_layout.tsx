import Tabs from 'expo-router/js-tabs';
import { useDisplay } from '@knowscroll/ui';
import { AppNavigation, usesRail } from '../../features/shell/app-navigation';

/**
 * The four destinations (D-006 c): Explore · Universe · Talk · Keep, with the account stack as a
 * fifth route that has no tab and is reached from the avatar (`href: null` would make it
 * unreachable in this Expo Router version). Each tab keeps its own state; Back follows the
 * person's own history across tabs.
 */
export default function TabsLayout() {
  const { breakpoint } = useDisplay();
  return (
    <Tabs
      backBehavior="history"
      tabBar={(props) => <AppNavigation {...props} />}
      screenOptions={{ headerShown: false, tabBarPosition: usesRail(breakpoint) ? 'left' : 'bottom' }}
    >
      <Tabs.Screen name="explore" options={{ title: 'Explore' }} />
      <Tabs.Screen name="universe" options={{ title: 'Universe' }} />
      <Tabs.Screen name="conversations" options={{ title: 'Talk' }} />
      <Tabs.Screen name="saved" options={{ title: 'Keep' }} />
      {/* Not a tab: the bar draws only the four destinations; the avatar opens this route. */}
      <Tabs.Screen name="account" options={{ title: 'You' }} />
    </Tabs>
  );
}
