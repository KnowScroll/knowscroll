import { useMemo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text as NativeText, View } from 'react-native';
import { chartWorld, type SceneDescriptor, type SceneLook } from '@knowscroll/scene-core';
import { borderWidth, radius, space, spacing } from '@knowscroll/design-tokens';
import { Icon, Text } from '@knowscroll/ui';
import { PlanetGlobe } from '../planet/planet-globe';
import { SpaceChip } from '../space-chip';
import { paletteOf } from '../planet/planet-palette';
import { planPlanet } from '../planet/planet-plan';
import { useGlobeWorld } from '../planet/use-planet-world';
import { looksById } from '../space/space-model';
import { countOf } from '../universe-lists';
import type { SearchResult } from '../universe-search';
import type { UniverseMapSession } from '../universe-session';
import { PlanetDisc } from './dial-art';
import type { DialPlanet, PlanetMatch } from './dial-model';

/** The yellow ring that marks the chosen place, and the yellow under matched letters. */
export const CHOSEN = space.focus;

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
}: {
  readonly name: string;
  readonly match: SearchResult['match'] | undefined;
  readonly variant: 'displayXl' | 'displayL' | 'title' | 'uiS';
  readonly color: string;
  readonly heading?: 2;
  readonly center?: boolean;
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
      {to > from ? <NativeText style={{ color: CHOSEN }}>{name.slice(from, to)}</NativeText> : null}
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
      accessibilityLabel={`${planet.name}, a planet`}
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

/** O4: the matching planets of the current system, and one row for what matched in the others. */
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
        <SpaceChip
          label={`In ${system} ${here.length}`}
          toggled={!everywhere}
          variant={everywhere ? 'ghost' : 'solid'}
          accessibilityLabel={`In ${system}, ${here.length}`}
          onPress={() => onScope(false)}
        />
        <SpaceChip
          label={`Everywhere ${here.length + elsewhere.length}`}
          toggled={everywhere}
          variant={everywhere ? 'solid' : 'ghost'}
          accessibilityLabel={`Everywhere, ${here.length + elsewhere.length}`}
          onPress={() => onScope(true)}
        />
      </View>
      <Text variant="label" color={space.label2}>
        {everywhere
          ? `${countOf(shown.length, 'planet')} everywhere`
          : `${countOf(here.length, 'planet')} in ${system}`}
      </Text>
      {shown.map((match) => (
        <Pressable
          key={match.planet.id}
          accessibilityRole="button"
          accessibilityLabel={`${match.planet.name}, a planet in ${match.system.name}`}
          onPress={() => onChoose(match)}
          style={styles.resultRow}
        >
          <PlanetDisc planet={match.planet} size={34} />
          <View style={styles.resultWords}>
            <MatchedName name={match.planet.name} match={match.result.match} variant="title" color={space.label} />
            <Text variant="label" color={space.label2} numberOfLines={1}>
              {`Planet · ${countOf(match.planet.regions, 'region')}${match.planet.here ? ' · You were here' : ''}${everywhere ? ` · ${match.system.name}` : ''}`}
            </Text>
          </View>
          <Icon name="forward" size={18} color={space.label2} />
        </Pressable>
      ))}
      {!everywhere && first ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Also elsewhere: ${first.planet.name} in ${first.system.name}`}
          onPress={() => onScope(true)}
          style={styles.elsewhere}
        >
          <Text variant="uiS" color={space.label}>
            {`Also elsewhere: ${first.planet.name} in ${first.system.name}`}
          </Text>
        </Pressable>
      ) : null}
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
  results: {
    gap: spacing[2],
    padding: spacing[4],
    borderRadius: radius.card,
    borderWidth: borderWidth.hairline,
    borderColor: space.edge,
    backgroundColor: 'rgba(11,26,46,0.82)',
  },
  scope: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], minHeight: 56, borderRadius: radius.md },
  resultWords: { flex: 1, gap: 2 },
  elsewhere: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing[3],
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,251,240,0.08)',
  },
});
