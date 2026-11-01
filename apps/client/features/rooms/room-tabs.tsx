import { useIsFocused } from 'expo-router';
import { useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { borderWidth, layout, radius, spacing, target } from '@knowscroll/design-tokens';
import { Text, useFocusRing } from '@knowscroll/ui';
import { useBandTone } from './identity/band-tone';
import { RoomTabOpenProvider } from './room-tab-open';

/** The three places a member's room has under its header (T3 "Rooms with residents"). */
export type RoomTab = 'general' | 'feed' | 'topics';

export const ROOM_TABS: readonly { readonly tab: RoomTab; readonly label: string }[] = [
  { tab: 'general', label: 'General' },
  { tab: 'feed', label: 'Feed' },
  { tab: 'topics', label: 'Topics' },
];

const tabId = (tab: RoomTab) => `room-tab-${tab}`;
const panelId = (tab: RoomTab) => `room-panel-${tab}`;

type Step = 1 | -1 | 'first' | 'last';

/**
 * The keys of the bar on the web: the left and right arrows step to the neighbouring tab, Home and End go to the first and last.
 * Alt+Arrow is the browser's Back and Forward and Ctrl and Cmd are the person's own shortcuts, so a key with a modifier passes through.
 */
function tabKeys(step: (by: Step) => void): (event: unknown) => void {
  return (event) => {
    const keyEvent = event as {
      key?: string;
      altKey?: boolean;
      ctrlKey?: boolean;
      metaKey?: boolean;
      preventDefault?: () => void;
    };
    if (keyEvent.altKey === true || keyEvent.ctrlKey === true || keyEvent.metaKey === true) return;
    const by: Step | undefined =
      keyEvent.key === 'ArrowRight'
        ? 1
        : keyEvent.key === 'ArrowLeft'
          ? -1
          : keyEvent.key === 'Home'
            ? 'first'
            : keyEvent.key === 'End'
              ? 'last'
              : undefined;
    if (by === undefined) return;
    // Called on the event itself: a detached `preventDefault` throws "Illegal invocation" in the browser.
    keyEvent.preventDefault?.();
    step(by);
  };
}

interface Focusable {
  focus?: () => void;
}

function Segment({
  tab,
  label,
  selected,
  onSelect,
  onStep,
  register,
}: {
  readonly tab: RoomTab;
  readonly label: string;
  readonly selected: boolean;
  readonly onSelect: (tab: RoomTab) => void;
  readonly onStep: (from: RoomTab, by: Step) => void;
  readonly register: (tab: RoomTab, node: Focusable | null) => void;
}) {
  const tone = useBandTone();
  const focus = useFocusRing('onLight');
  const keys = tabKeys((by) => onStep(tab, by));
  // One Tab stop for the bar, on the open tab; the arrows, Home and End move between tabs (WAI-ARIA tabs).
  const keyboard =
    Platform.OS === 'web'
      ? {
          tabIndex: selected ? (0 as const) : (-1 as const),
          onKeyDown: keys,
        }
      : {};
  return (
    <Pressable
      ref={(node) => register(tab, node)}
      {...focus.props}
      {...keyboard}
      role="tab"
      nativeID={tabId(tab)}
      aria-selected={selected}
      aria-controls={panelId(tab)}
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      onPress={selected ? undefined : () => onSelect(tab)}
      style={[styles.segment, selected ? { backgroundColor: tone.ink } : null, focus.style]}
      testID={`room-tab-${tab}`}
    >
      <Text variant="ui" color={selected ? tone.ground : tone.ink}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The room's General / Feed / Topics bar, drawn in the room's own ink on its ground so each room keeps its face and the words
 * keep the contrast the kit was checked for. A tab is chosen in place: no address change, no entry in the history.
 */
export function RoomTabBar({ tab, onSelect }: { readonly tab: RoomTab; readonly onSelect: (tab: RoomTab) => void }) {
  const tone = useBandTone();
  const nodes = useRef<Partial<Record<RoomTab, Focusable | null>>>({});
  const onStep = (from: RoomTab, by: Step) => {
    const at = ROOM_TABS.findIndex((entry) => entry.tab === from);
    const next =
      by === 'first'
        ? ROOM_TABS[0]
        : by === 'last'
          ? ROOM_TABS[ROOM_TABS.length - 1]
          : ROOM_TABS[(at + by + ROOM_TABS.length) % ROOM_TABS.length];
    if (next === undefined) return;
    nodes.current[next.tab]?.focus?.();
    onSelect(next.tab);
  };
  return (
    <View style={styles.barFrame}>
      <View role="tablist" aria-label="This room" style={styles.bar} testID="room-tabs">
        {ROOM_TABS.map((entry) => (
          <Segment
            key={entry.tab}
            tab={entry.tab}
            label={entry.label}
            selected={entry.tab === tab}
            onSelect={onSelect}
            onStep={onStep}
            register={(key, node) => {
              nodes.current[key] = node;
            }}
          />
        ))}
        {/* The bar's edge, drawn over the ground without taking height; the words stand straight on the ground, so their contrast is the kit's own. */}
        <View
          pointerEvents="none"
          aria-hidden
          style={[styles.edge, { borderColor: tone.edge }]}
          testID="room-tabs-edge"
        />
      </View>
    </View>
  );
}

/** A panel that is not open stays mounted, so its scroll is still there; the web hides it without losing its box. */
const hiddenPanel: ViewStyle =
  Platform.OS === 'web'
    ? { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, visibility: 'hidden' }
    : { display: 'none' };

function Panel({
  tab,
  open,
  children,
}: {
  readonly tab: RoomTab;
  readonly open: boolean;
  readonly children: ReactNode;
}) {
  // Open means seen: a tab behind another, or a room behind a discussion pushed over it, plays, polls and records nothing.
  const focused = useIsFocused();
  return (
    <View
      role="tabpanel"
      nativeID={panelId(tab)}
      aria-labelledby={tabId(tab)}
      aria-hidden={open ? undefined : true}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
      pointerEvents={open ? 'auto' : 'none'}
      style={open ? styles.panel : hiddenPanel}
      testID={`room-panel-${tab}`}
    >
      <RoomTabOpenProvider value={open && focused}>{children}</RoomTabOpenProvider>
    </View>
  );
}

/** The Feed and Topics panels scroll on their own and read on a column, so a long list is never wider than a reading measure. */
export function PanelScroll({ children, testID }: { readonly children: ReactNode; readonly testID: string }) {
  return (
    <ScrollView contentContainerStyle={styles.scroll} testID={testID}>
      <View style={styles.column}>{children}</View>
    </ScrollView>
  );
}

/**
 * The three panels under the bar. General is always there; Feed and Topics are read the first time they are opened and then
 * kept, so going back to one finds its scroll where it was left (no new navigation entry, and Back leaves the room).
 */
export function RoomPanels({
  tab,
  general,
  feed,
  topics,
}: {
  readonly tab: RoomTab;
  readonly general: ReactNode;
  readonly feed: ReactNode;
  readonly topics: ReactNode;
}) {
  const [visited, setVisited] = useState<ReadonlySet<RoomTab>>(() => new Set([tab]));
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]));
  return (
    <View style={styles.panels}>
      <Panel tab="general" open={tab === 'general'}>
        {general}
      </Panel>
      {visited.has('feed') ? (
        <Panel tab="feed" open={tab === 'feed'}>
          {feed}
        </Panel>
      ) : null}
      {visited.has('topics') ? (
        <Panel tab="topics" open={tab === 'topics'}>
          {topics}
        </Panel>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // The bar costs a phone as little height as a 44 px target allows: the room's messages keep their share of the screen (D-140).
  barFrame: { zIndex: 1, paddingHorizontal: layout.gutter, paddingTop: spacing[1], paddingBottom: spacing['0.5'] },
  bar: {
    flexDirection: 'row',
    width: '100%',
    maxWidth: layout.measureDesktop,
    alignSelf: 'center',
    borderRadius: radius.pill,
  },
  edge: { ...StyleSheet.absoluteFill, borderRadius: radius.pill, borderWidth: borderWidth.light },
  segment: {
    flex: 1,
    minWidth: 0,
    minHeight: target.minimum,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[2],
    borderRadius: radius.pill,
    cursor: 'pointer' as const,
  },
  panels: { flex: 1, minHeight: 0 },
  panel: { flex: 1, minHeight: 0 },
  scroll: { flexGrow: 1, paddingBottom: spacing[8] },
  column: {
    gap: spacing[4],
    padding: layout.gutter,
    width: '100%',
    maxWidth: layout.measureDesktop,
    alignSelf: 'center',
  },
});
