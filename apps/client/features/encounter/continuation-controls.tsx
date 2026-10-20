import { StyleSheet, View } from 'react-native';
import type { ContinuationState, NavigateExperienceRequest } from '@knowscroll/contracts';
import { Button, Text } from '@knowscroll/ui';
import { content, radius, spacing } from '@knowscroll/design-tokens';
import type { EncounterEntry } from './encounter-history';
import type { EncounterSession } from './encounter-session';

function Continuation({
  state,
  mode,
  direction,
  session,
  disabled,
}: {
  readonly state: ContinuationState;
  readonly mode: 'series' | 'related';
  readonly direction?: 'next' | 'previous';
  readonly session: EncounterSession;
  readonly disabled: boolean;
}) {
  if (state.status === 'unavailable') return null;
  if (state.status === 'pending') return <Text variant="meta">A continuation you requested is still preparing.</Text>;
  const label = state.relation.kind === 'series_step' ? `Part ${String(state.relation.part)}` : 'Related';
  const intent: NavigateExperienceRequest['intent'] =
    mode === 'series'
      ? {
          mode,
          direction: direction ?? 'next',
          expectedContinuation: {
            linkId: state.linkId,
            assetId: state.target.assetId,
            assetRevision: state.target.assetRevision,
          },
        }
      : {
          mode,
          expectedContinuation: {
            linkId: state.linkId,
            assetId: state.target.assetId,
            assetRevision: state.target.assetRevision,
          },
        };
  return (
    <View style={state.relation.kind === 'related_move' ? styles.related : undefined}>
      <Button
        label={`${direction === 'previous' ? 'Previous · ' : ''}${label} · ${state.metadata.title}`}
        variant={state.relation.kind === 'series_step' ? 'continue' : 'ghost'}
        disabled={disabled}
        onPress={() => session.navigate(intent)}
      />
    </View>
  );
}
export function ContinuationControls({
  entry,
  session,
  disabled = false,
}: {
  readonly entry: EncounterEntry;
  readonly session: EncounterSession;
  readonly disabled?: boolean;
}) {
  const { continuations } = entry.context;
  return (
    <View style={styles.controls}>
      <Text variant="ui">Continue this idea</Text>
      <Continuation
        state={continuations.seriesPrevious}
        mode="series"
        direction="previous"
        session={session}
        disabled={disabled}
      />
      <Continuation
        state={continuations.seriesNext}
        mode="series"
        direction="next"
        session={session}
        disabled={disabled}
      />
      <Continuation state={continuations.related} mode="related" session={session} disabled={disabled} />
      {Object.values(continuations).every((value) => value.status === 'unavailable') ? (
        <Text variant="bodyS">There are no more ready directions here.</Text>
      ) : null}
      <Button
        label="Next subject"
        variant="ghost"
        disabled={disabled}
        onPress={() => session.navigate({ mode: 'vertical', direction: 'next' })}
      />
      <Button label="Done for now" variant="ghost" onPress={() => session.done()} />
      <Button
        label="Keep a way back"
        variant="primary"
        disabled={entry.context.actions.saved || disabled}
        onPress={() => {
          session.park();
          session.act('save');
        }}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  controls: { padding: spacing[4], gap: spacing[3], backgroundColor: content.paper },
  related: {
    borderStyle: 'dashed',
    borderWidth: 1,
    borderColor: content.ink,
    borderRadius: radius.pill,
    padding: spacing['0.5'],
  },
});
