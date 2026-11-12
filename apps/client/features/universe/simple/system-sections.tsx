import { Pressable, StyleSheet, View } from 'react-native';
import { spacing } from '@knowscroll/design-tokens';
import { Text, useFocusRing } from '@knowscroll/ui';
import { countOf, nameWithTruth, type ListedUniverse } from '../universe-lists';
import type { UniverseMapSession } from '../universe-session';
import { PlaceRow, RowGroup, SIMPLE } from './place-rows';

/**
 * A map of thousands of systems lists this many, in the map's order; the person reaches the rest by search, and the list
 * says so. A list of every system would be thousands of rows, and a screen reader would read them all (D-417).
 */
export const LISTED_SYSTEM_LIMIT = 60;

/**
 * The list the Simple view and the desktop panel share: each system's name as a heading with the
 * number of its planets, its planets as rows under it (how many countries each holds, or where the
 * person was), and the rooms at the end. It lists only what has formed (D-109); a visitor's rows say
 * nothing about regions, because regions are never shared.
 */
export function SystemSections({
  session,
  listed,
  visitor = false,
  hereSystemId,
  pickedId,
  onStation,
  onSystem,
}: {
  readonly session: UniverseMapSession;
  readonly listed: ListedUniverse;
  readonly visitor?: boolean;
  /** The system the camera is in: it carries a "You are here" tag. */
  readonly hereSystemId?: string | null;
  /** The planet picked on the map, awaiting Land. */
  readonly pickedId?: string | null;
  readonly onStation?: (roomId: string) => void;
  /** Where a system's name can be pressed because the map shows the result (the desktop panel); the Simple view has none. */
  readonly onSystem?: (systemId: string) => void;
}) {
  const shown = listed.systems.slice(0, LISTED_SYSTEM_LIMIT);
  return (
    <>
      {shown.map((system, position) => (
        <View key={system.id} testID={`simple-system-${system.id}`}>
          <View style={[styles.systemHead, position === 0 ? styles.first : null]}>
            <View style={styles.systemWords}>
              {onSystem ? (
                <SystemButton
                  name={system.name}
                  hypothetical={system.hypothetical}
                  onPress={() => onSystem(system.id)}
                />
              ) : (
                <Text
                  variant="title"
                  heading={2}
                  color={SIMPLE.ink}
                  accessibilityLabel={nameWithTruth(system.name, system.hypothetical)}
                  style={styles.systemTitle}
                >
                  {system.name}
                </Text>
              )}
              {hereSystemId === system.id ? (
                <Text variant="label" color={SIMPLE.ink2}>
                  You are here
                </Text>
              ) : null}
            </View>
            <Text variant="uiS" color={SIMPLE.ink2}>
              {countOf(system.planetCount, 'planet')}
            </Text>
          </View>
          {visitor ? null : (
            // A system's Reels and Scrolls are its way in before it has a planet (#697); a friend's list has none.
            <RowGroup label={`Watch or read in ${system.name}`}>
              <PlaceRow
                testID={`simple-system-finds-${system.id}`}
                title="Watch or read"
                meta={`Reels and Scrolls in ${system.name}`}
                accessibilityLabel={`Watch or read in ${system.name}`}
                onPress={() => session.showFinds(system.id)}
              />
            </RowGroup>
          )}
          <RowGroup label={`Planets in ${system.name}`}>
            {system.loaded || system.planetCount === 0 ? null : (
              // The planets of a system load when it is opened; the row says so and opens it.
              <PlaceRow
                testID={`simple-system-open-${system.id}`}
                title="Show planets"
                meta={countOf(system.planetCount, 'planet')}
                accessibilityLabel={`Show the planets of ${system.name}`}
                onPress={() => session.focus(system.id)}
              />
            )}
            {system.planets.map((planet) => (
              <PlaceRow
                key={planet.id}
                testID={`simple-planet-${planet.id}`}
                title={planet.name}
                accessibilityLabel={nameWithTruth(`${planet.name}, a planet in ${system.name}`, planet.hypothetical)}
                {...(visitor
                  ? {}
                  : {
                      meta: planet.hereRegion
                        ? `You were here · ${planet.hereRegion}`
                        : countOf(planet.regions, 'country'),
                    })}
                here={planet.hereRegion !== undefined}
                picked={pickedId === planet.id}
                {...(pickedId === planet.id
                  ? {
                      tail: (
                        <Text variant="label" color={SIMPLE.ink2}>
                          Picked
                        </Text>
                      ),
                    }
                  : {})}
                onPress={() => session.focus(planet.id)}
              />
            ))}
          </RowGroup>
        </View>
      ))}
      {listed.systems.length > shown.length ? (
        <View testID="simple-systems-more" style={styles.label}>
          <Text variant="uiS" color={SIMPLE.ink2}>
            {`Showing ${shown.length} of ${countOf(listed.systems.length, 'system')}. Search to find the rest.`}
          </Text>
        </View>
      ) : null}
      {listed.rooms.length > 0 ? (
        <View>
          <View style={styles.label}>
            <Text variant="label" color={SIMPLE.ink2}>
              Rooms
            </Text>
            <Text variant="label" color={SIMPLE.ink2}>
              {listed.rooms.length}
            </Text>
          </View>
          <RowGroup label="Rooms">
            {listed.rooms.map((room) => (
              <PlaceRow
                key={room.id}
                testID={`simple-room-${room.id}`}
                title={room.name}
                accessibilityLabel={`${room.name}, a room station${room.caption === undefined ? '' : `, ${room.caption}`}`}
                meta={room.caption === undefined ? `In ${room.systemName}` : `In ${room.systemName} · ${room.caption}`}
                onPress={() => onStation?.(room.id)}
              />
            ))}
          </RowGroup>
        </View>
      ) : null}
    </>
  );
}

/** The outline is a keyboard navigation surface as well as a screen-reader list. */
function SystemButton({
  name,
  hypothetical,
  onPress,
}: {
  readonly name: string;
  readonly hypothetical: boolean;
  readonly onPress: () => void;
}) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={nameWithTruth(`${name}, system`, hypothetical)}
      onPress={onPress}
      {...focus.props}
      style={[styles.systemName, focus.style]}
    >
      <Text variant="title" heading={2} color={SIMPLE.ink} style={styles.systemTitle}>
        {name}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
  systemWords: { flexShrink: 1, flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: spacing[2] },
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
});
