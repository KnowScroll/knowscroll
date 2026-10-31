import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, AppState, BackHandler, Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { claimFirstOpen, type AccountScope } from '@knowscroll/client-core';
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

type Answer = 'play' | 'skip';
const answers = new WeakMap<AccountScope, Promise<Answer>>();

/**
 * One claim of the first open per account scope for as long as the app runs, however many times the tab is mounted
 * (React's strict mode mounts twice). Once an opening has started, later mounts are told `skip`.
 */
function claimOnce(scope: AccountScope): Promise<Answer> {
  const known = answers.get(scope);
  if (known !== undefined) return known;
  const asked = Promise.race<Answer>([
    claimFirstOpen(scope),
    new Promise<Answer>((resolve) => setTimeout(() => resolve('skip'), CLAIM_TIMEOUT_MS)),
  ]);
  answers.set(scope, asked);
  return asked;
}
const started = (scope: AccountScope): void => void answers.set(scope, Promise.resolve('skip'));

/**
 * The Universe tab's first open (D-114): the animation plays once in the lifetime of the account, on the first device
 * to open the tab, and the tab is shown when it ends. The flag is claimed from the server just before it starts, so a
 * crash or a closed app never plays it again, and Skip and finishing both leave it seen. It does not play under reduced
 * motion, with Simple drawing, on the desktop layout or where 3D cannot be drawn, and then the flag is left alone.
 *
 * The real screen (`children`) is not drawn until the picture is nearly over, so only one 3D scene runs at a time for
 * most of it. It starts 1.2 s before it is shown, underneath. An account that has places gets a 0.3 s cross-fade to its real
 * map at 19.6 s, where the empty state would rise in (D-115); an account with none plays to the end and the empty
 * screen rises in over the last picture.
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
  const [phase, setPhase] = useState<'asking' | 'playing' | 'done'>(enabled ? 'asking' : 'done');
  useEffect(() => {
    if (!enabled || phase !== 'asking') return;
    let live = true;
    void claimOnce(scope).then((answer) => {
      if (live) setPhase(answer === 'play' ? 'playing' : 'done');
    });
    return () => {
      live = false;
    };
  }, [enabled, phase, scope]);

  if (phase === 'done' || (phase === 'asking' && !enabled)) return <>{children}</>;
  if (phase === 'asking') return <View testID="first-open-asking" style={styles.ground} />;
  return (
    <Opening scope={scope} endsOnEmpty={endsOnEmpty} empty={empty} onEnd={() => setPhase('done')}>
      {children}
    </Opening>
  );
}

function Opening({
  scope,
  endsOnEmpty,
  empty,
  onEnd,
  children,
}: {
  readonly scope: AccountScope;
  readonly endsOnEmpty: boolean;
  readonly empty: ReactNode;
  readonly onEnd: () => void;
  readonly children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const player = useMemo(() => createAnimationPlayer(rafScheduler), []);
  const [below, setBelow] = useState(false);
  const ends = useRef(endsOnEmpty);
  const end = useRef(onEnd);
  useEffect(() => {
    ends.current = endsOnEmpty;
    end.current = onEnd;
  });

  useLayoutEffect(() => {
    started(scope);
    const offFrames = player.subscribe((run) => {
      if (run.t >= MOUNT_BELOW_AT) setBelow(true);
      // An account with places (or an unavailable map) meets its real screen at 19.6 s, after a 0.3 s cross-fade.
      if (!ends.current && run.t >= firstOpenSeconds(true)) player.finish();
    });
    const offEnd = player.onEnd(() => end.current());
    player.start('first-open', FIRST_OPEN.seconds);
    return () => {
      offFrames();
      offEnd();
      player.dispose();
    };
  }, [player, scope]);

  // Back, Escape and Skip all jump to the end (design: "Skip always works").
  const skip = useCallback(() => player.finish(), [player]);
  useEffect(() => {
    const hardware = BackHandler.addEventListener('hardwareBackPress', () => {
      skip();
      return true;
    });
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') skip();
    };
    if (Platform.OS === 'web') window.addEventListener('keydown', key);
    const app = AppState.addEventListener('change', (next) => {
      // A closed or hidden app does not hold the opening back: it ends, and the flag stays set.
      if (next !== 'active') skip();
    });
    return () => {
      hardware.remove();
      if (Platform.OS === 'web') window.removeEventListener('keydown', key);
      app.remove();
    };
  }, [skip]);

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
  const load = useMemo(() => loadFirstOpenRenderer(() => player.current()?.t ?? FIRST_OPEN.seconds), [player]);
  const fallback = useCallback(() => <Failed onFailure={skip} />, [skip]);

  return (
    <View testID="first-open" style={styles.ground}>
      {below ? (
        <View
          pointerEvents="none"
          aria-hidden
          importantForAccessibility="no-hide-descendants"
          style={StyleSheet.absoluteFill}
        >
          {children}
        </View>
      ) : null}
      <Animated.View
        pointerEvents="box-none"
        style={[StyleSheet.absoluteFill, { opacity: picture }]}
        accessibilityLabel="Your universe is opening"
        role="img"
      >
        <SpaceView definition={EMPTY_SKY} load={load} fallback={fallback} />
      </Animated.View>
      {endsOnEmpty && below ? (
        <Reveal player={player} rising={rising} style={StyleSheet.absoluteFill}>
          {empty}
        </Reveal>
      ) : null}
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
    </View>
  );
}

/** 3D cannot be drawn: the opening ends at once and the tab opens. */
function Failed({ onFailure }: { readonly onFailure: () => void }) {
  useEffect(onFailure, [onFailure]);
  return null;
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: space.s0 },
  skip: { position: 'absolute', right: layout.topControlsInset },
});
