import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { createOperatorSession, healthQueryOptions, type AccountScope } from '@knowscroll/client-core';
import { useDocumentTitle } from '../../platform/document-title';
import { useAccountScope } from '../../providers/account-scope';
import { NotFoundScreen } from '../not-found/not-found-screen';
import { JourneyCard } from './journey-card';
import {
  OverviewCard,
  PrivacyCard,
  ProductionCard,
  RealtimeCard,
  ReportsCard,
  UniverseChangeCard,
} from './operator-panels';
import { Chip, Mono, Note, TextButton } from './operator-parts';
import { columnsFor, operatorColor, operatorFont } from './operator-theme';

/** Names the browser tab only once the server has shown this account the page. */
function OperatorTitle() {
  useDocumentTitle('Operator');
  return null;
}

function WorldLine({ scope }: { readonly scope: AccountScope }) {
  const health = useQuery(healthQueryOptions(scope.api));
  if (!health.data) return null;
  return (
    <Mono size={12} color={operatorColor.quiet} selectable>
      world {health.data.world} · {health.data.commit.slice(0, 8)} · {health.data.migration}
    </Mono>
  );
}

export function OperatorPanels({ scope }: { readonly scope: AccountScope }) {
  const session = useMemo(() => createOperatorSession(scope), [scope]);
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const [lookup, setLookup] = useState('');
  const { width } = useWindowDimensions();
  useEffect(() => {
    void session.refresh();
  }, [session]);

  // Until the server has said this account is an operator, the page shows nothing of itself.
  if (state.panels.status === 'loading') return null;
  if (state.panels.status === 'not_operator') return <NotFoundScreen />;
  const columns = columnsFor(width);
  const cardWidth = columns === 1 ? '100%' : columns === 2 ? '49%' : '32.4%';
  const lookUp = (id: string) => {
    setLookup(id);
    void session.lookUp(id);
  };
  const clear = () => {
    setLookup('');
    session.clearLookup();
  };
  const panels = state.panels.status === 'ready' ? state.panels.panels : undefined;
  const slot = (card: React.ReactNode) => (
    <View style={{ width: cardWidth, flexGrow: columns === 3 ? 0 : 1 }}>{card}</View>
  );
  return (
    <ScrollView role="main" style={styles.ground} contentContainerStyle={styles.content} testID="operator-screen">
      <OperatorTitle />
      <View style={styles.header}>
        <View style={styles.badges}>
          <View style={styles.badge}>
            <Mono size={11} color="#FFFFFF">
              OPS
            </Mono>
          </View>
          <Chip>Not consumer UI</Chip>
        </View>
        <Text role="heading" aria-level={1} style={styles.title}>
          Operator
        </Text>
        <Note>
          What the running system recorded, read from the allowlisted views. Never a prompt, a model answer, a message,
          an address or a score. A panel with no Tier 0 source says so instead of showing a number.
        </Note>
        <View style={styles.badges}>
          <WorldLine scope={scope} />
          <TextButton
            label="Refresh"
            onPress={() => void session.refresh()}
            accessibilityLabel="Read the panels again"
          />
        </View>
        {state.panels.status === 'ready' && state.panels.stale ? (
          <Note>The last refresh failed. These panels are from the previous read.</Note>
        ) : null}
        {state.panels.status === 'unavailable' ? (
          <Note>The panels could not be read. Refresh to try again.</Note>
        ) : null}
      </View>
      {panels === undefined ? null : (
        <View style={styles.grid}>
          {slot(<OverviewCard overview={panels.overview} actions={{ lookUp }} />)}
          {slot(
            <JourneyCard
              journey={state.journey}
              value={lookup}
              onChangeValue={setLookup}
              onSearch={() => void session.lookUp(lookup)}
              onClear={clear}
            />,
          )}
          {slot(<ProductionCard production={panels.production} actions={{ lookUp }} />)}
          {slot(<UniverseChangeCard universeChange={panels.universeChange} />)}
          {slot(<RealtimeCard realtime={panels.realtime} />)}
          {slot(<PrivacyCard privacy={panels.privacy} />)}
          {slot(<ReportsCard safety={panels.safety} />)}
        </View>
      )}
    </ScrollView>
  );
}

/**
 * `/operator`: the Operator screen (Operator.html), for an operator account of this world. It is not
 * linked from the app and shows the unknown-page screen to everyone else, including a signed-out
 * visitor; the server refuses the data to them too (D-044).
 */
export function OperatorScreen() {
  const { state } = useAccountScope();
  if (state.status !== 'signed_in') return <NotFoundScreen />;
  return <OperatorPanels scope={state.scope} />;
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: operatorColor.ground },
  content: { padding: 24, gap: 20, maxWidth: 1440, width: '100%', alignSelf: 'center' },
  header: { gap: 10, paddingBottom: 14, borderBottomWidth: 2, borderBottomColor: operatorColor.ink },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' },
  badge: { backgroundColor: operatorColor.ink, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 4 },
  title: { fontFamily: operatorFont.mono, fontSize: 32, color: operatorColor.ink },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start' },
});
