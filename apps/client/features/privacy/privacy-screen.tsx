import { Link, Redirect, useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing, target } from '@knowscroll/design-tokens';
import { IconButton, Text, useDisplay, useFocusRing } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { SettingsLabel, SettingsRow } from '../account/settings-parts';
import { ScreenFrame } from '../shell/screen-frame';
import { ClearPanel } from './clear-panel';
import { DeletePanel } from './delete-panel';
import { ExportPanel } from './export-panel';
import { privacyExtensions } from './privacy-extensions';
import { RecordingControl } from './recording-control';

function useBackToAccount() {
  const router = useRouter();
  return () => {
    if (router.canGoBack()) router.back();
    else router.navigate('/account');
  };
}

/** The desktop page (D05) draws every control on one page, so a phone's sub-page address sends it there. */
function useOnePage(): boolean {
  return useDisplay().breakpoint === 'desktop';
}

function Recording() {
  const { state } = useAccountScope();
  return state.status === 'signed_in' ? <RecordingControl scope={state.scope} /> : null;
}

/** The hub (P02): each row names what it changes; the controls themselves are one tap further. */
function Hub() {
  return (
    <View style={styles.page}>
      <Recording />
      <SettingsLabel>Your data</SettingsLabel>
      <SettingsRow
        title="History & export"
        description="Download a copy of your history, Keep and requests."
        href="/account/privacy/export"
      />
      <SettingsRow
        title="Clear exploration"
        description="Removes your history and universe. Keep and conversations stay."
        href="/account/privacy/clear"
      />
      {privacyExtensions.map((extension) => (
        <SettingsRow
          key={extension.id}
          title={extension.title}
          description={extension.description}
          href={extension.href}
        />
      ))}
      <SettingsRow
        title="Delete account"
        description="Removes your account, universe and Keep. Friendships end too."
        href="/account/privacy/delete"
      />
      <Text variant="meta" color={content.ink2} style={styles.note}>
        Your universe grows from the Reels and Scrolls you actually watch or read. Messages are stored for your
        conversations; they aren't treated as evidence of what you explored. Recommendations and things we prepare for
        you never count either.
      </Text>
    </View>
  );
}

function Card({ children }: { readonly children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

/** The settings list beside the cards on desktops (D05 `.sn`): only the pages that exist. */
function SettingsNav() {
  const { state } = useAccountScope();
  const focus = useFocusRing('onLight');
  return (
    <View style={styles.nav} accessibilityRole="menu" accessibilityLabel="Settings">
      <Text variant="heading" heading={2}>
        Settings
      </Text>
      <Link href="/account" asChild>
        <Pressable {...focus.props} accessibilityRole="link" style={StyleSheet.flatten([styles.navItem, focus.style])}>
          <Text variant="bodyS">Account</Text>
        </Pressable>
      </Link>
      <View accessibilityState={{ selected: true }} style={[styles.navItem, styles.navCurrent]}>
        <Text variant="bodyS" color={content.paper}>
          Privacy & history
        </Text>
      </View>
      {state.status === 'signed_in' ? (
        <Text variant="meta" color={content.ink2} style={styles.navNote}>
          Signed in as {state.scope.account.email}
        </Text>
      ) : null}
    </View>
  );
}

/** D05: settings list on the left, one card for each control on the right. */
function Desktop() {
  return (
    <View style={styles.desktop}>
      <SettingsNav />
      <View style={styles.cards}>
        <Text variant="meta" color={content.ink2}>
          Every action here says exactly what it changes, and reports done only when it is.
        </Text>
        <Card>
          <Recording />
        </Card>
        <Card>
          <Text variant="title" heading={2}>
            History & export
          </Text>
          <ExportPanel />
        </Card>
        <Card>
          <ClearPanel />
        </Card>
        {privacyExtensions.map((extension) => (
          <Card key={extension.id}>
            <extension.Panel />
          </Card>
        ))}
        <Card>
          <DeletePanel />
        </Card>
      </View>
    </View>
  );
}

/**
 * `/account/privacy` (P02, D05): recording, export, Clear exploration, anything other slices add,
 * and account deletion. Phones and tablets get the hub of rows and a page for each control;
 * desktops get every control as a card on one page.
 */
export function PrivacyScreen() {
  const back = useBackToAccount();
  const desktop = useOnePage();
  return (
    <ScreenFrame
      tone="paper"
      title="Privacy & history"
      showAccount={false}
      leading={<IconButton icon="back" label="Back to account" onPress={back} />}
    >
      {desktop ? <Desktop /> : <Hub />}
    </ScreenFrame>
  );
}

/** One control on a page of its own (phones and tablets), back to the hub. */
function SubPage({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const router = useRouter();
  const desktop = useOnePage();
  if (desktop) return <Redirect href="/account/privacy" />;
  const back = () => {
    if (router.canGoBack()) router.back();
    else router.navigate('/account/privacy');
  };
  return (
    <ScreenFrame
      tone="paper"
      title={title}
      showAccount={false}
      leading={<IconButton icon="back" label="Back to privacy and history" onPress={back} />}
    >
      <View style={styles.page}>{children}</View>
    </ScreenFrame>
  );
}

export function PrivacyExportScreen() {
  return (
    <SubPage title="History & export">
      <ExportPanel />
    </SubPage>
  );
}

export function PrivacyClearScreen() {
  return (
    <SubPage title="Clear exploration">
      <ClearPanel />
    </SubPage>
  );
}

export function PrivacyDeleteScreen() {
  return (
    <SubPage title="Delete account">
      <DeletePanel />
    </SubPage>
  );
}

const styles = StyleSheet.create({
  page: { gap: spacing[1], paddingBottom: spacing[8] },
  note: { paddingTop: spacing[5] },
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
  cards: { flex: 1, minWidth: 0, gap: spacing[4], maxWidth: 760 },
  card: {
    gap: spacing[3],
    padding: spacing[5],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.panel,
    backgroundColor: content.paper,
  },
});
