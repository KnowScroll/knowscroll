import { useMemo, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { RoomStation } from '@knowscroll/contracts';
import type { SceneLook } from '@knowscroll/scene-core';
import { spacing } from '@knowscroll/design-tokens';
import { Icon, IconButton, SwitchRow, Tag, Text } from '@knowscroll/ui';
import { planPlanet } from '../planet/planet-plan';
import { looksById } from '../space/space-model';
import { countOf, listUniverse, nameWithTruth } from '../universe-lists';
import { viewFor, type UniverseIndex } from '../universe-layout';
import type { UniverseMapSession, UniverseViewState } from '../universe-session';
import { PlaceRow, RowGroup, SIMPLE } from './place-rows';
import { SystemSections } from './system-sections';

/**
 * Simple drawing (`simple-views-finalized.html`, D-111): the Universe tab as two plain lists and
 * nothing else. "Your universe" lists each system as a heading with its planets under it, then the
 * rooms; a planet lists its countries (regions). There is no 3D, no glass, no motion beyond the one
 * rippling dot, and land not reached yet is never listed or counted (D-109). The names and their
 * order are the 3D drawing's own, because both read the same index.
 *
 * It is on from the setting, and by itself when WebGL is missing, its context is lost, a frame fails
 * or memory is low (`SpaceView` says so), so the tab is never blank.
 */
export function SimpleUniverse({
  session,
  state,
  index,
  looks,
  stations,
  owner,
  top,
  bottom,
  banner,
  onSearch,
  onStation,
  onTurnOff,
  searchPanel,
  card,
  forcedPlanetId,
}: {
  readonly session: UniverseMapSession;
  readonly state: UniverseViewState;
  readonly index: UniverseIndex;
  readonly looks: readonly SceneLook[] | undefined;
  /** The person's own rooms. A friend's universe shows none. */
  readonly stations?: readonly RoomStation[];
  /** A friend's name, when this is their universe: no rooms, no regions, a title that names them. */
  readonly owner?: string;
  /** Room kept above the heading for the status bar, and below the last row for the tab bar. */
  readonly top: number;
  readonly bottom: number;
  /** What the visit puts above the lists (its bar) and the quiet status pill. */
  readonly banner?: ReactNode;
  readonly onSearch: () => void;
  readonly onStation?: (roomId: string) => void;
  /** The "Simple view" switch, turned off. Without it there is no switch (a planet whose own world could not be drawn). */
  readonly onTurnOff?: () => void;
  /** Search, when it is open: it takes the place of the heading. */
  readonly searchPanel?: ReactNode;
  /** A region's card, over the bottom of the list. */
  readonly card?: ReactNode;
  /** A planet to list even though the camera is not on it (its world could not be drawn). */
  readonly forcedPlanetId?: string;
}) {
  const view = viewFor(index, forcedPlanetId ?? state.focusId, state.landed);
  const subject = owner === undefined ? 'Your universe' : `${owner}’s universe`;
  return (
    <View testID="universe-simple" style={styles.ground}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: top, paddingBottom: bottom }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.column}>
          {banner}
          {searchPanel ??
            (view.kind === 'planet' ? (
              <PlanetHeading
                session={session}
                index={index}
                planetId={view.planet.objectId}
                subject={subject}
                onSearch={onSearch}
                owner={owner}
              />
            ) : (
              <UniverseHeading subject={subject} owner={owner} onSearch={onSearch} />
            ))}
          {view.kind === 'planet' ? (
            <PlanetRegions
              session={session}
              state={state}
              index={index}
              looks={looks}
              planetId={view.planet.objectId}
              owner={owner}
            />
          ) : (
            <SystemsAndRooms
              session={session}
              state={state}
              index={index}
              stations={owner === undefined ? stations : undefined}
              onStation={onStation}
              onTurnOff={onTurnOff}
              visitor={owner !== undefined}
            />
          )}
        </View>
      </ScrollView>
      {card ? (
        <View pointerEvents="box-none" style={[styles.card, { paddingBottom: bottom }]}>
          {card}
        </View>
      ) : null}
    </View>
  );
}

function UniverseHeading({
  subject,
  owner,
  onSearch,
}: {
  readonly subject: string;
  readonly owner: string | undefined;
  readonly onSearch: () => void;
}) {
  return (
    <View style={styles.headerRow}>
      <Text variant="displayL" heading={1} color={SIMPLE.ink} style={styles.title}>
        {subject}
      </Text>
      <SearchButton onPress={onSearch} owner={owner} />
    </View>
  );
}

function SearchButton({ onPress, owner }: { readonly onPress: () => void; readonly owner: string | undefined }) {
  return (
    <View style={styles.searchButton}>
      <IconButton
        icon="search"
        label={owner === undefined ? 'Search your universe' : `Search ${owner}’s universe`}
        variant="plain"
        onPress={onPress}
        testID="universe-search"
      />
    </View>
  );
}

function SystemsAndRooms({
  session,
  state,
  index,
  stations,
  onStation,
  onTurnOff,
  visitor,
}: {
  readonly session: UniverseMapSession;
  readonly state: UniverseViewState;
  readonly index: UniverseIndex;
  readonly stations: readonly RoomStation[] | undefined;
  readonly onStation: ((roomId: string) => void) | undefined;
  readonly onTurnOff: (() => void) | undefined;
  readonly visitor: boolean;
}) {
  const listed = useMemo(
    () => listUniverse(index, stations ?? [], state.youWereHere),
    [index, stations, state.youWereHere],
  );
  const planets = listed.systems.reduce((sum, system) => sum + system.planets.length, 0);
  return (
    <>
      <Text variant="bodyS" color={SIMPLE.ink2} style={styles.sub}>
        {`${countOf(listed.systems.length, 'system')} · ${countOf(planets, 'planet')}`}
      </Text>
      {onTurnOff ? (
        <View style={styles.mode}>
          <SwitchRow label="Simple view" description="Plain lists, for slow devices" on onChange={onTurnOff} />
        </View>
      ) : null}
      <SystemSections session={session} listed={listed} visitor={visitor} onStation={onStation} />
    </>
  );
}

function PlanetHeading({
  session,
  index,
  planetId,
  subject,
  onSearch,
  owner,
}: {
  readonly session: UniverseMapSession;
  readonly index: UniverseIndex;
  readonly planetId: string;
  readonly subject: string;
  readonly onSearch: () => void;
  readonly owner: string | undefined;
}) {
  const planet = index.byId.get(planetId);
  const system = planet ? index.byId.get(planet.parentId) : undefined;
  const regions = index.regions.get(planetId)?.length ?? 0;
  return (
    <>
      <View style={styles.headerRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Back to ${subject}`}
          onPress={() => session.up()}
          style={styles.back}
        >
          <Icon name="back" size={17} color={SIMPLE.ink} strokeWidth={2.4} />
          <Text variant="uiS" color={SIMPLE.ink} style={styles.backText}>
            {subject}
          </Text>
        </Pressable>
        <SearchButton onPress={onSearch} owner={owner} />
      </View>
      <View style={styles.planetTitle}>
        <View style={styles.titleRow}>
          <Text variant="displayL" heading={1} color={SIMPLE.ink} style={styles.title}>
            {planet?.label ?? ''}
          </Text>
          {planet?.truthStatus === 'hypothetical' ? <Tag label="Hypothetical" variant="hypothetical" /> : null}
        </View>
        <Text variant="bodyS" color={SIMPLE.ink2}>
          {`A planet in ${system?.label ?? subject}${owner === undefined ? ` · ${countOf(regions, 'country')}` : ''}`}
        </Text>
      </View>
    </>
  );
}

/** A planet's countries, in the order the map names them, and nothing for land that is not reached yet. */
function PlanetRegions({
  session,
  state,
  index,
  looks,
  planetId,
  owner,
}: {
  readonly session: UniverseMapSession;
  readonly state: UniverseViewState;
  readonly index: UniverseIndex;
  readonly looks: readonly SceneLook[] | undefined;
  readonly planetId: string;
  /** A friend's planet: regions are never shared, so there is nothing to list. */
  readonly owner: string | undefined;
}) {
  const planet = index.byId.get(planetId);
  const plan = useMemo(
    () => (planet ? planPlanet(planet, index.regions.get(planetId) ?? [], looksById(looks)) : undefined),
    [planet, planetId, index, looks],
  );
  if (!plan || owner !== undefined) return null;
  return (
    <View>
      <View style={styles.label}>
        <Text variant="label" color={SIMPLE.ink2}>
          Countries
        </Text>
        <Text variant="label" color={SIMPLE.ink2}>
          Tap to land
        </Text>
      </View>
      <RowGroup label={`Countries in ${planet?.label ?? 'this planet'}`}>
        {plan.regions.map(({ descriptor }) => {
          const here = state.youWereHere === descriptor.objectId;
          return (
            <PlaceRow
              key={descriptor.objectId}
              testID={`simple-region-${descriptor.objectId}`}
              title={descriptor.label}
              accessibilityLabel={nameWithTruth(descriptor.label, descriptor.truthStatus === 'hypothetical')}
              {...(here ? { meta: 'Last place you visited' } : {})}
              current={here}
              onPress={() => session.focus(descriptor.objectId)}
            />
          );
        })}
      </RowGroup>
    </View>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: '#FFFBF0' },
  content: { alignItems: 'center', paddingHorizontal: spacing[4] },
  column: { width: '100%', maxWidth: 640 },
  card: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: spacing[4], alignItems: 'center' },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing['2.5'],
    minHeight: 44,
  },
  title: { flexShrink: 1, fontSize: 30, lineHeight: 34 },
  searchButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(21,48,42,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sub: { marginTop: 2 },
  mode: {
    marginTop: spacing['3.5'],
    paddingHorizontal: spacing['3.5'],
    borderRadius: 16,
    backgroundColor: SIMPLE.mode,
  },
  systemHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing['2.5'],
    paddingTop: 26,
    paddingBottom: 10,
    paddingHorizontal: 4,
  },
  first: { paddingTop: 20 },
  systemName: { flexShrink: 1, minHeight: 44, justifyContent: 'center' },
  systemTitle: { fontSize: 23, lineHeight: 27 },
  label: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing['2.5'],
    paddingTop: 22,
    paddingBottom: 8,
    paddingHorizontal: 6,
  },
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingLeft: 8,
    paddingRight: 14,
    borderRadius: 14,
    backgroundColor: 'rgba(21,48,42,0.08)',
  },
  backText: { fontWeight: '800' },
  titleRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[2] },
  planetTitle: { marginTop: spacing['3.5'], gap: 4 },
});
