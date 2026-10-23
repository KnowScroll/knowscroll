import { StyleSheet, View } from 'react-native';
import { space, spacing } from '@knowscroll/design-tokens';
import { IconButton, Tag, Text } from '@knowscroll/ui';
import { SpaceChip } from './space-chip';
import type { UniverseView } from './universe-layout';
import type { UniverseViewSession, UniverseViewState } from './universe-session';

/**
 * What the header says for each view (U01, U02, U03): the screen title with search and the Lately
 * lens at the root; a Back pill that names where it goes below it; the system's or planet's name
 * as the screen's heading.
 */
export function UniverseHeader({
  session,
  state,
  view,
  hasPlaces,
  onSearch,
}: {
  readonly session: UniverseViewSession;
  readonly state: UniverseViewState;
  readonly view: UniverseView;
  readonly hasPlaces: boolean;
  readonly onSearch: () => void;
}) {
  const lens = (
    <SpaceChip
      testID="universe-lately"
      label="Lately"
      dot={state.lately}
      toggled={state.lately}
      variant={state.lately ? 'solid' : 'ghost'}
      onPress={() => session.setLately(!state.lately)}
    />
  );
  if (view.kind === 'universe')
    return (
      <View style={styles.root}>
        <View style={styles.row}>
          <Text variant="heading" heading={1} color={space.label} style={styles.title}>
            Your universe
          </Text>
          {hasPlaces ? (
            <View style={styles.actions}>
              <IconButton icon="search" label="Search your universe" variant="onSpace" onPress={onSearch} testID="universe-search" />
              {lens}
            </View>
          ) : null}
        </View>
        {state.absent ? (
          <Text variant="body" color={space.label2} style={styles.subtitle}>
            Everything is where you left it.
          </Text>
        ) : null}
      </View>
    );
  const parent =
    view.kind === 'system' ? undefined : session.places().find((place) => place.id === (view.kind === 'planet' ? view.planet.parentId : ''));
  const backLabel = view.kind === 'system' ? 'Universe' : view.selectedRegion ? view.planet.label : (parent?.label ?? 'Universe');
  const title = view.kind === 'system' ? view.system.label : view.planet.label;
  return (
    <View style={styles.root}>
      <View style={styles.row}>
        <SpaceChip testID="universe-up" variant="solid" icon="back" label={backLabel} accessibilityLabel={`Back to ${backLabel}`} onPress={() => session.up()} />
        <View style={styles.actions}>
          {view.kind === 'planet' && state.detail === 'low' ? <Tag label="Low detail" variant="onDark" /> : null}
          {view.kind === 'system' ? lens : null}
        </View>
      </View>
      {view.kind === 'system' ? (
        <View style={styles.block}>
          <Text variant="displayL" heading={1} color={space.label} style={styles.name}>
            {title}
          </Text>
          <Text variant="label" color={space.label2}>
            A system
          </Text>
          {view.system.truthStatus === 'hypothetical' ? <Tag label="Hypothetical" variant="hypothetical" /> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing[3] },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[3], minHeight: 48 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  title: { flexShrink: 1 },
  subtitle: { marginTop: -spacing[2] },
  block: { gap: 2, paddingTop: spacing[2] },
  name: { fontSize: 30, lineHeight: 34 },
});
