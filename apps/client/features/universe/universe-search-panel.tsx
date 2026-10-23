import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { borderWidth, content, radius, space, spacing, target } from '@knowscroll/design-tokens';
import { Button, Icon, Text } from '@knowscroll/ui';
import { searchPlaces } from './universe-search';
import type { UniverseViewSession } from './universe-session';

const KIND_WORD = { system: 'System', star: 'Star', planet: 'Planet', region: 'Region' } as const;

/**
 * U08 "Find": a real search input over the person's own places with a list of results. Choosing one
 * flies there and Back returns to where they were looking. Search runs on this device and the query
 * is neither sent nor kept.
 */
export function UniverseSearchPanel({ session }: { readonly session: UniverseViewSession }) {
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchPlaces(session.places(), query), [session, query]);
  return (
    <View testID="universe-search-panel" style={styles.root}>
      <View style={styles.bar}>
        <View style={styles.field}>
          <Icon name="search" size={20} color={content.ink} />
          <TextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            role="searchbox"
            accessibilityLabel="Search your universe"
            placeholder="Search your universe"
            placeholderTextColor={content.ink2}
            returnKeyType="search"
            autoCorrect={false}
            style={styles.input}
          />
        </View>
        <Button label="Cancel" variant="space" size="sm" onPress={() => session.back()} />
      </View>
      {query.trim() ? (
        results.length ? (
          <ScrollView role="list" accessibilityLabel="Search results" style={styles.results}>
            {results.map(({ place, trail }) => (
              <Pressable
                key={place.id}
                accessibilityRole="button"
                accessibilityLabel={`${place.label}, ${KIND_WORD[place.kind].toLowerCase()}${trail.length ? `, in ${trail.join(', in ')}` : ''}`}
                onPress={() => session.focus(place.id)}
                style={styles.result}
              >
                <Text variant="ui">{place.label}</Text>
                <Text variant="label" color={content.ink2}>
                  {[KIND_WORD[place.kind], ...trail].join(' · ')}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : (
          <Text variant="body" color={space.label} style={styles.hint}>
            Nothing here called that yet.
          </Text>
        )
      ) : (
        <Text variant="body" color={space.label2} style={styles.hint}>
          Choosing a result flies you there. Back returns to where you were looking.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing[3] },
  bar: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  field: {
    flex: 1,
    minHeight: target.comfortable,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    borderRadius: radius.pill,
    backgroundColor: content.paper,
    borderWidth: borderWidth.regular,
    borderColor: space.focus,
  },
  input: { flex: 1, minHeight: target.comfortable, color: content.ink, fontSize: 16, outlineStyle: 'none' as never },
  results: {
    maxHeight: 360,
    backgroundColor: content.paper,
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
  },
  result: { minHeight: 56, justifyContent: 'center', paddingHorizontal: spacing[4], paddingVertical: spacing[2], gap: 2 },
  hint: { paddingHorizontal: spacing[1] },
});
