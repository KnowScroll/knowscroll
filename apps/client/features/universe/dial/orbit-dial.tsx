import { ScrollView, StyleSheet, View } from 'react-native';
import type { RoomStation } from '@knowscroll/contracts';
import type { SceneLook } from '@knowscroll/scene-core';
import { space, spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import { SpaceChip } from '../space-chip';
import type { UniverseIndex } from '../universe-layout';
import type { UniverseMapSession, UniverseViewState } from '../universe-session';
import { PlanetResults } from './dial-parts';
import { DialFilters, DialTop, PlanetFace, PlanetWheel, SystemPill, SystemWheel, WheelFacts } from './dial-sections';
import { useOrbitDial, type OrbitDialState } from './use-orbit-dial';

/**
 * The orbit dial (O1 to O4), which replaces the List view: a wheel of the person's systems, the
 * planets of the chosen one on a dial under it with its big planet above, a search for systems and
 * one for planets, and the filters All, Lately, With rooms and A–Z. Touch the system row to open the
 * wheel, turn it, let go to choose. It is built on this device from what the Universe already holds:
 * nothing is read for it, nothing is written, and the query is never sent or kept. It lists only
 * what has formed (D-109), so land not reached yet is not in it.
 */
export function OrbitDial({
  session,
  state,
  index,
  looks,
  stations,
  owner,
  top,
  bottom,
  onSimple,
}: {
  readonly session: UniverseMapSession;
  readonly state: UniverseViewState;
  readonly index: UniverseIndex;
  readonly looks: readonly SceneLook[] | undefined;
  /** The person's own rooms. A friend's universe has none. */
  readonly stations?: readonly RoomStation[];
  /** A friend's name, when the dial is theirs. */
  readonly owner?: string;
  /** Room kept above for the status bar, and below for the tab bar. */
  readonly top: number;
  readonly bottom: number;
  /** Turns Simple drawing on, from the dial's own chip. */
  readonly onSimple: () => void;
}) {
  const visitor = owner !== undefined;
  const dial = useOrbitDial({ session, state, index, looks, stations, visitor });
  const { system } = dial;
  const hasPlanets = system !== undefined && system.planets.length > 0;
  return (
    <View testID="universe-dial" style={styles.ground}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: top, paddingBottom: bottom }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.column}>
          <DialTop dial={dial} session={session} title={visitor ? `${owner}’s universe` : 'Your universe'} />
          {dial.open ? <DialFilters dial={dial} /> : null}
          {system === undefined ? (
            <NoSystem dial={dial} />
          ) : dial.open ? (
            <>
              <SystemWheel dial={dial} />
              <WheelFacts dial={dial} system={system} visitor={visitor} />
            </>
          ) : dial.planetSearch ? (
            // O4: the matches first, then the dial of planets with the matches lit.
            <>
              <PlanetResults
                system={system.name}
                here={dial.planetSearch.here}
                elsewhere={dial.elsewhere}
                everywhere={dial.everywhere}
                onChoose={(match) => session.focus(match.planet.id)}
                onScope={dial.setEverywhere}
              />
              {hasPlanets ? <PlanetWheel dial={dial} system={system} /> : null}
            </>
          ) : (
            <>
              <SystemWheel dial={dial} />
              <SystemPill dial={dial} system={system} session={session} />
              {hasPlanets ? (
                <>
                  <PlanetFace
                    dial={dial}
                    system={system}
                    session={session}
                    index={index}
                    looks={looks}
                    visitor={visitor}
                  />
                  <PlanetWheel dial={dial} system={system} />
                </>
              ) : (
                <NoPlanets name={system.name} />
              )}
            </>
          )}
          <View style={styles.footer}>
            <SpaceChip label="Simple view" toggled={false} onPress={onSimple} />
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

/** Nothing on the wheel: the filter or the search left no system, or the map has none yet. */
function NoSystem({ dial }: { readonly dial: OrbitDialState }) {
  return (
    <View style={styles.none}>
      <Text variant="body" color={space.label}>
        {dial.systemMatches ? 'No system has that name.' : 'No systems here yet.'}
      </Text>
      {dial.filter !== 'all' ? <Button label="Show all" variant="space" onPress={() => dial.setFilter('all')} /> : null}
    </View>
  );
}

/** A system that has formed with no planet in it yet: there is no big planet to show or dial to turn. */
function NoPlanets({ name }: { readonly name: string }) {
  return (
    <View style={styles.none} testID="dial-no-planets">
      <Text variant="body" color={space.label}>
        {`No planets in ${name} yet.`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: '#020308' },
  content: { alignItems: 'center', paddingHorizontal: spacing[4] },
  column: { width: '100%', maxWidth: 520, gap: spacing[3] },
  none: { alignItems: 'center', gap: spacing[3], paddingTop: spacing[8] },
  footer: { alignItems: 'center', paddingTop: spacing[3] },
});
