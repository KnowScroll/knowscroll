import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@knowscroll/ui';
import type { RailStop } from './rail-stops';

/** The rail's place: at the right edge, a third of the way down a phone, three tenths on a desktop (the prototype's). */
const RAIL_RIGHT = 8;
const RAIL_TOP_SHARE = { phone: 0.33, desktop: 0.3 } as const;
/** A stop's button: at least this wide and tall, so each dot is a target of its own. */
const STOP_TARGET = 44;
/** The prototype's colours: a cream dot for a stop, the yellow of "you are here", on a dark pill for its name. */
const DOT = 'rgba(255,253,242,0.45)';
const CURRENT_DOT = '#FFE44D';
const NAME = '#FFFDF2';
const NAME_PILL = 'rgba(2,3,8,0.55)';
/** About how wide a letter of the current stop's name is, and what its pill adds round it (padding, gap, dot). */
const NAME_LETTER = 7.2;
const PILL_EXTRA = 40;

const railTop = (height: number, desktop: boolean): number =>
  Math.round(height * (desktop ? RAIL_TOP_SHARE.desktop : RAIL_TOP_SHARE.phone));

/** The box the rail takes on a stage of `size`, so the names of places keep out from under it. */
export function railBox(
  stops: readonly RailStop[],
  size: { readonly width: number; readonly height: number },
  desktop: boolean,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const current = stops.find((stop) => stop.current);
  const width = Math.max(STOP_TARGET, current === undefined ? 0 : current.name.length * NAME_LETTER + PILL_EXTRA);
  return {
    x: size.width - RAIL_RIGHT - width,
    y: railTop(size.height, desktop),
    width,
    height: stops.length * STOP_TARGET,
  };
}

/**
 * The level rail (`rail-stops.ts` says which stops): a dot per stop, the current one yellow with its name, each a button
 * "Go to …" that flies there. Read top to bottom it is the ladder from the farthest out to the ground, and a screen
 * reader hears it as one group that says so.
 */
export function LevelRail({
  stops,
  height,
  desktop,
  onGo,
}: {
  readonly stops: readonly RailStop[];
  /** The stage's height, for where the rail stands. */
  readonly height: number;
  readonly desktop: boolean;
  readonly onGo: (stop: RailStop['stop']) => void;
}) {
  const top = railTop(height, desktop);
  return (
    <View
      pointerEvents="box-none"
      style={[styles.rail, { top }]}
      accessibilityRole="toolbar"
      accessibilityLabel="Where you are, from the ground out to other people’s universes"
      testID="voyage-rail"
    >
      {stops.map(({ stop, name, current }) => (
        <Pressable
          key={stop}
          accessibilityRole="button"
          accessibilityLabel={`Go to ${name}`}
          aria-current={current ? 'true' : undefined}
          onPress={() => onGo(stop)}
          style={styles.stop}
          testID={`voyage-rail-${stop}`}
        >
          <View style={[styles.mark, current ? styles.currentMark : null]}>
            {current ? (
              <Text variant="label" color={NAME} style={styles.name}>
                {name}
              </Text>
            ) : null}
            <View style={current ? styles.currentDot : styles.dot} />
          </View>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: { position: 'absolute', right: RAIL_RIGHT, alignItems: 'flex-end' },
  stop: { minWidth: STOP_TARGET, height: STOP_TARGET, alignItems: 'flex-end', justifyContent: 'center' },
  mark: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 30, paddingHorizontal: 4 },
  currentMark: { paddingLeft: 10, paddingRight: 6, borderRadius: 999, backgroundColor: NAME_PILL },
  name: { fontSize: 10, lineHeight: 12, letterSpacing: 0.8, textTransform: 'uppercase' },
  dot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: DOT },
  currentDot: { width: 11, height: 11, borderRadius: 5.5, backgroundColor: CURRENT_DOT },
});
