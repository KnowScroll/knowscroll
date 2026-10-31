import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text as NativeText, TextInput, View } from 'react-native';
import type { RoomStation } from '@knowscroll/contracts';
import { borderWidth, content, radius, space, spacing, target } from '@knowscroll/design-tokens';
import { Button, Icon, IconButton, Text } from '@knowscroll/ui';
import { nameWithTruth } from './universe-lists';
import { KIND_WORD, searchRoomsOf, searchUniverse, type SearchResult } from './universe-search';
import type { UniverseMapSession } from './universe-session';

/** The yellow under the letters that matched. */
const MARK = '#FFE44D';

/**
 * U08 "Search": the field replaces the header, over the live map. With nothing typed it says what can
 * be found; typed, it lists the best matches first, each with the letters that matched and its path.
 * Choosing a result (a tap, or Enter on the lit row) flies there and Back returns to where the person
 * was looking; a room opens its room. Search runs on this device over what is already here: nothing is
 * sent and the query is neither kept nor logged.
 */
export function UniverseSearchPanel({
  session,
  owner,
  stations,
  onStation,
}: {
  readonly session: UniverseMapSession;
  /** A friend's name, when the places searched are theirs. */
  readonly owner?: string;
  /** The person's own rooms. A friend's universe has none to search (a visit shows what the friend shares). */
  readonly stations?: readonly RoomStation[];
  readonly onStation?: (roomId: string) => void;
}) {
  const subject = owner === undefined ? 'your universe' : `${owner}’s universe`;
  const [query, setQuery] = useState('');
  const [lit, setLit] = useState(0);
  const rooms = useMemo(() => searchRoomsOf(stations ?? []), [stations]);
  // The places change as reads arrive and `session` does not: search the current ones each time (a few dozen names).
  const results = searchUniverse(session.places(), rooms, query);
  const choose = (result: SearchResult) => {
    if (result.kind === 'room') {
      session.back();
      onStation?.(result.id);
    } else session.focus(result.id);
  };
  const searched = query.trim().length > 0;
  return (
    <View testID="universe-search-panel" style={styles.root}>
      <View style={styles.bar}>
        <View style={styles.field}>
          <Icon name="search" size={20} color={content.ink} />
          <TextInput
            autoFocus
            value={query}
            onChangeText={(text) => {
              setQuery(text);
              setLit(0);
            }}
            onKeyPress={(event) => {
              const key = event.nativeEvent.key;
              if (key !== 'ArrowDown' && key !== 'ArrowUp') return;
              event.preventDefault();
              setLit((current) => Math.min(results.length - 1, Math.max(0, current + (key === 'ArrowDown' ? 1 : -1))));
            }}
            onSubmitEditing={() => {
              const result = results[lit];
              if (result) choose(result);
            }}
            role="searchbox"
            accessibilityLabel={`Search ${subject}`}
            placeholder={`Search ${subject}`}
            placeholderTextColor={content.ink2}
            returnKeyType="search"
            autoCorrect={false}
            style={styles.input}
          />
          {searched ? (
            <IconButton icon="close" label="Clear search" variant="plain" onPress={() => setQuery('')} />
          ) : null}
        </View>
        <Button label="Cancel" variant="space" size="sm" onPress={() => session.back()} />
      </View>
      <View style={styles.card}>
        {searched ? (
          results.length ? (
            <>
              <View style={styles.cardHead}>
                <Text variant="label" color={content.ink2}>
                  {`${results.length} ${results.length === 1 ? 'place' : 'places'}`}
                </Text>
                <Text variant="label" color={content.ink2}>
                  Best match first
                </Text>
              </View>
              <ScrollView role="list" accessibilityLabel="Search results" style={styles.results}>
                {results.map((result, position) => (
                  <ResultRow
                    key={`${result.kind}-${result.id}`}
                    result={result}
                    lit={position === lit}
                    onPress={() => choose(result)}
                  />
                ))}
              </ScrollView>
            </>
          ) : (
            <Text variant="body" color={content.ink2}>
              Nothing here called that yet.
            </Text>
          )
        ) : (
          <View style={styles.empty}>
            <Text variant="heading" heading={2}>
              Find any place you’ve been
            </Text>
            <Text variant="body" color={content.ink2}>
              Choosing a result flies you there. Back returns you to where you were looking.
            </Text>
            <View style={styles.kinds}>
              {['Systems', 'Planets', ...(owner === undefined ? ['Regions', 'Rooms'] : [])].map((kind) => (
                <Text key={kind} variant="ui">
                  {kind}
                </Text>
              ))}
            </View>
          </View>
        )}
        <Text variant="meta" color={content.ink2}>
          {searched && results.length
            ? `Only places in ${subject}. Search stays on this device.`
            : 'Search stays on this device.'}
        </Text>
      </View>
    </View>
  );
}

function ResultRow({
  result,
  lit,
  onPress,
}: {
  readonly result: SearchResult;
  readonly lit: boolean;
  readonly onPress: () => void;
}) {
  const [from, to] = result.match;
  const where = result.trail.length ? `, in ${result.trail.join(', in ')}` : '';
  return (
    <View role="listitem">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={nameWithTruth(
          `${result.name}, ${KIND_WORD[result.kind].toLowerCase()}${where}`,
          result.hypothetical,
        )}
        onPress={onPress}
        style={[styles.result, lit ? styles.lit : null]}
      >
        <Text variant="title" numberOfLines={1}>
          {result.name.slice(0, from)}
          <NativeText style={styles.mark}>{result.name.slice(from, to)}</NativeText>
          {result.name.slice(to)}
        </Text>
        <Text variant="label" color={content.ink2} numberOfLines={1}>
          {[KIND_WORD[result.kind], ...result.trail].join(' · ')}
        </Text>
      </Pressable>
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
    paddingLeft: spacing[4],
    paddingRight: spacing[1],
    borderRadius: radius.pill,
    backgroundColor: content.paper,
    borderWidth: borderWidth.regular,
    borderColor: space.focus,
  },
  input: { flex: 1, minHeight: target.comfortable, color: content.ink, fontSize: 16, outlineStyle: 'none' as never },
  card: {
    gap: spacing[3],
    padding: spacing[4],
    borderRadius: radius.card,
    backgroundColor: content.paper,
  },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing[3] },
  empty: { gap: spacing[2] },
  kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[5], paddingTop: spacing[1] },
  results: { maxHeight: 340 },
  result: {
    minHeight: 56,
    justifyContent: 'center',
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    gap: 2,
    borderRadius: radius.md,
  },
  lit: { backgroundColor: content.paper2 },
  mark: { backgroundColor: MARK },
});
