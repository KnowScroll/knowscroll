import { useFocusEffect, useRouter } from 'expo-router';
import { setStatusBarStyle } from 'expo-status-bar';
import { useCallback, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { content, layout, space, spacing, type Breakpoint } from '@knowscroll/design-tokens';
import { AccountButton, TopBar, useDisplay } from '@knowscroll/ui';
import { usesRail } from './app-navigation';

export interface ScreenFrameProps {
  /** `paper` for content screens; `space` for the universe and the first-arrival ground. */
  readonly tone: 'paper' | 'space';
  readonly title?: string;
  readonly titleVariant?: 'page' | 'heading';
  readonly leading?: ReactNode;
  /** The account avatar in the header (D-006 c). On desktops it lives in the rail instead. */
  readonly showAccount?: boolean;
  /** Decoration behind everything (the universe's glow and stars). */
  readonly backdrop?: ReactNode;
  /** How the body sits below the header. */
  readonly bodyPlacement?: 'start' | 'center' | 'end';
  readonly children: ReactNode;
  readonly testID?: string;
}

/** Side padding by size: the 20 px phone gutter; tablet and desktop insets from V01 and D05. */
function gutterFor(breakpoint: Breakpoint): number {
  if (breakpoint === 'desktop') return spacing[12];
  if (breakpoint === 'tablet') return spacing[9];
  return layout.gutter;
}

/**
 * The frame of every tab screen: ground colour, safe areas, the header with the account avatar,
 * and room for the floating tab bar on phones. Content never sits under the status bar.
 */
export function ScreenFrame({
  tone,
  title,
  titleVariant = 'page',
  leading,
  showAccount = true,
  backdrop,
  bodyPlacement = 'start',
  children,
  testID,
}: ScreenFrameProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { breakpoint } = useDisplay();
  const railed = usesRail(breakpoint);
  const accountInHeader = showAccount && breakpoint !== 'desktop';

  useFocusEffect(
    useCallback(() => {
      setStatusBarStyle(tone === 'space' ? 'light' : 'dark');
    }, [tone]),
  );

  const gutter = gutterFor(breakpoint);
  return (
    <View testID={testID} style={[styles.ground, { backgroundColor: tone === 'space' ? space.s0 : content.paper }]}>
      {backdrop}
      <ScrollView
        role="main"
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + (railed ? spacing[7] : spacing[3]),
            paddingBottom: railed ? spacing[8] : layout.tabBarSlot + insets.bottom + spacing[4],
            paddingLeft: gutter + (railed ? 0 : insets.left),
            paddingRight: gutter + insets.right,
          },
        ]}
      >
        <TopBar
          title={title}
          titleVariant={titleVariant}
          tone={tone}
          leading={leading}
          trailing={
            accountInHeader ? (
              <AccountButton
                onPress={() => router.navigate('/account')}
                surface={tone === 'space' ? 'dark' : 'light'}
              />
            ) : undefined
          }
        />
        <View style={[styles.body, placements[bodyPlacement]]}>{children}</View>
      </ScrollView>
    </View>
  );
}

const placements = StyleSheet.create({
  start: { justifyContent: 'flex-start', paddingTop: spacing[24] },
  center: { justifyContent: 'center' },
  end: { justifyContent: 'flex-end' },
});

const styles = StyleSheet.create({
  ground: { flex: 1 },
  content: { flexGrow: 1 },
  body: { flex: 1 },
});
