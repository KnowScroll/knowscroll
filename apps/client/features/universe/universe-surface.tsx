import { useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NO_COLLECTION, type AccountScope } from '@knowscroll/client-core';
import type { RoomStation } from '@knowscroll/contracts';
import type { SceneDescriptor, SceneLook } from '@knowscroll/scene-core';
import { content, layer, layout, space, spacing } from '@knowscroll/design-tokens';
import { IconButton, Tag, Text, useDisplay } from '@knowscroll/ui';
import { Reveal, type Rising } from './animation/animated';
import type { AnimationPlayer } from './animation/player';
import { stepChrome } from './animation/step-chrome';
import { useUniverseAnimation } from './animation/use-universe-animation';
import { CollectionSection, CollectionSheet, LandmarkCard } from './collection/collection-parts';
import { collectionViewOf } from './collection/collection-view';
import { OrbitDial } from './dial/orbit-dial';
import { SimpleUniverse } from './simple/simple-universe';
import { UniverseBackdrop } from './universe-backdrop';
import { PlanetCard, RegionCard, SystemCard } from './universe-cards';
import { UniverseHeader } from './universe-header';
import { isQuiet, viewFor, type Size, type UniverseIndex, type UniverseView } from './universe-layout';
import { countOf } from './universe-lists';
import { UniversePanel, UniverseSettings } from './universe-panel';
import { UniverseSearchPanel } from './universe-search-panel';
import { SpaceChip } from './space-chip';
import { SystemFindsSheet } from './system-finds-sheet';
import { UniverseStage } from './universe-stage';
import { globePlacement } from './planet/planet-globe';
import { paletteOf } from './planet/planet-palette';
import { planPlanet } from './planet/planet-plan';
import { lowMemoryDevice } from './space/low-memory-device';
import { looksById, looksOfState } from './space/space-model';
import type { SpaceFailure } from './space/space-surface';
import type { UniverseMapSession, UniverseViewState } from './universe-session';

/**
 * Below this height a screen cannot hold the full landmark card under the map's sun and above its chips (Safari on a
 * 390 x 664 phone, Android Chrome at 360 x 640), so the card is one line there.
 */
const FULL_CARD_MIN_HEIGHT = 760;

/**
 * Where the globe's name and hint start, as a share of the stage's height: just under the globe (`globePlacement`).
 * With less than this much room between there and the stack of chips below, the caption is set in its compact form (D-392).
 */
const CAPTION_TOP_SHARE = 0.62;
const CAPTION_FULL_ROOM = 112;
/** The air kept between the caption and the chips under it. */
const CAPTION_GAP = 8;

/** The colour of the globe's hint, from the design. */
const HINT_COLOUR = '#B8E2E3';

/**
 * A friend's universe seen as a visitor (U06): the visitor bar goes on top, the map is named after its
 * owner, and the controls that only mean something for your own universe (Lately, the region hint) go.
 */
export interface VisitorChrome {
  readonly ownerName: string;
  readonly bar: ReactNode;
  /** The row at the bottom of the map (U06's one lock chip). */
  readonly footer?: ReactNode;
}

/**
 * The Universe as the artboards draw it: the map fills the screen, the header and chips float
 * over it. Desktop Browse and Settings overlay the map without changing its viewport (D02 amendment).
 */
export function UniverseSurface({
  session,
  state,
  index,
  status,
  visitor,
  stations,
  onStation,
  notice,
  scope,
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
  /** A quiet notice the map carries (the new-place views cannot be shown): the top row of the bottom stack, above the card. */
  readonly notice?: ReactNode;
  /** The person's own scope, which reads a system's Reels and Scrolls. Never given on a friend's universe. */
  readonly scope?: AccountScope;
}) {
  const { breakpoint } = useDisplay();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  // Desktop navigation overlays the map; it never reserves a column.
  const wide = breakpoint === 'desktop';
  const view = viewFor(index, state.focusId, state.landed);
  const places = session.places();
  const panel = wide && (state.overlay === 'outline' || state.overlay === 'search');
  const settings = wide && state.overlay === 'settings';
  const surface = useRef<ComponentRef<typeof View>>(null);
  const previousOverlay = useRef(state.overlay);
  useEffect(() => {
    const previous = previousOverlay.current;
    previousOverlay.current = state.overlay;
    if (Platform.OS !== 'web' || !wide || (state.overlay !== null && state.overlay !== 'place')) return;
    const trigger =
      previous === 'settings'
        ? 'universe-settings'
        : previous === 'outline' || previous === 'search'
          ? 'universe-browse'
          : undefined;
    if (!trigger) return;
    // Wait until the modal has released its focus trap and the map's own focus effect has run.
    const frame = requestAnimationFrame(() =>
      (surface.current as unknown as HTMLElement | null)
        ?.querySelector<HTMLElement>(`[data-testid="${trigger}"]`)
        ?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [state.overlay, wide]);
  const focused = places.find((place) => place.id === state.focusId);
  const picked = state.selectedId ? places.find((place) => place.id === state.selectedId) : undefined;
  const regionCard = state.overlay === 'place' && focused?.kind === 'region' ? focused : undefined;
  // Landmarks, the Orbit and the next Part are the person's own: a friend's universe is given none (D-214).
  const collection = useMemo(
    () => collectionViewOf(visitor ? NO_COLLECTION : state.collection.collection, index),
    [visitor, state.collection.collection, index],
  );
  const [dustNote, setDustNote] = useState(false);
  // Where the open card's top edge stands, from the bottom of the stage, once the card and the stack under it are drawn.
  const [bottomStackHeight, setBottomStackHeight] = useState(0);
  const [captionHeight, setCaptionHeight] = useState(0);
  const [cardTopInStack, setCardTopInStack] = useState<number | undefined>(undefined);
  const [refusedPlanetId, setRefusedPlanetId] = useState<string | null>(null);
  // Why 3D cannot be drawn, if it cannot: the tab is then the Simple lists, by itself (D-111).
  const [unavailable, setUnavailable] = useState<SpaceFailure | null>(() => (lowMemoryDevice() ? 'low-memory' : null));
  const searching = state.overlay === 'search';
  const controls = wide ? (
    <View style={styles.desktopControls}>
      <SpaceChip
        label="Browse"
        icon="search"
        variant="solid"
        testID="universe-browse"
        onPress={() => session.showOverlay('outline')}
      />
      <SpaceChip
        label="Settings"
        variant="solid"
        testID="universe-settings"
        onPress={() => session.showOverlay('settings')}
      />
    </View>
  ) : null;
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
  const openCollection = () => session.showOverlay('collection');
  // A system's Reels and Scrolls (#697): the way in from a system, with or without a planet. Only on the person's own map.
  const findsOf = (shown: UniverseView) => (!visitor && scope && shown.kind === 'system' ? shown.system : undefined);
  const findsTarget = state.overlay === 'finds' && state.findsFor ? index.byId.get(state.findsFor) : undefined;
  const findsSystem = !visitor && findsTarget?.kind === 'system' ? findsTarget : undefined;
  const findsSheet =
    findsSystem && scope ? (
      <SystemFindsSheet
        scope={scope}
        systemId={findsSystem.objectId}
        systemName={findsSystem.label}
        onClose={() => session.showOverlay(null)}
      />
    ) : null;
  const sheet =
    !visitor && state.overlay === 'collection' ? (
      <CollectionSheet
        view={collection}
        onClose={() => session.showOverlay(null)}
        onPlanet={(planetId) => void session.focus(planetId)}
      />
    ) : (
      findsSheet
    );
  const collectionPanel = visitor ? null : (
    <CollectionSection view={collection} onPlanet={(planetId) => void session.focus(planetId)} />
  );

  // The landmark card (D-089, D-319). On the desktop the panel lists the collection, so the map carries none, and a card or
  // the list in front of it takes its place. It is one line wherever a long card would reach the picture: on a globe (under
  // Back, above the globe, clear of its name and hint, which fill the lower half) and on a short screen, where a full card
  // would reach the sun.
  const landmarkAllowed = !visitor && !wide && !card && !sheet && !searching;
  const onGlobe = (shown: UniverseView) => shown.kind === 'planet' && !shown.landed && !simple;
  // See it and the close button both put the large card away for this landmark (#694). See it then shows the landmark
  // where it stands: its planet's globe, which paints the pennant. A landmark that waits has no place, so the list says so.
  const [newest] = collection.rows;
  const seen = newest !== undefined && state.seenLandmark === newest.id;
  // The button pressed is gone once the card folds, so keyboard and screen-reader focus moves to the pill that replaced it.
  const focusLandmarkPill = () => {
    if (Platform.OS !== 'web') return;
    requestAnimationFrame(() =>
      (surface.current as unknown as HTMLElement | null)
        ?.querySelector<HTMLElement>('[data-testid="universe-landmark-chip"]')
        ?.focus(),
    );
  };
  const dismissLandmark = () => {
    if (newest) session.seeLandmark(newest.id);
    focusLandmarkPill();
  };
  const seeLandmark = () => {
    if (newest) session.seeLandmark(newest.id);
    if (newest?.planet && session.focus(newest.planet.id)) return focusLandmarkPill();
    openCollection();
  };
  const landmarkCardOf = (folded: boolean): ReactNode => (
    <LandmarkCard
      view={collection}
      folded={folded}
      seen={seen}
      onList={openCollection}
      onSee={seeLandmark}
      onDismiss={dismissLandmark}
    />
  );
  const landmarkOf = (shown: UniverseView): ReactNode =>
    landmarkAllowed && !onGlobe(shown)
      ? landmarkCardOf(shown.kind === 'planet' || windowHeight < FULL_CARD_MIN_HEIGHT)
      : null;
  const globeLandmarkOf = (shown: UniverseView): ReactNode =>
    landmarkAllowed && onGlobe(shown) ? landmarkCardOf(true) : null;

  const headerOf = (shown: UniverseView): ReactNode =>
    searching && !wide ? (
      <UniverseSearchPanel
        session={session}
        {...(visitor ? { owner: visitor.ownerName } : {})}
        {...(stationsOfOwn ? { stations: stationsOfOwn } : {})}
        {...(onStation ? { onStation } : {})}
      />
    ) : (
      <View style={styles.headerStack}>
        <UniverseHeader
          session={session}
          state={state}
          view={shown}
          hasPlaces={places.length > 0 || state.dust.cues.length > 0}
          onSearch={openSearch}
          {...(visitor ? { visitor: { ownerName: visitor.ownerName } } : {})}
          {...(systemFacts ? { systemFacts } : {})}
          desktop={wide}
        />
        {controls}
        {globeLandmarkOf(shown)}
      </View>
    );
  const header = headerOf(view);

  // The name and hint stand under the globe, and never reach the chips below it: on a short screen they are set smaller, and
  // when even that does not leave room they stand on the chips (D-392).
  const captionRoom = stageSize.height * (1 - CAPTION_TOP_SHARE) - bottomStackHeight;
  const compactCaption = bottomStackHeight > 0 && captionRoom < CAPTION_FULL_ROOM;
  const captionTop = Math.min(
    stageSize.height * CAPTION_TOP_SHARE,
    stageSize.height - bottomStackHeight - CAPTION_GAP - captionHeight,
  );
  const captionOf = (shown: UniverseView): ReactNode =>
    shown.kind === 'planet' && !shown.landed && !simple ? (
      <View
        style={[
          styles.caption,
          compactCaption ? styles.captionCompact : null,
          captionHeight > 0 ? { top: captionTop } : null,
        ]}
        pointerEvents="none"
        onLayout={(event) => setCaptionHeight(event.nativeEvent.layout.height)}
      >
        <Text variant="label" color={space.label2}>
          {`A planet in ${index.byId.get(shown.planet.parentId)?.label ?? 'your universe'}`}
        </Text>
        <Text
          variant="displayL"
          heading={1}
          color={space.label}
          style={compactCaption ? styles.captionTitleCompact : styles.captionTitle}
        >
          {shown.planet.label}
        </Text>
        {shown.planet.truthStatus === 'hypothetical' ? <Tag label="Hypothetical" variant="hypothetical" /> : null}
        <View style={compactCaption ? styles.globeHintCompact : styles.globeHint}>
          <View style={compactCaption ? styles.hintMarkCompact : styles.hintMark} aria-hidden>
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
    !card && !sheet && !searching ? (
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
        {findsOf(shown) ? (
          <SpaceChip
            testID="universe-system-finds-open"
            variant="solid"
            icon="play"
            label="Watch or read"
            accessibilityLabel={`Watch or read in ${findsOf(shown)!.label}`}
            onPress={() => session.showFinds(findsOf(shown)!.objectId)}
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
  const landmarkCard = landmarkOf(view);
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
        bottom={bottomInset + (card ? 200 : 0)}
        banner={
          controls || visitor?.bar || status || notice ? (
            <>
              {controls}
              {visitor?.bar}
              {status ? <Tag label={status} variant="onDark" /> : null}
              {notice}
              {visitor?.footer}
            </>
          ) : undefined
        }
        onSearch={openSearch}
        {...(onStation ? { onStation } : {})}
        {...(simpleDrawing && !wide ? { onTurnOff: () => turnSimple(false) } : {})}
        {...(searching && !wide ? { searchPanel: header } : {})}
        {...(card ? { card } : findsSheet ? { card: findsSheet } : {})}
        {...(collectionPanel ? { collection: collectionPanel } : {})}
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
            landmarksByPlanet={collection.byPlanet}
            {...(regionCard && !panel && cardTopInStack !== undefined
              ? { coveredBottom: bottomStackHeight - cardTopInStack }
              : {})}
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
          {searching && !wide ? (
            <View pointerEvents="none" testID="universe-search-dim" style={styles.searchDim} />
          ) : null}
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
          <View
            pointerEvents="box-none"
            style={[styles.bottom, { paddingBottom: bottomInset }]}
            onLayout={(event) => setBottomStackHeight(event.nativeEvent.layout.height)}
          >
            {view.kind === 'system' && state.lately && isDormant(index, view.system.objectId) ? (
              <DormantNote session={session} index={index} systemId={view.system.objectId} />
            ) : null}
            {notice}
            {sheet}
            {panel || settings || !card ? null : (
              <View onLayout={(event) => setCardTopInStack(event.nativeEvent.layout.y)}>{card}</View>
            )}
            {visitor?.footer}
            <ChromeSlot
              player={animation.player}
              now={landmarkCard}
              was={chrome?.chipsOut && leaving ? landmarkOf(leaving) : undefined}
              into={chrome?.chipsIn}
              out={chrome?.chipsOut}
            />
            <ChromeSlot
              player={animation.player}
              now={chips}
              was={chrome?.chipsOut && leaving ? chipsOf(leaving) : undefined}
              into={chrome?.chipsIn}
              out={chrome?.chipsOut}
            />
          </View>
          {/* The search card opens over the same corner; the keys + and - still zoom while it is open. */}
          {wide && !globe && !searching ? (
            <View pointerEvents="box-none" testID="universe-zoom" style={styles.zoomControls}>
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

  return (
    <View ref={surface} style={styles.ground} testID="universe-screen" role="main">
      {stage}
      {panel ? (
        <UniversePanel
          session={session}
          state={state}
          index={index}
          {...(stationsOfOwn ? { stations: stationsOfOwn } : {})}
          {...(visitor ? { owner: visitor.ownerName } : {})}
          card={card}
          collection={collectionPanel}
          {...(onStation ? { onStation } : {})}
        />
      ) : null}
      {settings ? (
        <UniverseSettings
          session={session}
          state={state}
          simple={simpleDrawing}
          visitor={visitor !== undefined}
          onSimple={turnSimple}
        />
      ) : null}
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
        <Reveal player={player} rising={out} style={styles.leaving} inert>
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
  desktopControls: { flexDirection: 'row', gap: spacing[2], alignItems: 'center' },
  stageHost: { flex: 1, overflow: 'hidden' },
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: layout.topControlsInset, gap: spacing[2] },
  status: { alignItems: 'flex-end' },
  headerStack: { gap: spacing[3] },
  /** The map stays in view under the search card, dimmed (U08). */
  searchDim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(2,3,8,0.5)' },
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
  caption: {
    position: 'absolute',
    left: spacing[6],
    right: spacing[6],
    top: `${CAPTION_TOP_SHARE * 100}%`,
    gap: spacing['1.5'],
  },
  captionTitle: { fontSize: 30, lineHeight: 34 },
  captionCompact: { gap: 2 },
  captionTitleCompact: { fontSize: 26, lineHeight: 28 },
  globeHint: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], marginTop: spacing[1] },
  globeHintCompact: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  hintMark: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hintMarkCompact: {
    width: 20,
    height: 20,
    borderRadius: 10,
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
