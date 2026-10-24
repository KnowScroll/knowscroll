import { Redirect, useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing, status } from '@knowscroll/design-tokens';
import { IconButton, Text, useDisplay } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { SettingsNav } from '../account/settings-page';
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

function Card({ children, danger = false }: { readonly children: ReactNode; readonly danger?: boolean }) {
  return <View style={[styles.card, danger ? styles.cardDanger : null]}>{children}</View>;
}

/** D05: settings list on the left, one card for each control on the right. */
function Desktop() {
  return (
    <View style={styles.desktop}>
      <SettingsNav current="privacy" />
      <View style={styles.cards}>
        <Text variant="meta" color={content.ink2} style={styles.lead}>
          Every action here says exactly what it changes, and reports done only when it is.
        </Text>
        <Card>
          <Text variant="title" heading={2}>
            Recording
          </Text>
          <Recording />
        </Card>
        <Card>
          <Text variant="title" heading={2}>
            History & export
          </Text>
          <ExportPanel compact />
        </Card>
        <Card>
          <ClearPanel compact />
        </Card>
        {privacyExtensions.map((extension) => (
          <Card key={extension.id}>
            <extension.Panel />
          </Card>
        ))}
        <Card danger>
          <DeletePanel compact />
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
      bodyOffset={spacing[5]}
      leading={<IconButton icon="back" label="Back to account" onPress={back} />}
    >
      {desktop ? <Desktop /> : <Hub />}
    </ScreenFrame>
  );
}

/** One control on a page of its own (phones and tablets), back to the hub. */
export function SubPage({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const router = useRouter();
  // An address opened on a desktop goes to the one page. A window that grows past 1024 px while the
  // person is in the middle of Delete or Export keeps that page: redirecting would drop their step.
  const desktop = useOnePage();
  const [openedOnDesktop] = useState(desktop);
  if (openedOnDesktop) return <Redirect href="/account/privacy" />;
  const back = () => {
    if (router.canGoBack()) router.back();
    else router.navigate('/account/privacy');
  };
  return (
    <ScreenFrame
      tone="paper"
      title={title}
      showAccount={false}
      bodyOffset={spacing[5]}
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
      <ClearPanel titled={false} />
    </SubPage>
  );
}

export function PrivacyDeleteScreen() {
  return (
    <SubPage title="Delete account">
      <DeletePanel titled={false} />
    </SubPage>
  );
}

/** A card is at least this wide: two sit side by side from about 1280 px (D05), one fills a narrower page. */
const CARD_MIN_WIDTH = 380;

const styles = StyleSheet.create({
  page: { gap: spacing[1], paddingBottom: spacing[8] },
  note: { paddingTop: spacing[5] },
  desktop: { flexDirection: 'row', gap: spacing[8], alignItems: 'flex-start', paddingBottom: spacing[8] },
  cards: { flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', gap: spacing[4] },
  lead: { flexBasis: '100%' },
  cardDanger: { borderColor: status.danger.edge },
  card: {
    flexGrow: 1,
    flexBasis: CARD_MIN_WIDTH,
    minWidth: 0,
    gap: spacing[3],
    padding: spacing[5],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.panel,
    backgroundColor: content.paper,
  },
});
