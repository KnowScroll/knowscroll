import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { content, spacing, target } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';
import type { SpaceDefinition } from './space-definition';
import type { SpaceChoice } from './space-surface';

/**
 * The Simple view of a space: systems as headings, each with its planets as rows. It shows the
 * same names in the same order as the 3D drawing, with no 3D, glass or motion. It is what the
 * person sees when WebGL is missing, its context is lost or drawing fails, so the screen is never
 * blank.
 */
export function SpaceSimpleLists({
  definition,
  onChoose,
}: {
  readonly definition: SpaceDefinition;
  readonly onChoose?: (choice: SpaceChoice) => void;
}) {
  return (
    <ScrollView testID="ks-space-simple" style={styles.fill} contentContainerStyle={styles.content}>
      {definition.systems.map((system) => (
        <View key={system.id} style={styles.section}>
          <Text variant="heading" heading={2} color={content.paper}>
            {system.name}
          </Text>
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#020308' },
  content: { padding: spacing[5], gap: spacing[5] },
  section: { gap: spacing[2] },
  row: { minHeight: target.comfortable, justifyContent: 'center' },
});
