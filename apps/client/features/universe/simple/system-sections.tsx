import { Pressable, StyleSheet, View } from 'react-native';
import { spacing } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';
import { countOf, type ListedUniverse } from '../universe-lists';
import type { UniverseMapSession } from '../universe-session';
import { PlaceRow, RowGroup, SIMPLE } from './place-rows';

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
}: {
  readonly session: UniverseMapSession;
  readonly listed: ListedUniverse;
  readonly visitor?: boolean;
  /** The system the camera is in: it carries a "You are here" tag. */
  readonly hereSystemId?: string | null;
  /** The planet picked on the map, awaiting Land. */
  readonly pickedId?: string | null;
  readonly onStation?: (roomId: string) => void;
}) {
  return (
    <>
      {listed.systems.map((system, position) => (
        <View key={system.id} testID={`simple-system-${system.id}`}>
          <View style={[styles.systemHead, position === 0 ? styles.first : null]}>
            <View style={styles.systemWords}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${system.name}, system`}
                onPress={() => session.focus(system.id)}
                style={styles.systemName}
              >
                <Text variant="title" heading={2} color={SIMPLE.ink} style={styles.systemTitle}>
                  {system.name}
                </Text>
              </Pressable>
              {hereSystemId === system.id ? (
                <Text variant="label" color={SIMPLE.ink2}>
                  You are here
                </Text>
              ) : null}
            </View>
            <Text variant="uiS" color={SIMPLE.ink2}>
              {countOf(system.planets.length, 'planet')}
            </Text>
          </View>
          <RowGroup label={`Planets in ${system.name}`}>
            {system.planets.map((planet) => (
              <PlaceRow
                key={planet.id}
                testID={`simple-planet-${planet.id}`}
                title={planet.name}
                accessibilityLabel={`${planet.name}, a planet in ${system.name}`}
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
      {listed.rooms.length > 0 ? (
        <View>
          <View style={styles.label}>
            <Text variant="label" color={SIMPLE.ink2}>
              Rooms
            </Text>
            <Text variant="label" color={SIMPLE.ink2}>
              {countOf(listed.rooms.length, 'room')}
            </Text>
          </View>
          <RowGroup label="Rooms">
            {listed.rooms.map((room) => (
              <PlaceRow
                key={room.id}
                testID={`simple-room-${room.id}`}
                title={room.name}
                accessibilityLabel={`${room.name}, a room station`}
                meta={`In ${room.systemName}`}
                onPress={() => onStation?.(room.id)}
              />
            ))}
          </RowGroup>
        </View>
      ) : null}
    </>
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
