import { useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RoomStation } from '@knowscroll/contracts';
import type { SceneDescriptor, SceneLook } from '@knowscroll/scene-core';
import { content, layer, layout, space, spacing } from '@knowscroll/design-tokens';
import { IconButton, Tag, Text, useDisplay } from '@knowscroll/ui';
import { Reveal, type Rising } from './animation/animated';
import type { AnimationPlayer } from './animation/player';
import { stepChrome } from './animation/step-chrome';
import { useUniverseAnimation } from './animation/use-universe-animation';
import { OrbitDial } from './dial/orbit-dial';
import { SimpleUniverse } from './simple/simple-universe';
import { UniverseBackdrop } from './universe-backdrop';
import { PlanetCard, RegionCard, SystemCard } from './universe-cards';
import { UniverseHeader } from './universe-header';
import { isQuiet, viewFor, type Size, type UniverseIndex, type UniverseView } from './universe-layout';
import { countOf } from './universe-lists';
import { UniversePanel } from './universe-panel';
import { UniverseSearchPanel } from './universe-search-panel';
import { SpaceChip } from './space-chip';
import { UniverseStage } from './universe-stage';
import { globePlacement } from './planet/planet-globe';
import { paletteOf } from './planet/planet-palette';
import { planPlanet } from './planet/planet-plan';
import { lowMemoryDevice } from './space/low-memory-device';
import { looksById, looksOfState } from './space/space-model';
import type { SpaceFailure } from './space/space-surface';
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
  const picked = state.selectedId ? places.find((place) => place.id === state.selectedId) : undefined;
  const regionCard = state.overlay === 'place' && focused?.kind === 'region' ? focused : undefined;
  const [dustNote, setDustNote] = useState(false);
  const [refusedPlanetId, setRefusedPlanetId] = useState<string | null>(null);
  // Why 3D cannot be drawn, if it cannot: the tab is then the Simple lists, by itself (D-111).
  const [unavailable, setUnavailable] = useState<SpaceFailure | null>(() => (lowMemoryDevice() ? 'low-memory' : null));
  const searching = state.overlay === 'search';
  const openSearch = () => session.showOverlay('search');
  // A planet in view: what its globe and map are drawn from, which also gives the plain list its order.
  const looks = looksOfState(state);
  const planet = view.kind === 'planet' ? view.planet : undefined;
  const { palette } = usePlanetPlan(planet, index, looks);
  // The whole tab is the two plain lists: by the setting, because 3D failed, or for one planet whose world cannot be drawn.
  const simpleDrawing = state.detail === 'low' || unavailable !== null;
  const simple = simpleDrawing || (view.kind === 'planet' && refusedPlanetId === view.planet.objectId);
  const turnSimple = (on: boolean) => {
    if (!on) setUnavailable(null);
    session.setSimple(on);
  };
  // The three steps down are animated (D-114); none plays under reduced motion, with Simple drawing or on the desktop layout (D02).
  const [stageSize, setStageSize] = useState<Size>({ width: 390, height: 640 });
  const placement = useMemo(() => {
    const { x, y, diameter } = globePlacement(stageSize);
    return { x, y, radius: diameter / 2 };
  }, [stageSize]);
  const animation = useUniverseAnimation({
    session,
    view,
    looks,
    enabled: !state.reducedMotion && !simple && !wide,
    globe: placement,
  });
  const step = animation.active;
  const stepKind = step?.kind;
  const chrome = useMemo(
    () => (stepKind === undefined ? undefined : stepChrome(stepKind, stageSize)),
    [stepKind, stageSize],
  );
  // A globe only turns: there is nothing to zoom.
  const globe = view.kind === 'planet' && !view.landed && !simple;
  const dialOpen = !wide && !simple && state.overlay === 'outline';
  const stationsOfOwn = visitor ? undefined : stations;
  // D02 names what a system holds under its title.
  const systemFacts =
    wide && view.kind === 'system'
      ? [
          countOf(index.planets.get(view.system.objectId)?.length ?? 0, 'planet'),
          ...(stationsOfOwn
            ? [countOf(stationsOfOwn.filter((s) => s.placement.systemId === view.system.objectId).length, 'room')]
            : []),
        ].join(' · ')
      : undefined;

  const card: ReactNode = regionCard ? (
    <RegionCard session={session} state={state} place={regionCard} solid={simple} {...(palette ? { palette } : {})} />
  ) : picked?.kind === 'planet' && !searching ? (
    <PlanetCard
      session={session}
      place={picked}
      system={places.find((place) => place.id === picked.parentId)?.label}
      countries={index.regions.get(picked.id)?.length ?? 0}
      hereRegion={hereRegionName(index, state.youWereHere, picked.id)}
    />
  ) : picked?.kind === 'system' && !searching ? (
    <SystemCard session={session} place={picked} />
  ) : dustNote && view.kind === 'universe' && state.dust.cues.length > 0 ? (
    <DustNote onClose={() => setDustNote(false)} />
  ) : null;
  const bottomInset = wide ? spacing[5] : layout.tabBarSlot + insets.bottom;

  const headerOf = (shown: UniverseView): ReactNode =>
    searching ? (
      <UniverseSearchPanel
        session={session}
        {...(visitor ? { owner: visitor.ownerName } : {})}
        {...(stationsOfOwn ? { stations: stationsOfOwn } : {})}
        {...(onStation ? { onStation } : {})}
      />
    ) : (
      <UniverseHeader
        session={session}
        state={state}
        view={shown}
        hasPlaces={places.length > 0}
        onSearch={openSearch}
        {...(visitor ? { visitor: { ownerName: visitor.ownerName } } : {})}
        {...(systemFacts ? { systemFacts } : {})}
        searchInPanel={panel}
      />
    );
  const header = headerOf(view);

  const captionOf = (shown: UniverseView): ReactNode =>
    shown.kind === 'planet' && !shown.landed && !simple ? (
      <View style={styles.caption} pointerEvents="none">
        <Text variant="label" color={space.label2}>
          {`A planet in ${index.byId.get(shown.planet.parentId)?.label ?? 'your universe'}`}
        </Text>
        <Text variant="displayL" heading={1} color={space.label} style={styles.captionTitle}>
          {shown.planet.label}
        </Text>
        {shown.planet.truthStatus === 'hypothetical' ? <Tag label="Hypothetical" variant="hypothetical" /> : null}
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
  const caption = captionOf(view);

  // The ship is parked at the planet of the last place (D-080): the chip returns there, naming the planet.
  const returnTo = returnTarget(index, state.lastPlace);
  // Routes the Cartographer drew between planets of one system, shown as a chip, never as a line (D-074).
  const routesOf = (shown: UniverseView) =>
    shown.kind === 'planet' && !shown.selectedRegion
      ? index.routes.flatMap((route) => {
          const otherId =
            route.fromObjectId === shown.planet.objectId
              ? route.toObjectId
              : route.toObjectId === shown.planet.objectId
                ? route.fromObjectId
                : undefined;
          const other = otherId ? index.byId.get(otherId) : undefined;
          return other ? [{ route, other }] : [];
        })
      : [];
  const chipsOf = (shown: UniverseView): ReactNode =>
    !card && !searching ? (
      <View style={styles.chips}>
        {shown.kind === 'universe' && returnTo && returnTo.id !== state.focusId ? (
          <SpaceChip
            testID="universe-return"
            variant="solid"
            icon="arrowRight"
            label={`Return to ${returnTo.label}`}
            onPress={() => session.focus(returnTo.id)}
          />
        ) : null}
        {routesOf(shown).map(({ route, other }) => (
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
  const chips = chipsOf(view);
  // The screen being left stays on screen, fading, under the destination's chrome as it rises (design: "Rules for all of them").
  const leaving = step?.from;

  const stage = simple ? (
    <View style={styles.stageHost}>
      <SimpleUniverse
        session={session}
        state={state}
        index={index}
        looks={looks}
        {...(stationsOfOwn ? { stations: stationsOfOwn } : {})}
        {...(visitor ? { owner: visitor.ownerName } : {})}
        top={insets.top + spacing[3]}
        bottom={bottomInset + (card && !panel ? 200 : 0)}
        banner={
          visitor?.bar || status ? (
            <>
              {visitor?.bar}
              {status ? <Tag label={status} variant="onDark" /> : null}
            </>
          ) : undefined
        }
        onSearch={openSearch}
        {...(onStation ? { onStation } : {})}
        {...(simpleDrawing ? { onTurnOff: () => turnSimple(false) } : {})}
        {...(searching ? { searchPanel: header } : {})}
        {...(panel || !card ? {} : { card })}
        {...(refusedPlanetId !== null && !simpleDrawing && view.kind === 'planet'
          ? { forcedPlanetId: refusedPlanetId }
          : {})}
      />
    </View>
  ) : (
    <View style={styles.stageHost}>
      <UniverseBackdrop glow={false} />
      {/* The dial takes the place of the map while it is open, so nothing under it can be reached. */}
      {dialOpen ? (
        <OrbitDial
          session={session}
          state={state}
          index={index}
          looks={looks}
          {...(stationsOfOwn ? { stations: stationsOfOwn } : {})}
          {...(visitor ? { owner: visitor.ownerName } : {})}
          top={insets.top + spacing[3]}
          bottom={bottomInset}
          onSimple={() => turnSimple(true)}
        />
      ) : (
        <>
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
            onUnavailable={setUnavailable}
            pickPlanets={wide && visitor === undefined}
            animation={animation}
            onSize={setStageSize}
          />
          <View pointerEvents="box-none" style={[styles.top, { paddingTop: insets.top + spacing[3] }]}>
            {visitor?.bar}
            <ChromeSlot
              player={animation.player}
              now={header}
              was={chrome?.headerOut && leaving ? headerOf(leaving) : undefined}
              into={chrome?.headerIn}
              out={chrome?.headerOut}
            />
            {status ? (
              <View style={styles.status}>
                <Tag label={status} variant="onDark" />
              </View>
            ) : null}
          </View>
          <ChromeSlot
            player={animation.player}
            now={caption}
            was={chrome?.captionOut && leaving ? captionOf(leaving) : undefined}
            into={chrome?.captionIn}
            out={chrome?.captionOut}
            fill
          />
          <View pointerEvents="box-none" style={[styles.bottom, { paddingBottom: bottomInset }]}>
            {view.kind === 'system' && state.lately && isDormant(index, view.system.objectId) ? (
              <DormantNote session={session} index={index} systemId={view.system.objectId} />
            ) : null}
            {panel ? null : card}
            <ChromeSlot
              player={animation.player}
              now={chips}
              was={chrome?.chipsOut && leaving ? chipsOf(leaving) : undefined}
              into={chrome?.chipsIn}
              out={chrome?.chipsOut}
            />
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
        </>
      )}
    </View>
  );

  if (wide)
    return (
      <View style={styles.ground} testID="universe-screen" role="main">
        <View style={styles.desktopRow}>
          {stage}
          {panel ? (
            <UniversePanel
              session={session}
              state={state}
              index={index}
              {...(stationsOfOwn ? { stations: stationsOfOwn } : {})}
              {...(visitor ? { owner: visitor.ownerName } : {})}
              simple={simpleDrawing}
              card={card}
              onSearch={openSearch}
              onSimple={turnSimple}
              {...(onStation ? { onStation } : {})}
            />
          ) : null}
        </View>
      </View>
    );
  return (
    <View style={styles.ground} testID="universe-screen" role="main">
      {stage}
    </View>
  );
}

/**
 * A piece of chrome and, while an animation plays, the one it replaces: the old one stays on screen
 * fading out, drawn over the same place, while the new one rises in. Outside an animation it is just
 * the piece, so nothing inside it is ever mounted again when an animation starts or ends.
 */
function ChromeSlot({
  player,
  now,
  was,
  into,
  out,
  fill = false,
}: {
  readonly player: AnimationPlayer;
  readonly now: ReactNode;
  readonly was: ReactNode | undefined;
  readonly into: ((t: number) => Rising) | undefined;
  readonly out: ((t: number) => Rising) | undefined;
  /** The piece positions itself against the whole stage (the globe's title). */
  readonly fill?: boolean;
}) {
  return (
    <View pointerEvents="box-none" style={fill ? StyleSheet.absoluteFill : undefined}>
      <Reveal player={player} rising={into} {...(fill ? { style: StyleSheet.absoluteFill } : {})}>
        {now}
      </Reveal>
      {was === undefined ? null : (
        <Reveal player={player} rising={out} style={styles.leaving}>
          {was}
        </Reveal>
      )}
    </View>
  );
}

/** The name of the region the person left from, when it is on this planet. */
function hereRegionName(index: UniverseIndex, hereRegionId: string | null, planetId: string): string | undefined {
  const region = hereRegionId ? index.byId.get(hereRegionId) : undefined;
  return region?.parentId === planetId ? region.label : undefined;
}

/** What a planet in view is drawn from, and its colours; worked out again only when the planet or the reads change. */
function usePlanetPlan(
  planet: SceneDescriptor | undefined,
  index: UniverseIndex,
  looks: readonly SceneLook[] | undefined,
) {
  const plan = useMemo(
    () => (planet ? planPlanet(planet, index.regions.get(planet.objectId) ?? [], looksById(looks)) : undefined),
    [planet, index, looks],
  );
  const palette = useMemo(() => (plan ? paletteOf(plan.spec.type, plan.look?.hueShift ?? 0) : undefined), [plan]);
  return { plan, palette };
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
      {hint('← → ↑ ↓', globe ? 'Turn' : 'Pan')}
      {globe ? null : hint('+ −', 'Zoom')}
      {hint('/', 'Search')}
      {hint('Esc', 'Back up a level')}
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
  leaving: { position: 'absolute', left: 0, right: 0, top: 0 },
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
  zoomControls: { position: 'absolute', top: 104, right: spacing[4], gap: spacing[2], zIndex: layer.mediaOverlay },
  /** Bottom right, clear of the chips that sit bottom left, and above the map's clouds. */
  hints: {
    position: 'absolute',
    right: spacing[6],
    bottom: spacing[5],
    flexDirection: 'row',
    gap: spacing[4],
    zIndex: layer.mediaOverlay,
  },
  hint: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  key: { paddingHorizontal: spacing[2], paddingVertical: 2, borderRadius: 6, borderWidth: 1, borderColor: space.edge },
});
