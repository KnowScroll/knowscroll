/**
 * The trial's stage: what the Universe screen draws, instead of the map's own stage, when this device tries the new look.
 * It lays the universe out as the map does, works out where the person is (`targetOf`) and which planet is drawn as one
 * world (`usePlanetSurface`), hands both to the controller, and puts the named buttons over the canvas. The camera, the
 * globe and the ship are the driver's (`voyage-driver.ts`); the gestures are the controller's.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { Platform, Pressable, StyleSheet, View, type ViewProps, type ViewStyle } from 'react-native';
import Svg from 'react-native-svg';
import type { CollectionLandmark } from '@knowscroll/client-core';
import { chartWorld } from '@knowscroll/scene-core';
import { space, spacing, target } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';
import { useFlightRecorder, useFrameTimeRecorder, useGestureRecorder } from '../frame-rate/frame-rate-readout';
import { paletteOf } from '../planet/planet-palette';
import { planPlanet } from '../planet/planet-plan';
import { useGlobeWorld } from '../planet/use-planet-world';
import { LandmarkMark } from '../collection/landmark-mark';
import {
  BodyTarget,
  HERE_DOT_ROOM,
  KIND_PHRASE,
  LABEL_HEIGHT,
  labelWidth,
  MapLabel,
  type SceneProps,
} from '../scene-parts';
import { layOutUniverse, looksById, looksOfState } from '../space/space-model';
import type { SpaceAnchor, SpaceFailure } from '../space/space-surface';
import { CROWDED_TARGET, separateTargets } from '../space/separate-targets';
import { Unavailable } from '../space/space-stage';
import { SpaceView, type SpaceOverlayInfo } from '../space/space-view';
import { INITIAL_FRAME } from '../universe-camera';
import { placeLabels, type LabelRequest, type UniverseView } from '../universe-layout';
import type { UniverseMapSession } from '../universe-session';
import { STOPS, targetOf, type Stop } from './ladder';
import { createVoyageController, standsOn, type VoyageInputs } from './voyage-controller';
import type { VoyagePlanet } from './voyage-control';
import { CommonSky, SearchSky, type SearchAnswer } from './search-sky';
import { StationLayer } from './station-layer';
import { stationLookOf, stationSize, type StationLook } from './station-look';
import { labelPoints } from './world-texture';
import { landmarkPoints, type LandmarkPoint } from './landmark-points';

/** A planet with nothing earned on it. */
const NO_LANDMARKS: readonly CollectionLandmark[] = [];
const NO_PENNANTS: readonly LandmarkPoint[] = [];
/** A pennant on the ground stands this much larger than on a globe seen from orbit (the landed map's 1.3). */
const GROUND_PENNANT_SCALE = 1.3;

/** The light a name keeps when "What we have in common" is on and its system is not shared. */
const UNSHARED_NAME = { opacity: 0.4 } as const;

/** How far below a region's point its name sits, in points. */
const REGION_NAME_GAP = 14;
/** The "you are here" pill sits this far below its region's point, just under the ship standing there. */
const HERE_GAP = 6;
/** A region's name is a pill: its sides take this much more than plain text (`MapLabel`'s pill padding). */
const PILL_PADDING = 20;
/** A star's sun keeps names off its glow as well as its disc: this many of its radii. */
const SUN_CLEARANCE = 1.4;
/** A body's name sits this far below its edge, in points ... */
const BODY_NAME_GAP = 6;
/** ... counted from at least this radius, so a tiny body's name still clears its button. */
const MIN_BODY_RADIUS = 6;

/**
 * On the web a browser handles some touches itself unless told not to: two fingers zoom the page, a drag down pulls
 * to refresh. Every touch on the stage is the Universe's (turn, pinch one stop, fly the ship), so it takes them all.
 * `touchAction` is a web style React Native's types do not list; React Native Web passes it through.
 */
const WEB_TOUCH = Platform.OS === 'web' ? ({ touchAction: 'none' } as unknown as ViewStyle) : null;

/**
 * The Universe's new look, tried behind a device switch: one camera that flies along the ladder (ground, planet, star,
 * the whole universe), a planet drawn as one world from orbit to the ground, and a ship the person can drag and let go
 * over a place to go there. It draws the map's own three.js scene through `SpaceView`, with a camera driver of its own
 * (`voyage-driver.ts`), and keeps the map's contract: every place is a named 48 px button over the canvas, and browsing
 * writes nothing.
 */
export function VoyageStage({
  session,
  state,
  index,
  size,
  view,
  onDust,
  stations,
  onStation,
  onUnavailable,
  visitor = false,
  landmarksByPlanet,
  search,
  desktop = false,
}: SceneProps & {
  readonly view: UniverseView;
  readonly onUnavailable: (reason: SpaceFailure) => void;
  /** A friend's Universe: their planets are drawn with every continent in colour and no region named or tappable. */
  readonly visitor?: boolean;
  /** What the person has earned on each planet: its pennants stand on the globe. */
  readonly landmarksByPlanet?: ReadonlyMap<string, readonly CollectionLandmark[]>;
  /** Search is open: the sky dims, and the systems that hold a match keep their light and wear a ring. */
  readonly search?: SearchAnswer;
  /** The screen is on the product's desktop layout (not a width of this stage): the ship parks and leans as on a desktop. */
  readonly desktop?: boolean;
}) {
  const looks = looksOfState(state);
  // No last place: it only parks the scene's own rocket, which the voyage never shows (its ship is the driver's). Every
  // flight records a new last place, and a new layout rebuilds the whole scene, freeing its shader programs to be
  // linked again mid-flight: a stall of a few hundred milliseconds on the first flight to each place.
  const space = useMemo(
    () =>
      layOutUniverse({
        index,
        looks: looksById(looks),
        stations: stations ?? [],
        dustCueIds: state.dust.cues.map((cue) => cue.id),
        lately: state.lately,
        lastPlaceId: undefined,
      }),
    [index, looks, stations, state.dust.cues, state.lately],
  );
  const planet = usePlanetSurface(session, state, index, view, visitor, landmarksByPlanet);
  // What each room's station is drawn from, by room id. The scene's laid-out stations carry the accent, the sky and what is
  // live that `stations` holds, so the picture and the scene read one answer.
  const stationLooks = useMemo(
    () => new Map((space.definition.stations ?? []).map((station) => [station.id, stationLookOf(station)])),
    [space],
  );
  const recordFlight = useFlightRecorder();
  const recordGesture = useGestureRecorder();
  const [flying, setFlying] = useState(false);
  const inputs: VoyageInputs = {
    session,
    view,
    target: targetOf(view),
    size,
    turn: { x: state.frame.x, y: state.frame.y },
    planet,
    siblings:
      (view.kind === 'planet' ? index.planets.get(view.planet.parentId) : undefined)?.map(
        (sibling) => sibling.objectId,
      ) ?? [],
    reducedMotion: state.reducedMotion,
    desktop,
    universeFocus: space.universeFocus,
    systemFocus: space.systemFocus,
    ...(onStation ? { onStation } : {}),
    ...(recordFlight ? { onFlight: recordFlight } : {}),
    ...(recordGesture ? { onGesture: recordGesture } : {}),
    onFlying: setFlying,
  };
  const [controller] = useState(() => createVoyageController(inputs));
  // Before `SpaceView`'s own effects: under reduced motion it redraws its one still frame there, and that frame must
  // already see where you are now.
  useLayoutEffect(() => controller.sync(inputs));
  useEffect(() => () => controller.dispose(), [controller]);
  const recordFrame = useFrameTimeRecorder();

  const systemId = inputs.target.systemId;
  const stop = inputs.target.stop;
  /** The place the camera is at: its name wins a crowded spot. */
  const focusId = inputs.target.regionId ?? inputs.target.planetId ?? inputs.target.systemId;
  /** On the ground, the region the ship stands on: its name is a "you are here" pill under the ship. */
  const hereId = standsOn(inputs);
  // A new camera object makes `SpaceView` draw again: under reduced motion there is no loop, so every change of where
  // you are, of what you turned or of the planet's world must be one. `redraw` only changes the camera's identity when
  // any of those does; the driver does not read it.
  // The pennants are not in the planet's key (they do not repaint its texture) but a still frame must show a new one.
  const pennantsDrawn = planet?.landmarks.map((landmark) => `${landmark.key}:${landmark.tier}`).join(',') ?? '';
  const redraw = `${inputs.target.stop}|${inputs.target.planetId ?? ''}|${inputs.target.regionId ?? ''}|${planet?.key ?? ''}|${pennantsDrawn}|${String(inputs.turn.x)},${String(inputs.turn.y)}`;
  const camera = useMemo(
    () => ({
      focus: (systemId === null ? undefined : space.systemFocus(systemId)) ?? space.universeFocus,
      frame: INITIAL_FRAME,
      redraw,
    }),
    [systemId, space, redraw],
  );
  // The ship and the gestures reach what this stop names, told as each frame is projected rather than after React has
  // shown it: a list a few frames old catches the ship where a place was, above all while the view leans.
  const shipAnchors = useCallback(
    (anchors: readonly SpaceAnchor[]) => controller.setAnchors(anchors.filter(namedAt(stop, systemId))),
    [controller, stop, systemId],
  );
  const overlay = useCallback(
    (info: SpaceOverlayInfo) => {
      const own = ownAt(stop, systemId);
      const sun =
        stop === 'universe'
          ? undefined
          : info.anchors.find((anchor) => anchor.kind === 'system' && anchor.id === systemId);
      return (
        <VoyageOverlay
          anchors={info.anchors.filter(namedAt(stop, systemId))}
          written={STOPS[stop].written}
          keepOff={sun?.visible === true ? [squareAround(sun, SUN_CLEARANCE)] : []}
          size={size}
          focusId={focusId}
          hereId={hereId}
          onPlace={(id) => void session.focus(id)}
          onStation={(id) => onStation?.(id)}
          onDust={() => onDust?.()}
          stationLooks={stationLooks}
          reducedMotion={state.reducedMotion}
          landmarks={planet?.landmarks ?? NO_PENNANTS}
          pennantScale={stop === 'ground' ? GROUND_PENNANT_SCALE : 1}
          {...(search
            ? { search, stars: info.anchors.filter((anchor) => anchor.kind === 'system' && own(anchor)) }
            : {})}
        />
      );
    },
    [
      session,
      onStation,
      onDust,
      stop,
      systemId,
      size,
      focusId,
      hereId,
      search,
      planet,
      stationLooks,
      state.reducedMotion,
    ],
  );

  const stage = useRef<ComponentRef<typeof View>>(null);
  // The web's wheel: one notch is one stop.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const element = stage.current as unknown as HTMLElement | null;
    if (!element?.addEventListener) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      controller.wheel(event.deltaY);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [controller]);
  const onKeyDown: NonNullable<ViewProps['onKeyDown']> = (event) => {
    if (event.target !== event.currentTarget || !('key' in event.nativeEvent)) return;
    // Alt+Arrow is the browser's Back and Forward; Ctrl and Cmd are the person's own shortcuts.
    const modified = event.nativeEvent as { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean };
    if (modified.altKey === true || modified.ctrlKey === true || modified.metaKey === true) return;
    if (controller.key(event.nativeEvent.key)) event.preventDefault();
  };
  const measure = () => {
    const node = stage.current as unknown as {
      measureInWindow?: (callback: (x: number, y: number) => void) => void;
    } | null;
    node?.measureInWindow?.((x, y) => controller.setOrigin(x, y));
  };
  return (
    <View
      ref={stage}
      style={[StyleSheet.absoluteFill, WEB_TOUCH]}
      focusable
      onLayout={measure}
      {...(Platform.OS === 'web' ? { onKeyDown } : {})}
      {...controller.responder.panHandlers}
      testID="voyage-stage"
    >
      <SpaceView
        definition={space.definition}
        camera={camera}
        load={controller.load}
        overlay={overlay}
        fallback={(reason) => <Unavailable reason={reason} onUnavailable={onUnavailable} />}
        onAnchors={shipAnchors}
        {...(recordFrame ? { onFrameTime: recordFrame } : {})}
      />
      <FlightLine to={flying ? destinationOf(view, visitor) : null} size={size} onSkip={controller.skip} />
    </View>
  );
}

/**
 * The anchors of the star you are at, and dust: below the whole universe only that star is drawn, and the other stars'
 * bodies are hidden, but their anchors are still reported (a hidden parent leaves a child's own `visible` set).
 */
const ownAt =
  (stop: Stop, systemId: string | null) =>
  (anchor: SpaceAnchor): boolean =>
    stop === 'universe' || anchor.kind === 'dust' || anchor.systemId === systemId;

/** What a stop names: its kinds of place, of the star you are at. */
const namedAt = (stop: Stop, systemId: string | null) => {
  const own = ownAt(stop, systemId);
  return (anchor: SpaceAnchor): boolean => STOPS[stop].names.includes(anchor.kind) && own(anchor);
};

/** Where a flight to `view` goes, as the flight line says it. A visitor's whole universe is their friend's, not theirs. */
const destinationOf = (view: UniverseView, visitor: boolean): string => {
  if (view.kind === 'universe') return visitor ? 'the whole universe' : 'your universe';
  if (view.kind === 'system') return view.system.label;
  return view.selectedRegion?.label ?? view.planet.label;
};

/** Out of reach of assistive technology: the skip target between flights. */
const HIDDEN = {
  'aria-hidden': true,
  importantForAccessibility: 'no-hide-descendants',
  accessibilityElementsHidden: true,
} as const;

/** How far down the flight line sits: the prototype's 226 points on a phone, a fifth of the height on a desktop. */
const FLIGHT_LINE_TOP = { phone: 226, desktopShare: 0.2 } as const;

/**
 * While the camera flies (`to` is where; null between flights): one line saying where it is going, read out once, and a
 * tap anywhere skips to the end of the flight (the prototype's `skip`). The places are moving under the finger then, so
 * a tap is never taken for one of them. The tap target is named by the line itself, which is all a person sees of it.
 *
 * The tap target stays mounted between flights, letting every touch through and hidden from assistive technology. A
 * browser sends the rest of a touch to the element it started on: had the target gone on landing, fingers that came
 * down during a flight (a second pinch, a grab at the ship) would never be heard to move or lift again.
 */
function FlightLine({
  to,
  size,
  onSkip,
}: {
  readonly to: string | null;
  readonly size: { readonly width: number; readonly height: number };
  readonly onSkip: () => void;
}) {
  const top = size.width >= DESKTOP_WIDTH ? size.height * FLIGHT_LINE_TOP.desktopShare : FLIGHT_LINE_TOP.phone;
  const line = to === null ? null : `Going to ${to} · tap to skip`;
  return (
    <>
      {/* Never in the keyboard's tab order: between flights it is invisible, and during one focus on it would fall to the
      page on landing (React Native Web's Pressable makes itself a tab stop unless told `tabIndex={-1}`; `focusable` alone
      is ignored). Its role never changes: on the web the role picks the element, and a new element is the one thing
      the target must not become. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        pointerEvents={line === null ? 'none' : 'auto'}
        focusable={false}
        tabIndex={-1}
        accessibilityRole="button"
        {...(line === null ? HIDDEN : { accessibilityLabel: line })}
        onPress={line === null ? undefined : onSkip}
        testID="voyage-skip"
      />
      {/* Always there, so a screen reader hears the line when it appears, once; empty between flights. */}
      <View
        pointerEvents="none"
        style={[styles.flightLine, { top }]}
        accessibilityLiveRegion="polite"
        testID="voyage-flight-line"
      >
        {line === null ? null : (
          <Text variant="label" color={space.label} align="center" testID="voyage-flight">
            {line}
          </Text>
        )}
      </View>
    </>
  );
}

/** The planet the camera is at or going to, as the driver draws it: its world, what is charted and its palette. */
function usePlanetSurface(
  session: UniverseMapSession,
  state: SceneProps['state'],
  index: SceneProps['index'],
  view: UniverseView,
  visitor: boolean,
  landmarksByPlanet: ReadonlyMap<string, readonly CollectionLandmark[]> | undefined,
): VoyagePlanet | null {
  const looks = looksOfState(state);
  const planet = view.kind === 'planet' ? view.planet : undefined;
  const earned = (planet === undefined ? undefined : landmarksByPlanet?.get(planet.objectId)) ?? NO_LANDMARKS;
  const plan = useMemo(
    () => (planet ? planPlanet(planet, index.regions.get(planet.objectId) ?? [], looksById(looks)) : undefined),
    [planet, index, looks],
  );
  const globe = useGlobeWorld(session, plan?.spec);
  return useMemo(() => {
    if (!planet || !plan || globe.status !== 'ready') return null;
    // A friend shares no regions: their planet wears every continent in colour, as the old globe drew it, so it neither
    // looks unreached nor shows which places they have. Nothing on it is named, so nothing is tappable either.
    const charted = visitor
      ? Array.from({ length: plan.spec.siteCount }, (_, site) => ({ objectId: `${planet.objectId}:${site}`, site }))
      : plan.sites;
    const chart = chartWorld(globe.world, charted);
    const names = new Map((index.regions.get(planet.objectId) ?? []).map((region) => [region.objectId, region.label]));
    const hueShift = plan.look?.hueShift ?? 0;
    // Everything the painted texture depends on: a new look (its type or hue) repaints the globe as a new chart does.
    const sites = charted.map((site) => `${site.objectId}:${String(site.site)}`).join(',');
    return {
      key: `${planet.objectId}|${plan.spec.type}|${String(hueShift)}|${sites}`,
      planetId: planet.objectId,
      world: globe.world,
      chart,
      palette: paletteOf(plan.spec.type, hueShift),
      labels: visitor ? [] : labelPoints(chart),
      names,
      // A friend's planet shows nothing they earned (a visit shares no regions and no landmarks).
      landmarks: visitor ? [] : landmarkPoints(earned, plan.spec, globe.world, chart),
    };
  }, [planet, plan, globe, index, visitor, earned]);
}

/** A box no name may cover: the square round a body, `share` of its radius out from its middle. */
const squareAround = (anchor: SpaceAnchor, share: number) => {
  const reach = Math.max(anchor.radiusPx, MIN_BODY_RADIUS) * share;
  return { x: anchor.x - reach, y: anchor.y - reach, width: 2 * reach, height: 2 * reach };
};

/** A place's name, with what its station says on the map ("6 of 7 · Reel live"), as the old map shows it. */
const captioned = (anchor: SpaceAnchor): string =>
  anchor.mapCaption === undefined ? anchor.name : `${anchor.name} · ${anchor.mapCaption}`;

/**
 * Where names may not sit, as the prototype keeps them (its label pass, `top` and `bot`): clear of the header and of the
 * chips and caption at the bottom. On a desktop (the prototype's `W >= 900`) the bands are narrower.
 */
const LABEL_BANDS = {
  phone: { top: 150, bottom: 196 },
  desktop: { top: 64, bottom: 46 },
} as const;
const DESKTOP_WIDTH = 900;

/** The square a station's picture covers. */
const stationBox = (anchor: SpaceAnchor): Box => {
  const width = stationSize(anchor.radiusPx);
  return { x: anchor.x - width / 2, y: anchor.y - width / 2, width, height: width };
};

/**
 * The names of the places on screen, placed so that none covers another or the header and chips: each tries below,
 * above, right and left of its place, and a name with no free spot is left out until the camera comes closer (its
 * button keeps the name for a screen reader). The place the camera is at is placed first, then planets, systems and
 * regions, then rooms.
 */
function placeNames(
  anchors: readonly SpaceAnchor[],
  size: { readonly width: number; readonly height: number },
  focusId: string | null,
  hereId: string | null,
  keepOff: readonly Box[],
) {
  const bands = size.width >= DESKTOP_WIDTH ? LABEL_BANDS.desktop : LABEL_BANDS.phone;
  const requests: LabelRequest[] = anchors.map((anchor) => ({
    id: anchor.id,
    anchor: { x: anchor.x, y: anchor.y },
    clearance:
      anchor.id === hereId
        ? HERE_GAP
        : anchor.kind === 'region'
          ? REGION_NAME_GAP
          : anchor.kind === 'station'
            ? stationSize(anchor.radiusPx) / 2 + BODY_NAME_GAP
            : Math.max(anchor.radiusPx, MIN_BODY_RADIUS) + BODY_NAME_GAP,
    width:
      anchor.id === hereId
        ? labelWidth(writtenName(anchor, hereId), PILL_PADDING + HERE_DOT_ROOM)
        : labelWidth(writtenName(anchor, hereId)),
    height: LABEL_HEIGHT,
    priority: (anchor.id === hereId ? 8 : 0) + (anchor.id === focusId ? 6 : 0) + (anchor.kind === 'station' ? 0 : 1),
  }));
  return new Map(
    placeLabels(requests, size, [
      { x: 0, y: 0, width: size.width, height: bands.top },
      { x: 0, y: size.height - bands.bottom, width: size.width, height: bands.bottom },
      ...keepOff,
    ]).map((label) => [label.id, label]),
  );
}

/** The name written beside a place: the region the ship stands on says so, as the prototype's pill does. */
const writtenName = (anchor: SpaceAnchor, hereId: string | null): string =>
  anchor.id === hereId ? `${anchor.name} · you are here` : captioned(anchor);

/** A box on screen, in layout points. */
type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

function VoyageOverlay({
  anchors,
  written,
  keepOff,
  size,
  focusId,
  hereId,
  onPlace,
  onStation,
  onDust,
  search,
  stars = [],
  stationLooks,
  reducedMotion,
  landmarks,
  pennantScale,
}: {
  readonly anchors: readonly SpaceAnchor[];
  /** The kinds whose names are written beside them at this stop; the others are named for a screen reader only. */
  readonly written: readonly SpaceAnchor['kind'][];
  /** Where no name may sit, beside the header and the chips: a star's sun. */
  readonly keepOff: readonly Box[];
  readonly size: { readonly width: number; readonly height: number };
  readonly focusId: string | null;
  /** The region the ship stands on, named "you are here" under it; null above the ground. */
  readonly hereId: string | null;
  readonly onPlace: (id: string) => void;
  readonly onStation: (id: string) => void;
  readonly onDust: () => void;
  /** The sky's answer to an open search, drawn over everything but the buttons' touches. */
  readonly search?: SearchAnswer;
  /** The stars this stop draws, named or not: the whole sky from the whole universe, only the star you are at below it. */
  readonly stars?: readonly SpaceAnchor[];
  /** What each room's station is drawn from, by room id. */
  readonly stationLooks: ReadonlyMap<string, StationLook>;
  readonly reducedMotion: boolean;
  /** The pennants of the planet in view, by key, for their finish. */
  readonly landmarks: readonly LandmarkPoint[];
  readonly pennantScale: number;
}) {
  const shown = anchors.filter((anchor) => anchor.visible && anchor.kind !== 'landmark');
  const pennants = anchors.filter((anchor) => anchor.visible && anchor.kind === 'landmark');
  const stations = shown.filter((anchor) => anchor.kind === 'station');
  const names = placeNames(
    shown.filter((anchor) => written.includes(anchor.kind)),
    size,
    focusId,
    hereId,
    // A name is kept off the stations' pictures too, which are larger than the bodies they stand beside.
    [...keepOff, ...stations.map(stationBox)],
  );
  // Bodies orbit and pass close: crowded targets shrink and step apart so each stays a target of its own.
  const targets = new Map(
    separateTargets(shown.map((anchor) => ({ id: anchor.id, x: anchor.x, y: anchor.y, size: target.comfortable }))).map(
      (box) => [box.id, box],
    ),
  );
  // A friend's Universe answering "What we have in common": the shared systems, which the sky rings under the names.
  const common = search?.shows === 'common' ? new Set(search.lit ?? []) : undefined;
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {common ? <CommonSky shared={[...common]} anchors={stars} size={size} /> : null}
      {stations.length > 0 ? (
        <StationLayer anchors={stations} looks={stationLooks} reducedMotion={reducedMotion} />
      ) : null}
      {pennants.length > 0 ? <Pennants anchors={pennants} landmarks={landmarks} scale={pennantScale} /> : null}
      {shown.map((anchor) => {
        const box = targets.get(anchor.id)!;
        if (anchor.kind === 'dust')
          return (
            <BodyTarget
              key={anchor.id}
              x={box.x}
              y={box.y}
              size={box.size}
              floor={CROWDED_TARGET}
              label="Dust: something is forming"
              onPress={onDust}
              testID={`voyage-dust-${anchor.id}`}
            />
          );
        // Stations and pennants are not bodies: a station is a room, a pennant is never in this list (`Pennants`).
        const kind = anchor.kind === 'station' || anchor.kind === 'landmark' ? undefined : anchor.kind;
        const name = names.get(anchor.id);
        // Common: the names of systems you do not share drop to 0.4; those you share are announced as such.
        const shared = anchor.kind === 'system' && common?.has(anchor.id) === true;
        const unshared = anchor.kind === 'system' && common !== undefined && !shared;
        return (
          <View key={anchor.id} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
            {name === undefined ? null : shared || unshared ? (
              // While "What we have in common" is on, each system's name has a wrapper that says how much light it keeps.
              <View
                pointerEvents="none"
                testID={`voyage-name-${anchor.id}`}
                style={[StyleSheet.absoluteFill, unshared ? UNSHARED_NAME : null]}
              >
                <MapLabel label={name} text={writtenName(anchor, hereId)} variant="plain" />
              </View>
            ) : (
              <MapLabel
                label={name}
                text={writtenName(anchor, hereId)}
                variant={anchor.id === hereId ? 'here' : anchor.kind === 'region' ? 'land' : 'plain'}
              />
            )}
            <BodyTarget
              x={box.x}
              y={box.y}
              size={box.size}
              floor={CROWDED_TARGET}
              label={
                anchor.kind === 'station'
                  ? `${anchor.name}, a room`
                  : shared
                    ? `${anchor.name}, ${KIND_PHRASE.system}, you have this too`
                    : anchor.name
              }
              {...(kind && !shared ? { kind } : {})}
              onPress={() => (anchor.kind === 'station' ? onStation(anchor.id) : onPlace(anchor.id))}
              testID={`voyage-${anchor.kind}-${anchor.id}`}
            />
          </View>
        );
      })}
      {search && common === undefined ? <SearchSky answer={search} anchors={stars} size={size} /> : null}
    </View>
  );
}

/**
 * The pennants of what the person earned on the planet in view, where the globe faces the camera: the old globe's
 * `LandmarkMark`, standing on its spot. Not a place: never tapped, never a target for the ship, and hidden from
 * assistive technology, which reads the landmarks in the collection's list. It does not move, so reduced motion changes
 * nothing about it.
 */
function Pennants({
  anchors,
  landmarks,
  scale,
}: {
  readonly anchors: readonly SpaceAnchor[];
  readonly landmarks: readonly LandmarkPoint[];
  readonly scale: number;
}) {
  const tiers = new Map(landmarks.map((landmark) => [landmark.key, landmark.tier]));
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} {...HIDDEN} testID="voyage-pennants">
      <Svg width="100%" height="100%">
        {anchors.map((anchor) => {
          // An anchor of a landmark the planet no longer holds (a frame older than the read) is not drawn.
          const tier = tiers.get(anchor.id);
          return tier === undefined ? null : (
            <LandmarkMark key={anchor.id} at={{ x: anchor.x, y: anchor.y }} tier={tier} scale={scale} />
          );
        })}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  flightLine: { position: 'absolute', left: spacing[4], right: spacing[4] },
});
