import { memo, useId, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, G, Path, RadialGradient, Stop } from 'react-native-svg';
import { space, spacing, universe as palette } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';
import { BUBBLE_COLOURS } from '../../crossing/crossing-bubble';
import { LABEL_HEIGHT, labelWidth, BodyTarget, MapLabel } from '../../scene-parts';
import { placeLabels, type LabelRequest, type PlacedLabel } from '../../universe-layout';
import { SpaceChip } from '../../space-chip';
import { bubblePaths } from './bubble-paths';
import {
  friendButtonName,
  friendDrawnName,
  friendsLine,
  initialOf,
  OUTER_TITLE,
  OWN_UNIVERSE_NAME,
  type OuterStatus,
} from './outer-copy';
import {
  INITIAL_DISC,
  INITIAL_GAP,
  layoutField,
  TITLE_ROOM,
  type Bands,
  type DecorationSpot,
  type FriendSpot,
  type Point,
  type Viewport,
} from './friend-field';
import type { OuterFriend } from './friend-order';

/**
 * The outer stop's flat layer, drawn over the canvas as the room stations are: your universe as one bubble near the
 * middle, your friends' universes round it with their names, the prototype's seven unnamed universes as decoration, and
 * the title with its line. Each friend on screen also has one 48 px button (only while `buttonsLive`), and the tap goes to
 * `onCross`. Colours are literal Universe palette values: the Universe is the same in Light and Dark.
 *
 * Nothing here reads the account or the network: the friends are a prop. Nothing in it is stored or logged.
 */

/** Out of reach of assistive technology: the buttons name every friend, this is only their picture. */
const HIDDEN = {
  'aria-hidden': true,
  importantForAccessibility: 'no-hide-descendants',
  accessibilityElementsHidden: true,
} as const;

/** The prototype's unnamed universes are cool where a friend's is warm. */
const COOL = ['#DCE4FF', '#B4C2FF', '#C9B4F0'] as const;
const WARM_HALO = { colour: 'rgb(255,226,190)', alpha: 0.28 } as const;
const COOL_HALO = { colour: 'rgb(190,206,255)', alpha: 0.2 } as const;
const COOL_OPACITY = 0.5;
const DOT_OPACITY = 0.75;
/** The initial's disc is the Universe's focus yellow; its letter is Ink. */
const DISC = INITIAL_DISC;
const DISC_GAP = INITIAL_GAP;
/** Your own bubble: the web reaches this share of its drawn radius beyond the rim. */
const OWN_WEB = 1.3;

/** One bubble: the soft halo (as the prototype's sprite) and the web, in three paths, moved to (x, y). */
const Bubble = memo(function Bubble({
  x,
  y,
  radius,
  seed,
  cool,
  every,
}: {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly seed: string;
  readonly cool: boolean;
  readonly every: number;
}) {
  const id = `outer-halo-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const { paths } = useMemo(() => bubblePaths(seed, radius, every), [seed, radius, every]);
  const halo = cool ? COOL_HALO : WARM_HALO;
  const colours = cool ? COOL : BUBBLE_COLOURS;
  return (
    <G transform={`translate(${x} ${y})`} opacity={cool ? COOL_OPACITY : 1}>
      <Defs>
        <RadialGradient id={id} cx="0" cy="0" r={radius} gradientUnits="userSpaceOnUse">
          <Stop offset="0.6" stopColor="rgb(255,220,180)" stopOpacity="0" />
          <Stop offset="0.72" stopColor={halo.colour} stopOpacity={halo.alpha} />
          <Stop offset="1" stopColor="rgb(255,200,150)" stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Circle cx="0" cy="0" r={radius} fill={`url(#${id})`} />
      {paths.map((d, index) => (
        <Path key={index} d={d} fill={colours[index]} fillOpacity={DOT_OPACITY} />
      ))}
    </G>
  );
});

/** Your own bubble: a warm rim ring (the prototype's `mark`) round a web seeded `you`, as the film seeds yours. */
const OwnBubble = memo(function OwnBubble({
  x,
  y,
  radius,
  web,
}: {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly web: boolean;
}) {
  const id = `outer-rim-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const { paths } = useMemo(() => bubblePaths('you', radius * OWN_WEB, 1), [radius]);
  return (
    <G transform={`translate(${x} ${y})`}>
      <Defs>
        <RadialGradient id={id} cx="0" cy="0" r={radius * 1.1} gradientUnits="userSpaceOnUse">
          <Stop offset="0.727" stopColor="rgb(255,214,176)" stopOpacity="0.07" />
          <Stop offset="0.91" stopColor="rgb(255,214,176)" stopOpacity="0.3" />
          <Stop offset="1" stopColor="rgb(255,214,176)" stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Circle cx="0" cy="0" r={radius * 1.1} fill={`url(#${id})`} />
      {web
        ? paths.map((d, index) => <Path key={index} d={d} fill={BUBBLE_COLOURS[index]} fillOpacity={DOT_OPACITY} />)
        : null}
    </G>
  );
});

export interface OuterLayerProps {
  /**
   * Where your universe sits on screen at rest, and how big it is drawn; `fade` (0 to 1) eases the whole layer in and
   * out. Null draws nothing. `pan` is applied on top: a caller whose centre already carries the pan passes `{0, 0}`.
   */
  readonly universe: {
    readonly x: number;
    readonly y: number;
    readonly radiusPx: number;
    readonly fade: number;
  } | null;
  /** The field's offset in px. It moves everything in the layer, your universe included. */
  readonly pan: Point;
  /** Every friend, in the order they take their places (`orderFriends`); the layer draws the ones in view, at most ten. */
  readonly friends: readonly OuterFriend[];
  readonly viewport: Viewport;
  /** Friend buttons are mounted only while true, so a half-made pinch or a flight never starts a film. */
  readonly buttonsLive: boolean;
  readonly reducedMotion: boolean;
  /** A tap on a friend's universe (or Enter on its button): the handle to cross to. */
  readonly onCross: (handle: string) => void;
  /** Where the read of the friends has got to; the line under the title says it. Default `ready`. */
  readonly status?: OuterStatus;
  /** Read the friends again (shown as a chip after a failure). */
  readonly onRetry?: () => void;
  /** Draw a web for your own bubble. Off when the real stars already make one (the lead's call from frames). Default on. */
  readonly ownWeb?: boolean;
  /** The stage's bands, when this screen lets go of its chips here. */
  readonly bands?: Bands;
  /** The title's top, in px. Default: 14 above the free band's top, as the prototype hangs it. */
  readonly titleTop?: number;
}

/** The boxes a name must stay clear of: every bubble's web, every initial disc, and the title. */
function blockersOf(
  home: { x: number; y: number; radius: number },
  friends: readonly FriendSpot[],
  decorations: readonly DecorationSpot[],
  title: { top: number; height: number },
  width: number,
) {
  const box = (x: number, y: number, half: number) => ({ x: x - half, y: y - half, width: half * 2, height: half * 2 });
  return [
    box(home.x, home.y, home.radius),
    ...decorations.map((spot) => box(spot.x, spot.y, spot.radius)),
    ...friends.flatMap((spot) => [
      box(spot.x, spot.y, spot.radius * 0.72),
      box(spot.x, spot.y - spot.radius - DISC_GAP, DISC / 2),
    ]),
    { x: 0, y: title.top, width, height: title.height },
  ];
}

/** The names under the bubbles: "Ravi’s universe" where there is room, "Ravi" where there is not, none where neither fits. */
function namesOf(
  home: { x: number; y: number; radius: number },
  friends: readonly FriendSpot[],
  blockers: readonly { x: number; y: number; width: number; height: number }[],
  viewport: Viewport,
): {
  readonly own: PlacedLabel | undefined;
  readonly friends: ReadonlyMap<string, { label: PlacedLabel; text: string }>;
} {
  const request = (
    id: string,
    x: number,
    y: number,
    clearance: number,
    text: string,
    priority: number,
  ): LabelRequest => ({
    id,
    anchor: { x, y },
    clearance,
    width: labelWidth(text),
    height: LABEL_HEIGHT,
    priority,
  });
  const ownRequest = request('own', home.x, home.y, home.radius + 4, OWN_UNIVERSE_NAME, 100);
  const place = (short: boolean) =>
    placeLabels(
      [
        ownRequest,
        ...friends.map((spot, order) =>
          request(spot.handle, spot.x, spot.y, spot.radius * 0.9 + 2, friendDrawnName(spot.name, short), 50 - order),
        ),
      ],
      viewport,
      blockers,
    );
  // One form for every friend on screen: "Ravi’s universe" when each has room for it, else the bare names.
  const long = place(false);
  const short = !friends.every((spot) => long.some((placed) => placed.id === spot.handle));
  const placed = short ? place(true) : long;
  const texts = new Map<string, { label: PlacedLabel; text: string }>();
  for (const spot of friends) {
    const label = placed.find((entry) => entry.id === spot.handle);
    if (label) texts.set(spot.handle, { label, text: friendDrawnName(spot.name, short) });
  }
  return { own: placed.find((entry) => entry.id === 'own'), friends: texts };
}

export function OuterLayer({
  universe,
  pan,
  friends,
  viewport,
  buttonsLive,
  reducedMotion,
  onCross,
  status = 'ready',
  onRetry,
  ownWeb = true,
  bands,
  titleTop,
}: OuterLayerProps) {
  const layout = useMemo(
    () =>
      universe === null
        ? null
        : layoutField(friends, {
            viewport,
            universe: { x: universe.x, y: universe.y, radiusPx: universe.radiusPx },
            pan,
            ...(bands === undefined ? {} : { bands }),
          }),
    [universe, friends, viewport, pan, bands],
  );
  const fade = universe === null ? 0 : reducedMotion ? (universe.fade > 0 ? 1 : 0) : universe.fade;
  const top = titleTop ?? (layout === null ? 0 : layout.band.top - 14);
  const names = useMemo(() => {
    if (layout === null) return null;
    const blockers = blockersOf(
      layout.home,
      layout.friends,
      layout.decorations,
      { top, height: TITLE_ROOM + 14 },
      viewport.width,
    );
    return namesOf(layout.home, layout.friends, blockers, viewport);
  }, [layout, top, viewport]);
  if (layout === null || names === null || fade <= 0.001) return null;
  const { home } = layout;
  // An initial's disc is left out where it would sit on the title or its line (a short screen's field runs up to them).
  const titleBottom = top + TITLE_ROOM;
  const failed = status === 'offline' || status === 'failed';
  return (
    <View testID="outer-layer" pointerEvents="box-none" style={[StyleSheet.absoluteFill, { opacity: fade }]}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill} {...HIDDEN} testID="outer-drawing">
        <Svg width={viewport.width} height={viewport.height} viewBox={`0 0 ${viewport.width} ${viewport.height}`}>
          {layout.decorations.map((spot) => (
            <Bubble key={spot.id} x={spot.x} y={spot.y} radius={spot.radius} seed={spot.seed} cool every={2} />
          ))}
          <OwnBubble x={home.x} y={home.y} radius={home.radius} web={ownWeb} />
          {layout.friends.map((spot) => (
            <Bubble
              key={spot.handle}
              x={spot.x}
              y={spot.y}
              radius={spot.radius}
              seed={spot.seed}
              cool={false}
              every={1}
            />
          ))}
        </Svg>
        {layout.friends
          .filter((spot) => spot.y - spot.radius - DISC_GAP - DISC / 2 >= titleBottom)
          .map((spot) => (
            <View
              key={spot.handle}
              testID={`outer-initial-${spot.handle}`}
              style={[styles.disc, { left: spot.x - DISC / 2, top: spot.y - spot.radius - DISC_GAP - DISC / 2 }]}
            >
              <Text variant="uiS" color={palette.ink} align="center">
                {initialOf(spot.name)}
              </Text>
            </View>
          ))}
        {names.own ? <MapLabel label={names.own} text={OWN_UNIVERSE_NAME} /> : null}
        {layout.friends.map((spot) => {
          const named = names.friends.get(spot.handle);
          return named ? <MapLabel key={spot.handle} label={named.label} text={named.text} /> : null;
        })}
      </View>
      <View pointerEvents="none" style={[styles.words, { top }]}>
        <Text variant="heading" heading={1} color={space.label}>
          {OUTER_TITLE}
        </Text>
        <Text variant="label" color={space.label2} aria-live="polite" testID="outer-line">
          {friendsLine(friends.length, status)}
        </Text>
      </View>
      {failed && onRetry !== undefined ? (
        <View style={[styles.retry, { top: top + 66 }]}>
          <SpaceChip testID="outer-retry" variant="solid" icon="arrowRight" label="Try again" onPress={onRetry} />
        </View>
      ) : null}
      {buttonsLive
        ? layout.friends.map((spot) => (
            <BodyTarget
              key={spot.handle}
              testID={`outer-friend-${spot.handle}`}
              x={spot.x}
              y={spot.y}
              size={Math.max(48, Math.round(spot.radius * 1.6))}
              label={friendButtonName(spot.name)}
              plain
              onPress={() => onCross(spot.handle)}
            />
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  words: { position: 'absolute', left: spacing[4], right: spacing[4], gap: spacing[1] },
  retry: { position: 'absolute', left: spacing[4], flexDirection: 'row' },
  disc: {
    position: 'absolute',
    width: DISC,
    height: DISC,
    borderRadius: DISC / 2,
    backgroundColor: palette.focus,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
