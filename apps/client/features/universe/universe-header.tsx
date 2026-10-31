import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { space, spacing } from '@knowscroll/design-tokens';
import { AccountButton, IconButton, Tag, Text, useDisplay } from '@knowscroll/ui';
import { useAccountInitial } from '../../providers/account-scope';
import { SpaceChip } from './space-chip';
import type { UniverseView } from './universe-layout';
import type { UniverseMapSession, UniverseViewState } from './universe-session';

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
  visitor,
}: {
  readonly session: UniverseMapSession;
  readonly state: UniverseViewState;
  readonly view: UniverseView;
  readonly hasPlaces: boolean;
  readonly onSearch: () => void;
  /** A friend's universe (U06): their name, and none of the controls that mean something only for your own map. */
  readonly visitor?: { readonly ownerName: string };
}) {
  const router = useRouter();
  const initial = useAccountInitial();
  const { breakpoint } = useDisplay();
  // From 1024 px the rail carries the avatar (D-006 c).
  const accountInHeader = breakpoint !== 'desktop';
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
  if (view.kind === 'universe' && visitor)
    return (
      <View style={styles.root}>
        {hasPlaces ? (
          <View style={styles.row}>
            <IconButton
              icon="search"
              label={`Search ${visitor.ownerName}’s universe`}
              variant="onSpace"
              onPress={onSearch}
              testID="universe-search"
            />
          </View>
        ) : null}
      </View>
    );
  if (view.kind === 'universe')
    return (
      <View style={styles.root}>
        <View style={styles.row}>
          <Text variant="heading" heading={1} color={space.label} style={styles.title}>
            Your universe
          </Text>
          {accountInHeader ? (
            <AccountButton
              onPress={() => router.navigate('/account')}
              href="/account"
              surface="dark"
              {...(initial === undefined ? {} : { initial })}
            />
          ) : null}
        </View>
        {state.absent ? (
          <Text variant="body" color={space.label2} style={styles.subtitle}>
            Everything is where you left it.
          </Text>
        ) : null}
        {hasPlaces ? (
          <View style={styles.actions}>
            <IconButton
              icon="search"
              label="Search your universe"
              variant="onSpace"
              onPress={onSearch}
              testID="universe-search"
            />
            {lens}
          </View>
        ) : null}
      </View>
    );
  const parent =
    view.kind === 'system'
      ? undefined
      : session.places().find((place) => place.id === (view.kind === 'planet' ? view.planet.parentId : ''));
  const universeName = visitor ? `${visitor.ownerName}’s universe` : 'Universe';
  const backLabel =
    view.kind === 'system' ? universeName : view.selectedRegion ? view.planet.label : (parent?.label ?? universeName);
  const title = view.kind === 'system' ? view.system.label : view.planet.label;
  return (
    <View style={styles.root}>
      <View style={styles.row}>
        <View style={styles.actions}>
          <SpaceChip
            testID="universe-up"
            variant="solid"
            icon="back"
            label={backLabel}
            accessibilityLabel={`Back to ${backLabel}`}
            onPress={() => session.up()}
          />
          {view.kind === 'planet' && view.landed ? (
            <View style={styles.level} testID="universe-level">
              <Text variant="metaS" color="#111111" style={styles.levelText}>
                {view.selectedRegion ? 'REGION' : 'PLANET'}
              </Text>
            </View>
          ) : null}
        </View>
        <View style={styles.actions}>
          {view.kind === 'planet' && state.detail === 'low' ? <Tag label="Low detail" variant="onDark" /> : null}
          {view.kind === 'system' && !visitor ? lens : null}
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
  /** The level of a landed view, a small orange tag beside Back (U04). */
  level: { backgroundColor: '#ff684c', borderRadius: 99, paddingHorizontal: 8, paddingVertical: 4 },
  levelText: { fontSize: 10, lineHeight: 12, letterSpacing: 1.1 },
  block: { gap: 2, paddingTop: spacing[2] },
  name: { fontSize: 30, lineHeight: 34 },
});
