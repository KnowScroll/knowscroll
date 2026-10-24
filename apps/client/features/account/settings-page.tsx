import { Link, useRouter, type Href } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { content, radius, spacing, target } from '@knowscroll/design-tokens';
import { IconButton, Text, useDisplay, useFocusRing } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { ScreenFrame } from '../shell/screen-frame';

/** The pages of the settings list (D05 `.sn`), in the order the design draws them. */
const SETTINGS_PAGES = [
  { id: 'account', title: 'Account', href: '/account' },
  { id: 'requests', title: 'Your requests', href: '/account/requests' },
  { id: 'friends', title: 'Friends & visibility', href: '/friends' },
  { id: 'notifications', title: 'Notifications', href: '/account/notifications' },
  { id: 'accessibility', title: 'Accessibility & playback', href: '/account/accessibility' },
  { id: 'privacy', title: 'Privacy & history', href: '/account/privacy' },
] as const satisfies readonly { readonly id: string; readonly title: string; readonly href: Href }[];

export type SettingsPageId = (typeof SETTINGS_PAGES)[number]['id'];

function SettingsLink({ title, href }: { readonly title: string; readonly href: Href }) {
  const focus = useFocusRing('onLight');
  return (
    <Link href={href} asChild>
      <Pressable {...focus.props} accessibilityRole="link" style={{ ...styles.navItem, ...focus.style }}>
        <Text variant="bodyS">{title}</Text>
      </Pressable>
    </Link>
  );
}

/** The settings list beside the cards on desktops (D05 `.sn`); the page being shown is marked. */
export function SettingsNav({ current }: { readonly current: SettingsPageId }) {
  const { state } = useAccountScope();
  return (
    <View style={styles.nav} role="navigation" aria-label="Settings">
      <Text variant="heading" heading={2}>
        Settings
      </Text>
      {SETTINGS_PAGES.map((page) =>
        page.id === current ? (
          <View key={page.id} aria-current="page" style={[styles.navItem, styles.navCurrent]}>
            <Text variant="bodyS" color={content.paper}>
              {page.title}
            </Text>
          </View>
        ) : (
          <SettingsLink key={page.id} title={page.title} href={page.href} />
        ),
      )}
      {state.status === 'signed_in' ? (
        <Text variant="meta" color={content.ink2} style={styles.navNote}>
          Signed in as {state.scope.account.email}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A page of the settings that is one small form (Notifications, Accessibility & playback): a
 * title and a Back to Account on a phone, and the settings list beside the cards on a desktop.
 */
export function SettingsPage({
  title,
  current,
  children,
}: {
  readonly title: string;
  readonly current: SettingsPageId;
  readonly children: ReactNode;
}) {
  const router = useRouter();
  const desktop = useDisplay().breakpoint === 'desktop';
  const back = () => {
    if (router.canGoBack()) router.back();
    else router.navigate('/account');
  };
  return (
    <ScreenFrame
      tone="paper"
      title={title}
      showAccount={false}
      bodyOffset={spacing[5]}
      leading={<IconButton icon="back" label="Back to account" onPress={back} />}
    >
      {desktop ? (
        <View style={styles.desktop}>
          <SettingsNav current={current} />
          <View style={styles.cards}>{children}</View>
        </View>
      ) : (
        <View style={styles.page}>{children}</View>
      )}
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  page: { gap: spacing[1], paddingBottom: spacing[8] },
  desktop: { flexDirection: 'row', gap: spacing[8], alignItems: 'flex-start', paddingBottom: spacing[8] },
  nav: { width: 260, gap: spacing[2] },
  navItem: {
    minHeight: target.comfortable,
    paddingHorizontal: spacing[3],
    borderRadius: radius.md,
    justifyContent: 'center',
  },
  navCurrent: { backgroundColor: content.ink },
  navNote: { paddingTop: spacing[4] },
  cards: { flex: 1, minWidth: 0, maxWidth: 640, gap: spacing[1] },
});
