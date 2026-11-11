import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import type { SceneLook } from '@knowscroll/scene-core';
import { borderWidth, content, radius, space, spacing, target } from '@knowscroll/design-tokens';
import { Button, Icon, IconButton, Text } from '@knowscroll/ui';
import type { UniverseIndex } from '../universe-layout';
import { countOf, nameWithTruth } from '../universe-lists';
import type { UniverseMapSession } from '../universe-session';
import { PlanetDisc, SunDisc } from './dial-art';
import { DIAL_FILTERS, type DialSystem } from './dial-model';
import { DialGlobe, Hint, InfoChip, MatchedName, PlanetDial, WordTab } from './dial-parts';
import { Wheel } from './dial-wheel';
import type { OrbitDialState } from './use-orbit-dial';

/** The top of the dial: the pill back to the map and search, or the search field when searching. */
export function DialTop({
  dial,
  session,
  title,
}: {
  readonly dial: OrbitDialState;
  readonly session: UniverseMapSession;
  readonly title: string;
}) {
  if (dial.searching) {
    const label = dial.searching === 'systems' ? 'Search your systems' : 'Search your planets';
    return (
      <View style={styles.bar}>
        <View style={styles.field}>
          <Icon name="search" size={20} color={content.ink} />
          <TextInput
            autoFocus
            value={dial.query}
            onChangeText={dial.setQuery}
            role="searchbox"
            accessibilityLabel={label}
            placeholder={label}
            placeholderTextColor={content.ink2}
            autoCorrect={false}
            style={styles.input}
          />
          {dial.query ? (
            <IconButton icon="close" label="Clear search" variant="plain" onPress={() => dial.setQuery('')} />
          ) : null}
        </View>
        <Button label="Cancel" variant="space" size="sm" onPress={dial.stopSearch} />
      </View>
    );
  }
  return (
    <View style={styles.header}>
      <Pressable
        testID="dial-close"
        accessibilityRole="button"
        accessibilityLabel="Close the orbit dial"
        onPress={() => session.back()}
        style={styles.pill}
      >
        <Icon name="universe" size={18} color={content.ink} />
        <Text variant="ui" color={content.ink}>
          {title}
        </Text>
      </Pressable>
      <View style={styles.tools}>
        <IconButton
          icon="search"
          label={dial.open ? 'Search systems' : 'Search planets'}
          variant="onSpace"
          onPress={dial.startSearch}
          testID="dial-search"
        />
        {dial.open ? (
          <IconButton
            icon="filter"
            label="Filter systems"
            variant="onSpace"
            onPress={dial.toggleFilters}
            pressed={dial.filtersShown}
            testID="dial-filter"
          />
        ) : null}
      </View>
    </View>
  );
}

/**
 * All, Lately, With rooms and A–Z as plain words, as the file draws them: the chosen one bright with a
 * yellow dot under it, how many systems All and With rooms keep beside them, and Lately's green dot.
 */
export function DialFilters({ dial }: { readonly dial: OrbitDialState }) {
  return (
    <View role="group" aria-label="Filters" style={styles.filters}>
      {DIAL_FILTERS.map(({ id, label }) => (
        <WordTab
          key={id}
          label={label}
          chosen={dial.filter === id}
          count={id === 'all' ? dial.counts.all : id === 'rooms' ? dial.counts.rooms : undefined}
          lately={id === 'lately'}
          onPress={() => dial.setFilter(id)}
        />
      ))}
    </View>
  );
}

/** The row of systems: small suns across the top at rest, big named ones while it is open (O1, O3). */
export function SystemWheel({ dial }: { readonly dial: OrbitDialState }) {
  const { shown, open } = dial;
  return (
    <Wheel
      testID="dial-systems"
      label="Systems"
      count={shown.length}
      chosen={dial.systemAt}
      gap={open ? 132 : 92}
      height={open ? 150 : 74}
      onTurn={dial.turn}
      onChoose={(next) => dial.chooseSystem(shown[next]!.id)}
      renderItem={(position, distance) => {
        const entry = shown[position]!;
        const chosen = distance < 0.5;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={nameWithTruth(
              `${entry.name}, a system, ${countOf(entry.planetCount, 'planet')}`,
              entry.hypothetical,
            )}
            aria-current={chosen ? 'true' : undefined}
            onPress={() => dial.chooseSystem(entry.id)}
            style={[styles.sunItem, { height: open ? 150 : 74, opacity: Math.max(0.4, 1 - distance * 0.3) }]}
          >
            <SunDisc
              size={(open ? 40 : 22) * (chosen ? 1.35 : 1 - Math.min(distance, 2) * 0.15)}
              haze={entry.haze}
              quiet={entry.quiet}
            />
            {open ? (
              <MatchedName
                name={entry.name}
                match={dial.systemMatches?.find((match) => match.id === entry.id)?.match}
                variant="uiS"
                color={space.label2}
                center
              />
            ) : null}
          </Pressable>
        );
      }}
    />
  );
}

/** At rest the chosen system is its name and a chevron (touch it to open the wheel), as the file draws it. */
export function SystemPill({ dial, system }: { readonly dial: OrbitDialState; readonly system: DialSystem }) {
  return (
    <View style={styles.centre}>
      <Pressable
        testID="dial-system-pill"
        accessibilityRole="button"
        accessibilityLabel={nameWithTruth(`${system.name}, choose another system`, system.hypothetical)}
        onPress={dial.openWheel}
        style={styles.systemPill}
      >
        <Text variant="uiS" color={space.label} style={styles.systemName}>
          {system.name}
        </Text>
        <Icon name="chevronDown" size={14} color={space.label} />
      </Pressable>
    </View>
  );
}

/** O1 and O2: "System 4 of 7", its name large, what it holds, and its planets faded under it. */
export function WheelFacts({
  dial,
  system,
  visitor,
}: {
  readonly dial: OrbitDialState;
  readonly system: DialSystem;
  readonly visitor: boolean;
}) {
  const matched = dial.systemMatches !== undefined;
  return (
    <>
      <View style={styles.facts} testID="dial-system-facts">
        <Text variant="label" color={space.label2}>
          {matched
            ? `${dial.systemAt + 1} of ${dial.shown.length} systems match`
            : `System ${dial.systemAt + 1} of ${dial.shown.length}`}
        </Text>
        <MatchedName
          name={system.name}
          match={dial.systemMatches?.find((match) => match.id === system.id)?.match}
          variant="displayXl"
          color={space.label}
          heading={2}
          center
        />
        <View style={styles.chips}>
          <InfoChip label={countOf(system.planetCount, 'planet')} />
          {visitor ? null : <InfoChip label={countOf(system.rooms, 'room')} />}
          {visitor ? null : <InfoChip label={countOf(system.regions, 'region')} />}
          {system.here ? <InfoChip label="You’re here" dot /> : null}
        </View>
        <Hint>
          {dial.turning
            ? 'Turning · let go to choose'
            : matched
              ? 'Tap to choose · swipe for the next match'
              : 'Tap a system to choose · turn for the next'}
        </Hint>
      </View>
      <View style={styles.faded} pointerEvents="none" aria-hidden importantForAccessibility="no-hide-descendants">
        <Text variant="label" color={space.label2}>{`Planets in ${system.name}`}</Text>
        <View style={styles.fadedRow}>
          {system.planets.map((entry) => (
            <PlanetDisc key={entry.id} planet={entry} size={44} />
          ))}
        </View>
      </View>
    </>
  );
}

/** O3: the big planet at the top of the dial, and what it holds. */
export function PlanetFace({
  dial,
  system,
  session,
  index,
  looks,
  visitor,
}: {
  readonly dial: OrbitDialState;
  readonly system: DialSystem;
  readonly session: UniverseMapSession;
  readonly index: UniverseIndex;
  readonly looks: readonly SceneLook[] | undefined;
  readonly visitor: boolean;
}) {
  const planet = system.planets[dial.planetAt]!;
  return (
    <>
      <DialGlobe
        key={planet.id}
        session={session}
        descriptor={index.byId.get(planet.id)!}
        regions={visitor ? [] : (index.regions.get(planet.id) ?? [])}
        looks={looks}
        diameter={176}
        onLand={() => session.focus(planet.id, { land: !visitor && planet.regions > 0 })}
        landLabel={visitor || planet.regions === 0 ? `Open ${planet.name}` : `Land on ${planet.name}`}
      />
      <View style={styles.facts} testID="dial-planet-facts">
        <Text variant="label" color={space.label2}>
          {`Planet ${dial.planetAt + 1} of ${system.planets.length} · ${planet.type} world`}
        </Text>
        <Text variant="displayL" heading={2} color={space.label} align="center">
          {planet.name}
        </Text>
        <View style={styles.chips}>
          {visitor ? null : <InfoChip label={countOf(planet.regions, 'region')} />}
          {planet.here ? <InfoChip label="You were here" dot /> : null}
        </View>
      </View>
    </>
  );
}

/** The dial of the system's planets: turn it to choose; with a search, the matches light up and the rest fade (O4). */
export function PlanetWheel({ dial, system }: { readonly dial: OrbitDialState; readonly system: DialSystem }) {
  const searched = dial.planetSearch !== undefined;
  return (
    <>
      <Wheel
        testID="dial-planets"
        label="Planets"
        count={system.planets.length}
        chosen={dial.planetAt}
        gap={104}
        height={112}
        onChoose={(next) => dial.choosePlanet(system.planets[next]!.id)}
        renderItem={(position, distance) => {
          const entry = system.planets[position]!;
          return (
            <PlanetDial
              planet={entry}
              distance={distance}
              lit={!searched || dial.lit.has(entry.id)}
              size={52}
              onPress={() => dial.choosePlanet(entry.id)}
            />
          );
        }}
      />
      <Hint>{searched ? 'Matches light up on the dial' : 'Turn the dial · tap the big planet to land'}</Hint>
    </>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: target.comfortable,
    paddingHorizontal: spacing[4],
    borderRadius: radius.pill,
    backgroundColor: space.control,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing[2] },
  bar: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  field: {
    flex: 1,
    minHeight: target.comfortable,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingLeft: spacing[4],
    paddingRight: spacing[1],
    borderRadius: radius.pill,
    backgroundColor: content.paper,
    borderWidth: borderWidth.regular,
    borderColor: space.focus,
  },
  input: { flex: 1, minHeight: target.comfortable, color: content.ink, fontSize: 16, outlineStyle: 'none' as never },
  // The sun's haze is wider than the wheel is tall: the button is the wheel's height and clips it, so its box never reaches the header.
  sunItem: { alignItems: 'center', justifyContent: 'center', minWidth: 96, minHeight: 64, overflow: 'hidden' },
  centre: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing[2] },
  systemPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 44,
    paddingHorizontal: spacing[3],
  },
  systemName: { fontWeight: '800' },
  tools: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: spacing[5],
    paddingLeft: spacing[1],
  },
  facts: { alignItems: 'center', gap: spacing[2] },
  faded: { alignItems: 'center', gap: spacing[3], paddingTop: spacing[4] },
  fadedRow: { flexDirection: 'row', gap: spacing[6], opacity: 0.3 },
});
