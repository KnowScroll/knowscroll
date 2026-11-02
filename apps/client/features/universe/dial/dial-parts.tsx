import { useMemo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text as NativeText, View } from 'react-native';
import { chartWorld, type SceneDescriptor, type SceneLook } from '@knowscroll/scene-core';
import { borderWidth, radius, space, spacing } from '@knowscroll/design-tokens';
import { Text, toggleSemantics, useFocusRing } from '@knowscroll/ui';
import { PlanetGlobe } from '../planet/planet-globe';
import { paletteOf } from '../planet/planet-palette';
import { planPlanet } from '../planet/planet-plan';
import { useGlobeWorld } from '../planet/use-planet-world';
import { looksById } from '../space/space-model';
import { countOf, nameWithTruth } from '../universe-lists';
import type { SearchResult } from '../universe-search';
import type { UniverseMapSession } from '../universe-session';
import { PlanetDisc } from './dial-art';
import type { DialPlanet, PlanetMatch } from './dial-model';

/** The yellow ring that marks the chosen place, and the yellow under matched letters. */
export const CHOSEN = space.focus;

const PAPER = '#FFFDF2';
const PAPER_INK = '#15302A';
const PAPER_INK2 = 'rgba(21,48,42,0.7)';
const PAPER_TOP = '#F4EDD8';
const MARK = '#FFEC7A';

/**
 * A plain word that is a choice (the file's `fchip` and `kind`): the chosen one bright with a yellow
 * dot under it, an optional count raised beside it, and Lately's green dot. Never an outlined pill.
 */
export function WordTab({
  label,
  chosen,
  count,
  lately = false,
  accessibilityLabel,
  onPress,
}: {
  readonly label: string;
  readonly chosen: boolean;
  readonly count?: number | undefined;
  readonly lately?: boolean;
  readonly accessibilityLabel?: string;
  readonly onPress: () => void;
}) {
  const focus = useFocusRing('onDark');
  return (
    <Pressable
      {...toggleSemantics(chosen)}
      accessibilityLabel={accessibilityLabel ?? (count === undefined ? label : `${label}, ${count}`)}
      onPress={onPress}
      {...focus.props}
      style={[styles.word, focus.style]}
    >
      <Text variant="uiS" color={chosen ? space.label : space.label2} style={chosen ? styles.wordOn : null}>
        {label}
      </Text>
      {count === undefined ? null : (
        <Text variant="metaS" color={space.label2} style={styles.wordCount}>
          {count}
        </Text>
      )}
      {lately ? <View style={styles.wordLately} /> : null}
      {chosen ? <View style={styles.wordMark} /> : null}
    </Pressable>
  );
}

/** A small dark pill of fact ("3 planets", "You're here"); a fact, never a control. */
export function InfoChip({ label, dot = false }: { readonly label: string; readonly dot?: boolean }) {
  return (
    <View style={styles.chip}>
      {dot ? <View style={styles.chipDot} /> : null}
      <Text variant="uiS" color={space.label}>
        {label}
      </Text>
    </View>
  );
}

/** A name with the letters that matched in yellow. Without a match it is the plain name. */
export function MatchedName({
  name,
  match,
  variant,
  color,
  heading,
  center = false,
  onPaper = false,
}: {
  readonly name: string;
  readonly match: SearchResult['match'] | undefined;
  readonly variant: 'displayXl' | 'displayL' | 'title' | 'uiS';
  readonly color: string;
  readonly heading?: 2;
  readonly center?: boolean;
  /** On a paper card the matched letters sit on yellow, in ink (the file's `mark`). */
  readonly onPaper?: boolean;
}) {
  const [from, to] = match ?? [0, 0];
  return (
    <Text
      variant={variant}
      color={color}
      {...(heading ? { heading } : {})}
      {...(center ? { align: 'center' as const } : {})}
    >
      {name.slice(0, from)}
      {to > from ? (
        <NativeText style={onPaper ? { color: PAPER_INK, backgroundColor: MARK } : { color: CHOSEN }}>
          {name.slice(from, to)}
        </NativeText>
      ) : null}
      {name.slice(to)}
    </Text>
  );
}

/**
 * The big planet of the dial: the real globe of the planet at the top of the dial, from the same world
 * the planet's own view draws (so its names and shapes agree). A tap lands on it.
 */
export function DialGlobe({
  session,
  descriptor,
  regions,
  looks,
  diameter,
  onLand,
  landLabel,
}: {
  readonly session: UniverseMapSession;
  readonly descriptor: SceneDescriptor;
  readonly regions: readonly SceneDescriptor[];
  readonly looks: readonly SceneLook[] | undefined;
  readonly diameter: number;
  readonly onLand: () => void;
  readonly landLabel: string;
}) {
  const plan = useMemo(() => planPlanet(descriptor, regions, looksById(looks)), [descriptor, regions, looks]);
  const palette = useMemo(() => paletteOf(plan.spec.type, plan.look?.hueShift ?? 0), [plan]);
  const globe = useGlobeWorld(session, plan.spec);
  const world = globe.status === 'ready' ? globe.world : undefined;
  const chart = useMemo(() => (world ? chartWorld(world, plan.sites) : undefined), [world, plan]);
  const labels = useMemo(
    () => new Map(plan.regions.map(({ descriptor: region }) => [region.objectId, region.label])),
    [plan],
  );
  // PlanetGlobe sizes itself from the box it is given: a box of these proportions gives this diameter.
  const box = { width: diameter / 0.75, height: diameter / 0.36 };
  return (
    <View pointerEvents="box-none" style={[styles.globe, { height: diameter * 1.25 }]}>
      <View
        pointerEvents="box-none"
        style={[styles.globeBox, box, { top: -box.height * 0.44 + (diameter * 1.25) / 2 }]}
      >
        {world && chart ? (
          <PlanetGlobe
            world={world}
            chart={chart}
            palette={palette}
            labels={labels}
            size={box}
            frame={{ x: 0, y: 0, scale: 1 }}
            reducedMotion
            rings={plan.look?.rings ?? false}
            moon={plan.look?.moon ?? false}
            onLand={onLand}
            landLabel={landLabel}
          />
        ) : null}
      </View>
    </View>
  );
}

/** One planet of the dial row: a painted ball with its name under it; the chosen one wears the yellow ring. */
export function PlanetDial({
  planet,
  distance,
  lit,
  size,
  onPress,
}: {
  readonly planet: DialPlanet;
  readonly distance: number;
  /** In O4, whether the planet matches the search; the rest fade. */
  readonly lit: boolean;
  readonly size: number;
  readonly onPress: () => void;
}) {
  const chosen = distance < 0.5;
  const ball = chosen ? size : size * 0.74;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={nameWithTruth(`${planet.name}, a planet`, planet.hypothetical)}
      aria-current={chosen ? 'true' : undefined}
      onPress={onPress}
      style={[styles.dialItem, { opacity: lit ? (chosen ? 1 : 0.85) : 0.35 }]}
    >
      <View style={[styles.ring, chosen ? { borderColor: CHOSEN } : null, { width: ball + 12, height: ball + 12 }]}>
        <PlanetDisc planet={planet} size={ball} />
      </View>
      <Text variant="uiS" color={space.label} align="center" numberOfLines={2} style={styles.dialName}>
        {planet.name}
      </Text>
    </Pressable>
  );
}

/**
 * O4: "In Earth 1 / Everywhere 3" as words above a paper card of the matching planets of the current
 * system, and one row for what matched in the others.
 */
export function PlanetResults({
  system,
  here,
  elsewhere,
  everywhere,
  onChoose,
  onScope,
}: {
  readonly system: string;
  readonly here: readonly PlanetMatch[];
  readonly elsewhere: readonly PlanetMatch[];
  readonly everywhere: boolean;
  readonly onChoose: (match: PlanetMatch) => void;
  readonly onScope: (everywhere: boolean) => void;
}) {
  const shown = everywhere ? [...here, ...elsewhere] : here;
  const first = elsewhere[0];
  return (
    <View testID="dial-planet-results" style={styles.results}>
      <View role="group" aria-label="Where to look" style={styles.scope}>
        <WordTab
          label={`In ${system}`}
          count={here.length}
          chosen={!everywhere}
          accessibilityLabel={`In ${system}, ${here.length}`}
          onPress={() => onScope(false)}
        />
        <WordTab
          label="Everywhere"
          count={here.length + elsewhere.length}
          chosen={everywhere}
          accessibilityLabel={`Everywhere, ${here.length + elsewhere.length}`}
          onPress={() => onScope(true)}
        />
      </View>
      <View style={styles.paper}>
        <Text variant="label" color={PAPER_INK2}>
          {everywhere
            ? `${countOf(shown.length, 'planet')} everywhere`
            : `${countOf(here.length, 'planet')} in ${system}`}
        </Text>
        {shown.map((match, position) => (
          <Pressable
            key={match.planet.id}
            accessibilityRole="button"
            accessibilityLabel={nameWithTruth(
              `${match.planet.name}, a planet in ${match.system.name}`,
              match.planet.hypothetical,
            )}
            onPress={() => onChoose(match)}
            style={[styles.resultRow, position === 0 ? styles.resultTop : null]}
          >
            <View style={styles.resultWords}>
              <MatchedName
                name={match.planet.name}
                match={match.result.match}
                variant="title"
                color={PAPER_INK}
                onPaper
              />
              <Text variant="label" color={PAPER_INK2} numberOfLines={1}>
                {`Planet · ${countOf(match.planet.regions, 'region')}${match.planet.here ? ' · You were here' : ''}${everywhere ? ` · ${match.system.name}` : ''}`}
              </Text>
            </View>
          </Pressable>
        ))}
        {!everywhere && first ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={nameWithTruth(
              `Also elsewhere: ${first.planet.name} in ${first.system.name}`,
              first.planet.hypothetical,
            )}
            onPress={() => onScope(true)}
            style={styles.elsewhere}
          >
            <Text variant="uiS" color={PAPER_INK2}>
              {`Also elsewhere: ${first.planet.name} in ${first.system.name}`}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function Hint({ children }: { readonly children: ReactNode }) {
  return (
    <Text variant="label" color={space.label2} align="center">
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['1.5'],
    paddingHorizontal: spacing[3],
    minHeight: 32,
    borderRadius: radius.pill,
    borderWidth: borderWidth.hairline,
    borderColor: space.edge,
    backgroundColor: 'rgba(255,251,240,0.06)',
  },
  chipDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#FF684C' },
  globe: { width: '100%', alignItems: 'center', overflow: 'visible' },
  globeBox: { position: 'absolute' },
  dialItem: { width: 112, alignItems: 'center', gap: spacing[1] },
  ring: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  dialName: { fontWeight: '700' },
  word: { minHeight: 44, minWidth: 44, justifyContent: 'center', paddingRight: spacing[2] },
  wordOn: { fontWeight: '800' },
  wordCount: { position: 'absolute', right: -6, top: 8 },
  wordLately: {
    position: 'absolute',
    right: -4,
    top: 12,
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#14C79B',
  },
  wordMark: {
    position: 'absolute',
    bottom: 3,
    alignSelf: 'center',
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: CHOSEN,
  },
  results: { gap: spacing[1] },
  scope: { flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing[5], paddingLeft: spacing[1] },
  paper: { gap: spacing[1], padding: spacing[3], borderRadius: 16, backgroundColor: PAPER },
  resultRow: { justifyContent: 'center', minHeight: 56, paddingHorizontal: spacing[2], borderRadius: 10 },
  resultTop: { backgroundColor: PAPER_TOP },
  resultWords: { gap: 2 },
  elsewhere: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing[2],
    borderTopWidth: 1,
    borderTopColor: 'rgba(21,48,42,0.1)',
  },
});
