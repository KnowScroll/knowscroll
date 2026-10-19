import { useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { borderWidth, content, radius, space, spacing, typeScale, type TypeRole } from '@knowscroll/design-tokens';
import {
  AccountButton,
  ActionRail,
  ActionStrip,
  Banner,
  BottomSheet,
  Button,
  DisplayProvider,
  ErrorState,
  FormatSwitch,
  Icon,
  IconButton,
  iconShapes,
  NavRail,
  OfflineState,
  RequestStatusChip,
  Skeleton,
  Tag,
  TabBar,
  Text,
  TopBar,
  type Destination,
  type EncounterAction,
  type EncounterFormat,
  type IconName,
} from '@knowscroll/ui';
import { useDocumentTitle } from '../../platform/document-title';
import { HealthPanel } from '../diagnostics/health-panel';

/** Marker the web-export check looks for: it must never appear in a production export. */
export const galleryMarker = 'ks-component-gallery';

function Section({
  title,
  note,
  children,
  dark = false,
}: {
  title: string;
  note?: string;
  children: ReactNode;
  dark?: boolean;
}) {
  return (
    <View style={[styles.section, dark ? styles.sectionDark : null]}>
      <Text variant="heading" heading={2} color={dark ? space.label : content.ink}>
        {title}
      </Text>
      {note === undefined ? null : (
        <Text variant="label" color={dark ? space.label2 : content.ink2}>
          {note}
        </Text>
      )}
      {children}
    </View>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

const allActions: readonly EncounterAction[] = ['like', 'save', 'share', 'ask', 'more'];

function ActionsDemo() {
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(true);
  const onAction = (action: EncounterAction) => {
    if (action === 'like') setLiked((value) => !value);
    if (action === 'save') setSaved((value) => !value);
  };
  return (
    <Row>
      <View style={styles.media}>
        <ActionRail available={allActions} liked={liked} saved={saved} onAction={onAction} />
      </View>
      <View style={styles.column}>
        <ActionStrip available={allActions} liked={liked} saved={saved} onAction={onAction} />
        <DisplayProvider value={{ width: 320 }}>
          <ActionStrip available={allActions} liked={liked} saved={saved} onAction={onAction} />
        </DisplayProvider>
        <DisplayProvider value={{ textScale: 2 }}>
          <ActionStrip available={allActions} liked={liked} saved={saved} onAction={onAction} />
        </DisplayProvider>
      </View>
    </Row>
  );
}

function NavigationDemo() {
  const [active, setActive] = useState<Destination>('explore');
  return (
    <View style={styles.column}>
      <View style={styles.navStage}>
        <TabBar active={active} onSelect={setActive} unread />
      </View>
      <View style={[styles.navStage, styles.navStageSpace]}>
        <TabBar active="universe" onSelect={setActive} tone="space" />
      </View>
      <DisplayProvider value={{ width: 320 }}>
        <View style={styles.navStage}>
          <TabBar active={active} onSelect={setActive} unread />
        </View>
      </DisplayProvider>
      <Row>
        <View style={styles.railStage}>
          <NavRail active={active} onSelect={setActive} size="tablet" />
        </View>
        <View style={styles.railStage}>
          <NavRail
            active={active}
            onSelect={setActive}
            size="desktop"
            account={{ onPress: () => undefined, current: false }}
          />
        </View>
      </Row>
      <TopBar title="Keep" trailing={<AccountButton onPress={() => undefined} initial="A" />} />
    </View>
  );
}

function SheetDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button label="Open a sheet" onPress={() => setOpen(true)} />
      <BottomSheet visible={open} title="Share" onClose={() => setOpen(false)}>
        <Text variant="bodyS">
          An overlay, not a history entry: Back, Esc, Close or the scrim close only the sheet.
        </Text>
      </BottomSheet>
    </>
  );
}

const typeRoles = Object.keys(typeScale) as TypeRole[];
const iconNames = Object.keys(iconShapes) as IconName[];

/**
 * The developer component gallery (`/gallery`, only when `EXPO_PUBLIC_KS_GALLERY=1`): every
 * primitive in its states, for side-by-side comparison with Components.html, plus the API
 * health diagnostics. Its sample words are the export's design data, labelled as such.
 */
export function GalleryScreen() {
  const insets = useSafeAreaInsets();
  useDocumentTitle('Component gallery');
  const [format, setFormat] = useState<EncounterFormat>('reel');
  return (
    <ScrollView
      testID={galleryMarker}
      role="main"
      style={styles.ground}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing[6], paddingBottom: insets.bottom + spacing[12] },
      ]}
    >
      <View style={styles.header}>
        <Text variant="displayXl" heading={1}>
          Components
        </Text>
        <Tag label="Prototype · design data" variant="part" />
      </View>

      <HealthPanel />

      <Section title="Button" note="Variants · primary / default / ink / ghost / small · danger · continue">
        <Row>
          <Button label="Request Scroll" variant="primary" />
          <Button label="Save" />
          <Button label="Resume at 0:31" variant="ink" />
          <Button label="Not now" variant="ghost" />
          <Button label="Copy link" size="sm" />
          <Button label="Delete account…" variant="danger" />
          <Button label="Part 2" variant="continue" icon="arrowRight" iconPosition="trailing" />
        </Row>
        <Text variant="label" color={content.ink2}>
          States · default / disabled / busy (press and Tab for pressed and focus-visible)
        </Text>
        <Row>
          <Button label="Send" variant="primary" icon="send" />
          <Button label="Send" variant="primary" disabled />
          <Button label="Send" variant="primary" busy busyLabel="Sending" />
        </Row>
      </Section>

      <Section
        title="Pressed toggles"
        note="Like · Save pressed: cobalt on paper, cream over media · never yellow (D-006 b)"
      >
        <Row>
          <IconButton icon="like" label="Like" pressed={false} />
          <IconButton icon="like" label="Like" pressed />
          <IconButton icon="save" label="Save" pressed />
          <View style={styles.mediaChip}>
            <IconButton icon="save" label="Save" variant="onMedia" pressed />
          </View>
          <Button label="Save" variant="primary" toggled />
        </Row>
      </Section>

      <Section title="Icon button and space controls" note="Paper / on media / on space · 48 × 48" dark>
        <Row>
          <IconButton icon="back" label="Back to Keep" />
          <IconButton icon="share" label="Share" variant="onMedia" />
          <IconButton icon="like" label="Like" variant="onSpace" pressed />
          <IconButton icon="plus" label="Zoom in" variant="onSpace" size={44} />
          <Button label="Universe" variant="space" size="sm" icon="back" />
        </Row>
      </Section>

      <Section title="Tag" note="Only Hypothetical and Corrected are status labels (D-006 a)">
        <Row>
          <Tag label="Part 2 of 3" variant="part" />
          <Tag label="Related" />
          <Tag label="Hypothetical" variant="hypothetical" />
          <Tag label="Corrected · 14 Oct" variant="corrected" />
        </Row>
        <View style={styles.inkStrip}>
          <Tag label="Astronomy" variant="onDark" />
        </View>
      </Section>

      <Section title="Format switch" note="Reel ⇄ Scroll · same explanation · tap only">
        <Row>
          <FormatSwitch selected={format} onSelect={setFormat} showIcons />
          <FormatSwitch selected="scroll" onSelect={() => undefined} />
          <FormatSwitch selected="reel" availability={{ scroll: 'preparing' }} onSelect={() => undefined} />
        </Row>
      </Section>

      <Section title="Action rail and strip" note="Same order everywhere: Like · Save · Share · Ask · More">
        <ActionsDemo />
      </Section>

      <Section title="Request chip" note="Attached to the thing requested · no percentages, no ETAs">
        <View style={styles.column}>
          <RequestStatusChip status="requested" detail="Scroll of this Reel" />
          <RequestStatusChip status="preparing" detail="we'll let you know" />
          <RequestStatusChip status="ready" detail="Open Scroll" onPress={() => undefined} />
          <RequestStatusChip status="failed" detail="Retry" onPress={() => undefined} />
          <RequestStatusChip status="cancelled" />
        </View>
      </Section>

      <Section title="Banner" note="State messaging">
        <View style={styles.column}>
          <Banner
            kind="offline"
            lead="Offline."
            message="Your place is kept. Messages you write will send when you reconnect."
          />
          <Banner kind="reconnecting" lead="Reconnecting…" message="Missing messages will appear in order." />
          <Banner
            kind="corrected"
            lead="Corrected 14 Oct."
            message="One claim was revised."
            action={{ label: 'What changed', onPress: () => undefined }}
          />
          <Banner
            kind="accessEnded"
            lead="Access ended."
            message="Asha stopped sharing this. Nothing from it is kept on your side."
          />
          <Banner
            kind="recordingPaused"
            lead="Recording paused."
            message="What you watch now won't shape your universe."
            action={{ label: 'Resume', onPress: () => undefined }}
          />
          <Banner
            kind="error"
            lead="Couldn't load."
            message="Nothing was changed."
            action={{ label: 'Retry', onPress: () => undefined }}
          />
        </View>
      </Section>

      <Section
        title="Navigation"
        note="Tab bar (paper, space, compact ≤ 360) · rails (tablet 76, desktop 88) · top bar"
      >
        <NavigationDemo />
      </Section>

      <Section title="Loading, offline and error" note="Not drawn in the export; composed from tokens">
        <Skeleton rows={2} />
        <OfflineState body="Your place is kept. This list may be out of date." onRetry={() => undefined} />
        <ErrorState title="Couldn't load Keep" body="Nothing was changed." onRetry={() => undefined} />
      </Section>

      <Section title="Bottom sheet and scrim">
        <SheetDemo />
      </Section>

      <Section title="Icons" note="24 × 24 line icons, round caps and joins">
        <View style={styles.icons}>
          {iconNames.map((name) => (
            <View key={name} style={styles.iconCell}>
              <Icon name={name} size={22} />
              <Text variant="monoXs" color={content.ink2}>
                {name}
              </Text>
            </View>
          ))}
        </View>
      </Section>

      <Section title="Type scale" note="Phone sizes · desktop +15 % on the authored roles">
        {typeRoles.map((role) => (
          <View key={role} style={styles.typeRow}>
            <Text variant="label" color={content.ink2}>
              {role}
            </Text>
            <Text variant={role}>Attention, slowly</Text>
          </View>
        ))}
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: content.paper },
  content: { paddingHorizontal: spacing[5], gap: spacing[6], maxWidth: 1200, width: '100%', alignSelf: 'center' },
  header: { gap: spacing[3] },
  section: {
    gap: spacing[4],
    padding: spacing[6],
    borderRadius: radius.panel,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  sectionDark: { backgroundColor: content.ink },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing['3.5'] },
  column: { gap: spacing[3], alignItems: 'flex-start' },
  inkStrip: { alignSelf: 'flex-start', padding: spacing[3], borderRadius: radius.md, backgroundColor: content.ink },
  media: { padding: spacing[3], borderRadius: radius.lg, backgroundColor: content.accent },
  mediaChip: { padding: spacing[2], borderRadius: radius.card, backgroundColor: space.s1 },
  navStage: { padding: spacing[4], borderRadius: radius.lg, backgroundColor: content.paper2, alignSelf: 'stretch' },
  navStageSpace: { backgroundColor: space.s0 },
  railStage: { height: 460, borderRadius: radius.lg, overflow: 'hidden' },
  icons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[3] },
  iconCell: { width: 96, alignItems: 'center', gap: spacing[1] },
  typeRow: { gap: spacing[1] },
});
