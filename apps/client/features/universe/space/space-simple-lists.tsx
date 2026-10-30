import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { content, spacing, target } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';
import type { SpaceDefinition } from './space-definition';
import type { SpaceChoice } from './space-surface';

/**
 * The Simple view of a space: systems as headings, each with its planets as rows, and the room
 * stations at the end. It shows the same names in the same order as the 3D drawing, with no 3D, glass
 * or motion. It is what the person sees when WebGL is missing, its context is lost or drawing fails,
 * so the screen is never blank. With `onChoose`, a system heading and every row take a tap.
 */
export function SpaceSimpleLists({
  definition,
  onChoose,
}: {
  readonly definition: SpaceDefinition;
  readonly onChoose?: (choice: SpaceChoice) => void;
}) {
  const stations = definition.stations ?? [];
  return (
    <ScrollView testID="ks-space-simple" style={styles.fill} contentContainerStyle={styles.content}>
      {definition.systems.map((system) => (
        <View key={system.id} style={styles.section}>
          {onChoose === undefined ? (
            <Text variant="heading" heading={2} color={content.paper}>
              {system.name}
            </Text>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${system.name}, a system`}
              onPress={() => onChoose({ id: system.id, kind: 'system', name: system.name })}
              style={styles.row}
            >
              <Text variant="heading" heading={2} color={content.paper}>
                {system.name}
              </Text>
            </Pressable>
          )}
          {system.planets.map((planet) => (
            <Pressable
              key={planet.id}
              accessibilityRole="button"
              accessibilityLabel={`${planet.name}, a planet in ${system.name}`}
              onPress={() => onChoose?.({ id: planet.id, kind: 'planet', name: planet.name })}
              style={styles.row}
            >
              <Text variant="body" color={content.paper}>
                {planet.name}
              </Text>
            </Pressable>
          ))}
        </View>
      ))}
      {stations.length > 0 ? (
        <View style={styles.section}>
          <Text variant="heading" heading={2} color={content.paper}>
            Rooms
          </Text>
          {stations.map((station) => (
            <Pressable
              key={station.id}
              accessibilityRole="button"
              accessibilityLabel={`${station.name}, a room station`}
              onPress={() => onChoose?.({ id: station.id, kind: 'station', name: station.name })}
              style={styles.row}
            >
              <Text variant="body" color={content.paper}>
                {station.name}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#020308' },
  content: { padding: spacing[5], paddingTop: 140, gap: spacing[5] },
  section: { gap: spacing[2] },
  row: { minHeight: target.comfortable, justifyContent: 'center' },
});
