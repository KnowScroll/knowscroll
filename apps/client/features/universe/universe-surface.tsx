import { useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RoomStation } from '@knowscroll/contracts';
import { content, layout, space, spacing } from '@knowscroll/design-tokens';
import { IconButton, Tag, Text, useDisplay } from '@knowscroll/ui';
import { UniverseBackdrop } from './universe-backdrop';
import { RegionCard, SystemCard } from './universe-cards';
import { UniverseHeader } from './universe-header';
import { isQuiet, viewFor, type UniverseIndex } from './universe-layout';
import { DrawingToggle, OutlineList, UniverseListSheet } from './universe-outline';
import { UniverseSearchPanel } from './universe-search-panel';
import { SpaceChip } from './space-chip';
import { UniverseStage } from './universe-stage';
import { paletteOf } from './planet/planet-palette';
import { planPlanet, type PlanetPlan } from './planet/planet-plan';
import { looksById } from './space/space-model';
import type { UniverseMapSession, UniverseViewState } from './universe-session';

/** The colour of the globe's hint, from the design. */
const HINT_COLOUR = '#B8E2E3';

/**
 * A friend's universe seen as a visitor (U06): the visitor bar goes on top, the map is named after its
 * owner, and the controls that only mean something for your own universe (Lately, the region hint) go.
 */
export interface VisitorChrome {
  readonly ownerName: string;
  readonly bar: ReactNode;
}

/**
 * The Universe as the artboards draw it: the map fills the screen, the header and chips float
 * over it, and the cards sit above the tab bar (phones and tablets). From 1024 px (D02) the map
 * has the outline beside it, always open, with the place card docked beneath.
 */
export function UniverseSurface({
  session,
  state,
  index,
  status,
  visitor,
  stations,
  onStation,
}: {
  readonly session: UniverseMapSession;
  readonly state: UniverseViewState;
  readonly index: UniverseIndex;
  /** A quiet pill over the map: "Drawing…" or "Last map shown". */
  readonly status: string | undefined;
  readonly visitor?: VisitorChrome;
  /** The room stations of the person's own map. Never a friend's: a visit shows only what the friend shares. */
  readonly stations?: readonly RoomStation[];
  /** A tap on a station, or its row in the list, opens that room. */
  readonly onStation?: (roomId: string) => void;
}) {
  const { breakpoint } = useDisplay();
  const insets = useSafeAreaInsets();
  // From 1024 px the outline sits beside the map, once there is anything to list (D02).
  const wide = breakpoint === 'desktop';
  const view = viewFor(index, state.focusId, state.landed);
  const places = session.places();
  const panel = wide && places.length > 0;
  const focused = places.find((place) => place.id === state.focusId);
  const selectedSystem = state.selectedId ? places.find((place) => place.id === state.selectedId) : undefined;
  const regionCard = state.overlay === 'place' && focused?.kind === 'region' ? focused : undefined;
  const [dustNote, setDustNote] = useState(false);
  const [refusedPlanetId, setRefusedPlanetId] = useState<string | null>(null);
  const searching = state.overlay === 'search';
  const openSearch = () => session.showOverlay('search');
  // A planet in view: what its globe and map are drawn from, which also gives the plain list its order.
  const looks = state.read.snapshot?.read.looks;
  const planet = view.kind === 'planet' ? view.planet : undefined;
  const plan = useMemo(
    () => (planet ? planPlanet(planet, index.regions.get(planet.objectId) ?? [], looksById(looks)) : undefined),
    [planet, index, looks],
  );
  const palette = useMemo(() => (plan ? paletteOf(plan.spec.type, plan.look?.hueShift ?? 0) : undefined), [plan]);
  // A planet whose world cannot be drawn, or low detail, falls back to the plain list of its regions.
  const simple = view.kind === 'planet' && (state.detail === 'low' || refusedPlanetId === view.planet.objectId);
  // A globe only turns: there is nothing to zoom.
  const globe = view.kind === 'planet' && !view.landed && !simple;

  const card: ReactNode = regionCard ? (
    <RegionCard session={session} state={state} place={regionCard} {...(palette ? { palette } : {})} />
  ) : selectedSystem && !searching ? (
    <SystemCard session={session} place={selectedSystem} />
  ) : dustNote && view.kind === 'universe' && state.dust.cues.length > 0 ? (
    <DustNote onClose={() => setDustNote(false)} />
  ) : null;
  const bottomInset = wide ? spacing[5] : layout.tabBarSlot + insets.bottom;

  const header = searching ? (
    <UniverseSearchPanel session={session} {...(visitor ? { owner: visitor.ownerName } : {})} />
  ) : (
    <UniverseHeader
      session={session}
      state={state}
      view={view}
      hasPlaces={places.length > 0}
      onSearch={openSearch}
      {...(visitor ? { visitor: { ownerName: visitor.ownerName } } : {})}
    />
  );

  const caption =
    view.kind === 'planet' && !view.landed && !simple ? (
      <View style={styles.caption} pointerEvents="none">
        <Text variant="label" color={space.label2}>
          {`A planet in ${index.byId.get(view.planet.parentId)?.label ?? 'your universe'}`}
        </Text>
        <Text variant="displayL" heading={1} color={space.label} style={styles.captionTitle}>
          {view.planet.label}
        </Text>
        {view.planet.truthStatus === 'hypothetical' ? <Tag label="Hypothetical" variant="hypothetical" /> : null}
        <View style={styles.globeHint}>
          <View style={styles.hintMark} aria-hidden>
            <Text variant="meta" color={HINT_COLOUR}>
              ↔
            </Text>
          </View>
          <Text variant="uiS" color={HINT_COLOUR}>
            {visitor ? 'Drag to rotate' : 'Drag to rotate · tap to land'}
          </Text>
        </View>
      </View>
    ) : null;

  // The ship is parked at the planet of the last place (D-080): the chip returns there, naming the planet.
  const returnTo = returnTarget(index, state.lastPlace);
  // Routes the Cartographer drew between planets of one system, shown as a chip, never as a line (D-074).
  const planetRoutes =
    view.kind === 'planet' && !view.selectedRegion
      ? index.routes.flatMap((route) => {
          const otherId =
            route.fromObjectId === view.planet.objectId
              ? route.toObjectId
              : route.toObjectId === view.planet.objectId
                ? route.fromObjectId
                : undefined;
          const other = otherId ? index.byId.get(otherId) : undefined;
          return other ? [{ route, other }] : [];
        })
      : [];
  const chips =
    !card && !searching ? (
      <View style={styles.chips}>
        {view.kind === 'universe' && returnTo && returnTo.id !== state.focusId ? (
          <SpaceChip
            testID="universe-return"
            variant="solid"
            icon="arrowRight"
            label={`Return to ${returnTo.label}`}
            onPress={() => session.focus(returnTo.id)}
          />
        ) : null}
        {planetRoutes.map(({ route, other }) => (
          <SpaceChip
            key={route.id}
            testID={`universe-route-${route.id}`}
            variant="solid"
            label={`Route to ${other.label}`}
            trailingIcon="forward"
            onPress={() => session.travel(route.id)}
          />
        ))}
        {!wide && places.length > 0 ? (
          <SpaceChip
            testID="universe-list"
            icon="list"
            label="List view"
            onPress={() => session.showOverlay('outline')}
          />
        ) : null}
      </View>
    ) : null;

  const stage = (
    <View style={styles.stageHost}>
      <UniverseBackdrop glow={false} />
      {simple && view.kind === 'planet' && plan ? (
        <SimplePlanet session={session} index={index} view={view} state={state} plan={plan} />
      ) : (
        <UniverseStage
          session={session}
          state={state}
          index={index}
          onSearch={openSearch}
          onDust={() => setDustNote(true)}
          stations={stations}
          onStation={onStation}
          visitor={visitor !== undefined}
          onRefused={setRefusedPlanetId}
        />
      )}
      <View pointerEvents="box-none" style={[styles.top, { paddingTop: insets.top + spacing[3] }]}>
        {visitor?.bar}
        {header}
        {status ? (
          <View style={styles.status}>
            <Tag label={status} variant="onDark" />
          </View>
        ) : null}
      </View>
      {caption}
      <View pointerEvents="box-none" style={[styles.bottom, { paddingBottom: bottomInset }]}>
        {view.kind === 'system' && state.lately && isDormant(index, view.system.objectId) ? (
          <DormantNote session={session} index={index} systemId={view.system.objectId} />
        ) : null}
        {panel ? null : card}
        {chips}
      </View>
      {wide && !globe ? (
        <View pointerEvents="box-none" style={styles.zoomControls}>
          <IconButton
            icon="plus"
            label="Zoom in"
            variant="onSpace"
            onPress={() => session.camera({ ...state.frame, scale: state.frame.scale * 1.25 })}
          />
          <IconButton
            icon="minus"
            label="Zoom out"
            variant="onSpace"
            onPress={() => session.camera({ ...state.frame, scale: state.frame.scale / 1.25 })}
          />
        </View>
      ) : null}
      {wide ? <KeyHints globe={globe} /> : null}
    </View>
  );

  if (wide)
    return (
      <View style={styles.ground} testID="universe-screen" role="main">
        <View style={styles.desktopRow}>
          {stage}
          {panel ? (
            <View style={styles.panel} role="complementary" aria-label="Outline">
              <Text variant="label" color={content.ink2} style={styles.panelEyebrow}>
                Outline · List view
              </Text>
              <View style={styles.panelTools}>
                <DrawingToggle session={session} state={state} />
              </View>
              <View style={styles.panelList}>
                <OutlineList
                  session={session}
                  state={state}
                  index={index}
                  {...(stations ? { stations } : {})}
                  {...(onStation ? { onStation } : {})}
                  {...(visitor ? { label: `Places in ${visitor.ownerName}’s universe` } : {})}
                />
              </View>
              {card ? <View style={styles.panelCard}>{card}</View> : null}
            </View>
          ) : null}
        </View>
      </View>
    );
  return (
    <View style={styles.ground} testID="universe-screen" role="main">
      {stage}
      {state.overlay === 'outline' ? (
        <UniverseListSheet
          session={session}
          state={state}
          index={index}
          {...(stations ? { stations } : {})}
          {...(onStation ? { onStation } : {})}
          {...(visitor ? { owner: visitor.ownerName } : {})}
        />
      ) : null}
    </View>
  );
}

/** Where the ship is parked: the last place, or the planet of a region. A system is its own place. */
function returnTarget(
  index: UniverseIndex,
  lastPlace: UniverseViewState['lastPlace'],
): { readonly id: string; readonly label: string } | undefined {
  const place = lastPlace ? index.byId.get(lastPlace.id) : undefined;
  if (!place) return undefined;
  const target = place.kind === 'region' ? (index.byId.get(place.parentId) ?? place) : place;
  return { id: target.objectId, label: target.label };
}

/** Every planet of the system is quiet: say so kindly and offer a way back in. */
function isDormant(index: UniverseIndex, systemId: string): boolean {
  const planets = index.planets.get(systemId) ?? [];
  return planets.length > 0 && planets.every(isQuiet);
}

function DormantNote({
  session,
  index,
  systemId,
}: {
  session: UniverseMapSession;
  index: UniverseIndex;
  systemId: string;
}) {
  const first = (index.planets.get(systemId) ?? [])[0];
  return (
    <View style={styles.dormant}>
      <Text variant="body" color={space.label}>
        Quiet for a while. Pick up anywhere.
      </Text>
      {first ? (
        <SpaceChip variant="solid" label={`Open ${first.label}`} onPress={() => session.focus(first.objectId)} />
      ) : null}
    </View>
  );
}

/** What dust means, in one calm sentence: no topic, no count, no promise (U01 "Emerging"). */
function DustNote({ onClose }: { onClose: () => void }) {
  return (
    <View testID="universe-dust-note" style={styles.dustNote} role="status">
      <Text variant="bodyS" style={styles.dustText}>
        Recent explorations are gathering here.
      </Text>
      <IconButton icon="close" label="Close note" variant="plain" onPress={onClose} />
    </View>
  );
}

function KeyHints({ globe }: { globe: boolean }) {
  const hint = (keys: string, action: string) => (
    <View key={action} style={styles.hint}>
      <Text variant="metaS" color={space.label} style={styles.key}>
        {keys}
      </Text>
      <Text variant="meta" color={space.label2}>
        {action}
      </Text>
    </View>
  );
  return (
    <View pointerEvents="none" style={styles.hints}>
      {hint('Arrows', globe ? 'turn' : 'pan')}
      {globe ? null : hint('+ −', 'zoom')}
      {hint('/', 'search')}
    </View>
  );
}

/**
 * The plain drawing of a planet (low detail, or a world that cannot be drawn): its name and a list of
 * its regions, in the same order as the map names them. Every region stays one tap away.
 */
function SimplePlanet({
  session,
  index,
  view,
  state,
  plan,
}: {
  session: UniverseMapSession;
  index: UniverseIndex;
  view: Extract<ReturnType<typeof viewFor>, { kind: 'planet' }>;
  state: UniverseViewState;
  plan: PlanetPlan;
}) {
  return (
    <View style={styles.simple}>
      <View style={styles.simpleTitle}>
        <Text variant="displayL" heading={1} color={space.label} style={styles.captionTitle}>
          {view.planet.label}
        </Text>
        <Text variant="label" color={space.label2}>
          {`A planet in ${index.byId.get(view.planet.parentId)?.label ?? 'your universe'}`}
        </Text>
      </View>
      <View style={styles.simpleList}>
        {plan.regions.map(({ descriptor }) => (
          <SpaceChip
            key={descriptor.objectId}
            label={descriptor.label}
            variant={descriptor.objectId === state.focusId ? 'solid' : 'ghost'}
            trailingIcon="forward"
            onPress={() => void session.focus(descriptor.objectId)}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: space.s0 },
  desktopRow: { flex: 1, flexDirection: 'row' },
  stageHost: { flex: 1, overflow: 'hidden' },
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: layout.topControlsInset, gap: spacing[2] },
  status: { alignItems: 'flex-end' },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: layout.topControlsInset,
    gap: spacing[3],
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2], alignItems: 'center' },
  caption: { position: 'absolute', left: spacing[6], right: spacing[6], top: '62%', gap: spacing['1.5'] },
  captionTitle: { fontSize: 30, lineHeight: 34 },
  globeHint: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], marginTop: spacing[1] },
  hintMark: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dustNote: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: content.paper,
    borderRadius: 18,
    paddingLeft: spacing[4],
    paddingRight: spacing[1],
  },
  dustText: { flexShrink: 1, paddingVertical: spacing[3] },
  dormant: { gap: spacing[2], alignItems: 'flex-start' },
  zoomControls: { position: 'absolute', top: 104, right: spacing[4], gap: spacing[2] },
  hints: { position: 'absolute', left: spacing[6], bottom: spacing[5], flexDirection: 'row', gap: spacing[4] },
  hint: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  key: { paddingHorizontal: spacing[2], paddingVertical: 2, borderRadius: 6, borderWidth: 1, borderColor: space.edge },
  panel: {
    width: 378,
    backgroundColor: content.paper,
    paddingTop: spacing[6],
    paddingHorizontal: spacing[4],
    gap: spacing[3],
  },
  panelEyebrow: { paddingHorizontal: spacing[2] },
  panelList: { flex: 1 },
  panelTools: { paddingHorizontal: spacing[2], alignItems: 'flex-start' },
  panelCard: { paddingBottom: spacing[4] },
  simple: { flex: 1, paddingTop: 132, gap: spacing[4] },
  simpleTitle: { paddingHorizontal: spacing[5], gap: 2 },
  simpleList: { paddingHorizontal: spacing[5], gap: spacing[2], alignItems: 'flex-start' },
});
