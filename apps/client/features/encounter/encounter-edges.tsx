import { StyleSheet, View } from 'react-native';
import type { ContinuationState } from '@knowscroll/contracts';
import { content, spacing } from '@knowscroll/design-tokens';
import { Button } from '@knowscroll/ui';
import type { EncounterEntry } from './encounter-history';
import type { EncounterSession } from './encounter-session';

function Edge({
  state,
  previous,
  session,
  disabled,
}: {
  readonly state: ContinuationState;
  readonly previous?: boolean;
  readonly session: EncounterSession;
  readonly disabled: boolean;
}) {
  if (state.status !== 'ready') return null;
  const relation = state.relation;
  const expectedContinuation = {
    linkId: state.linkId,
    assetId: state.target.assetId,
    assetRevision: state.target.assetRevision,
  };
  return (
    <View
      style={[
        styles.edge,
        previous ? styles.previous : styles.next,
        relation.kind === 'related_move' ? styles.related : null,
      ]}
    >
      <Button
        label={
          relation.kind === 'series_step' ? `${previous ? 'Previous · ' : ''}Part ${String(relation.part)}` : 'Related'
        }
        accessibilityHint={state.metadata.title}
        variant={relation.kind === 'series_step' ? 'continue' : 'default'}
        size="sm"
        disabled={disabled}
        icon={previous ? 'arrowLeft' : 'arrowRight'}
        onPress={() =>
          session.navigate(
            relation.kind === 'series_step'
              ? { mode: 'series', direction: previous ? 'previous' : 'next', expectedContinuation }
              : { mode: 'related', expectedContinuation },
          )
        }
      />
    </View>
  );
}
/** Ready admitted destinations only; controls are siblings of the stage gesture boundary. */
export function EncounterEdges({
  entry,
  session,
  disabled,
}: {
  readonly entry: EncounterEntry;
  readonly session: EncounterSession;
  readonly disabled: boolean;
}) {
  const continuations = entry.context.continuations;
  const next = continuations.seriesNext.status === 'ready' ? continuations.seriesNext : continuations.related;
  return (
    <View testID="encounter-continuation-edges" style={styles.edges} pointerEvents="box-none">
      <Edge state={continuations.seriesPrevious} previous session={session} disabled={disabled} />
      <Edge state={next} session={session} disabled={disabled} />
    </View>
  );
}
const styles = StyleSheet.create({
  edges: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  edge: { maxWidth: '48%' },
  previous: { marginRight: 'auto' },
  next: { marginLeft: 'auto' },
  related: { borderWidth: 1, borderStyle: 'dashed', borderColor: content.ink, padding: spacing['0.5'] },
});
