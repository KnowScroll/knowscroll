import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, AppState, BackHandler, Platform, StyleSheet, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { claimFirstOpen, firstOpenSeen, type AccountScope, type FirstOpenAnswer } from '@knowscroll/client-core';
import { layout, space, spacing } from '@knowscroll/design-tokens';
import { loadFirstOpenRenderer } from '../space/load-space-renderer';
import type { SpaceDefinition } from '../space/space-definition';
import { SpaceView } from '../space/space-view';
import { SpaceChip } from '../space-chip';
import { Reveal, usePlayerValue } from './animated';
import { FIRST_OPEN, firstOpenFrame, firstOpenSeconds, pictureOpacityAt } from './first-open-timeline';
import { createAnimationPlayer } from './player';
import { rafScheduler } from './use-universe-animation';

/** How long a person waits for the account to answer before the tab simply opens: a missed opening is better than a held tab. */
const CLAIM_TIMEOUT_MS = 4_000;
/** The real screen starts drawing beneath the picture this long before it is shown. */
const MOUNT_BELOW_AT = 19.0;
/** The empty sky the opening ends on (U01 Empty). */
const EMPTY_SKY: SpaceDefinition = {
  camera: { position: [0, 4, 30], target: [0, 0, 0], drift: 1.6, fogRange: [60, 140] },
  systems: [],
};

const answers = new WeakMap<AccountScope, Promise<FirstOpenAnswer>>();

/**
 * One claim of the first open per account scope for as long as the app runs, however many times the tab is mounted
 * (React's strict mode mounts twice). Once an opening has started, later mounts are told `seen`. The wait for an answer
 * ends after {@link CLAIM_TIMEOUT_MS}, and its timer is cleared as soon as the answer comes.
 */
function claimOnce(scope: AccountScope): Promise<FirstOpenAnswer> {
  const known = answers.get(scope);
  if (known !== undefined) return known;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<FirstOpenAnswer>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), CLAIM_TIMEOUT_MS);
  });
  const asked = Promise.race([claimFirstOpen(scope), timeout]).finally(() => clearTimeout(timer));
  answers.set(scope, asked);
  return asked;
}
const started = (scope: AccountScope): void => void answers.set(scope, Promise.resolve('seen'));

/**
 * The Universe tab's first open (D-114): the animation plays once in the lifetime of the account, on the first device
 * to open the tab. The flag is claimed from the server just before the picture starts, and only after the picture's own
 * WebGL context exists, so a device that cannot draw it leaves the flag alone. A crash or a closed app never plays it
 * twice, and Skip, Back, Escape and finishing all leave it seen. It does not play under reduced motion, with Simple
 * drawing, on the desktop layout or on a low-memory device. A device that knows the opening is used up (it was told
 * so before) does not even ask.
 *
 * `children` stay in one place in the tree for the whole life of the screen and are only covered: the real screen
 * starts drawing beneath the picture 1.2 s before it is shown, and when the picture goes it is the very screen that was
 * already drawing, with its 3D canvas, so the first frame of the real sky is the last frame of the picture (D-115). An
 * account with places gets a 0.3 s cross-fade to its real map at 19.6 s; an account with none plays to the end and the
 * empty screen rises over the last picture.
 */
export function FirstOpenGate({
  scope,
  enabled,
  endsOnEmpty,
  empty,
  children,
}: {
  readonly scope: AccountScope;
  /** Whether an opening may play on this device now. */
  readonly enabled: boolean;
  /** The screen under the picture is the empty universe, so the opening runs to its end and rises into it. */
  readonly endsOnEmpty: boolean;
  /** The empty universe, drawn without its own sky, to rise in over the picture. */
  readonly empty: ReactNode;
  readonly children: ReactNode;
}) {
  const [phase, setPhase] = useState<'preparing' | 'playing' | 'done'>(() =>
    enabled && !firstOpenSeen(scope) ? 'preparing' : 'done',
  );
  const [below, setBelow] = useState(false);
  const shown = phase === 'preparing' && !enabled ? 'done' : phase;
  const covered = shown !== 'done';
  const showChildren = shown === 'done' || (shown === 'playing' && below);
  return (
    <View style={styles.fill}>
      <View
        pointerEvents={covered ? 'none' : 'box-none'}
        aria-hidden={covered}
        importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'}
        style={styles.fill}
      >
        {showChildren ? children : null}
      </View>
      {shown === 'done' ? null : (
        <Opening
          scope={scope}
          playing={shown === 'playing'}
          endsOnEmpty={endsOnEmpty}
          empty={empty}
          onPlay={() => setPhase('playing')}
          onBelow={() => setBelow(true)}
          onEnd={() => setPhase('done')}
        />
      )}
    </View>
  );
}

function Opening({
  scope,
  playing,
  endsOnEmpty,
  empty,
  onPlay,
  onBelow,
  onEnd,
}: {
  readonly scope: AccountScope;
  readonly playing: boolean;
  readonly endsOnEmpty: boolean;
  readonly empty: ReactNode;
  readonly onPlay: () => void;
  readonly onBelow: () => void;
  readonly onEnd: () => void;
}) {
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const player = useMemo(() => createAnimationPlayer(rafScheduler), []);
  const ends = useRef(endsOnEmpty);
  const callbacks = useRef({ onPlay, onBelow, onEnd });
  const isPlaying = useRef(playing);
  useEffect(() => {
    ends.current = endsOnEmpty;
    isPlaying.current = playing;
    callbacks.current = { onPlay, onBelow, onEnd };
  });

  // The picture's own WebGL context exists: now, and only now, the account is asked whether this is its one opening.
  const ready = useCallback(() => {
    // A renderer made again while it plays (a context restored after the app was away) is not a new opening.
    if (isPlaying.current) return;
    void claimOnce(scope).then((answer) => {
      if (answer === 'play') callbacks.current.onPlay();
      else callbacks.current.onEnd();
    });
  }, [scope]);
  // A device that cannot draw the picture leaves the flag alone and opens the tab.
  const failed = useCallback(() => callbacks.current.onEnd(), []);

  useLayoutEffect(() => {
    if (!playing) return;
    started(scope);
    let belowTold = false;
    const offFrames = player.subscribe((run) => {
      if (run.t >= MOUNT_BELOW_AT && !belowTold) {
        belowTold = true;
        callbacks.current.onBelow();
      }
      // An account with places (or an unavailable map) meets its real screen at 19.6 s, after a 0.3 s cross-fade.
      if (!ends.current && run.t >= firstOpenSeconds(true)) player.finish();
    });
    const offEnd = player.onEnd(() => callbacks.current.onEnd());
    player.start('first-open', FIRST_OPEN.seconds);
    return () => {
      offFrames();
      offEnd();
    };
  }, [player, playing, scope]);
  useEffect(() => () => player.dispose(), [player]);

  // Back, Escape and Skip all jump to the end (design: "Skip always works"). The system Back is held only while this tab is in front.
  const skip = useCallback(() => player.finish(), [player]);
  useEffect(() => {
    if (!playing) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') skip();
    };
    if (Platform.OS === 'web') window.addEventListener('keydown', key);
    // A closed or hidden app does not hold the opening back: it ends, and the flag stays set.
    const app = AppState.addEventListener('change', (next) => {
      if (next !== 'active') skip();
    });
    const hardware = focused
      ? BackHandler.addEventListener('hardwareBackPress', () => {
          skip();
          return true;
        })
      : undefined;
    return () => {
      hardware?.remove();
      if (Platform.OS === 'web') window.removeEventListener('keydown', key);
      app.remove();
    };
  }, [playing, focused, skip]);

  const picture = usePlayerValue(
    player,
    useMemo(() => (t: number) => pictureOpacityAt(t, !endsOnEmpty), [endsOnEmpty]),
    1,
  );
  const skipOpacity = usePlayerValue(
    player,
    useMemo(() => (t: number) => firstOpenFrame(t).skip, []),
    1,
  );
  const rising = useMemo(() => (t: number) => firstOpenFrame(t).empty.title, []);
  const load = useMemo(() => loadFirstOpenRenderer(() => player.current()?.t ?? 0), [player]);
  const fallback = useCallback(() => <Failed onFailure={failed} />, [failed]);

  return (
    <View
      testID={playing ? 'first-open' : 'first-open-preparing'}
      pointerEvents="box-none"
      style={StyleSheet.absoluteFill}
    >
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.ground]} />
      <Animated.View
        pointerEvents="box-none"
        style={[StyleSheet.absoluteFill, { opacity: picture }]}
        accessibilityLabel="Your universe is opening"
        role="img"
      >
        <SpaceView definition={EMPTY_SKY} load={load} onReady={ready} fallback={fallback} />
      </Animated.View>
      {playing && endsOnEmpty ? (
        <Reveal player={player} rising={rising} style={StyleSheet.absoluteFill}>
          {empty}
        </Reveal>
      ) : null}
      {playing ? (
        <Animated.View
          pointerEvents="box-none"
          style={[styles.skip, { top: insets.top + spacing[3], opacity: skipOpacity }]}
        >
          <SpaceChip
            testID="first-open-skip"
            variant="solid"
            label="Skip"
            accessibilityLabel="Skip the opening"
            onPress={skip}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

/** 3D cannot be drawn: the opening ends at once and the tab opens, with the account's opening untouched. */
function Failed({ onFailure }: { readonly onFailure: () => void }) {
  useEffect(onFailure, [onFailure]);
  return null;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  ground: { backgroundColor: space.s0 },
  skip: { position: 'absolute', right: layout.topControlsInset },
});
