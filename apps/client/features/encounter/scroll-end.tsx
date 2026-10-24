import type { ComponentRef, Ref } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Icon, Tag, Text } from '@knowscroll/ui';
import { continuationIntent, continuationLabel, continuationName, type ReadyContinuation } from './continuation-intent';
import { EncounterStrip } from './encounter-actions';
import type { EncounterEntry } from './encounter-history';
import type { EncounterSession, EncounterState } from './encounter-session';

function ContinueRow({
  state,
  session,
  disabled,
}: {
  readonly state: ReadyContinuation;
  readonly session: EncounterSession;
  readonly disabled: boolean;
}) {
  const series = state.relation.kind === 'series_step';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={continuationName(state)}
      disabled={disabled}
      aria-disabled={disabled}
      onPress={() => session.navigate(continuationIntent(state))}
      style={[styles.row, series ? styles.partRow : styles.relatedRow, disabled ? styles.disabled : null]}
    >
      <Tag label={continuationLabel(state)} variant={series ? 'part' : 'neutral'} />
      <Text variant="ui" style={styles.rowTitle} numberOfLines={2}>
        {state.metadata.title}
      </Text>
      <Icon name="arrowRight" size={20} color={content.ink} />
    </Pressable>
  );
}

/**
 * The end of a Scroll (E02-3): a boundary, not a launch pad. It offers the admitted next step
 * and related angle, then the next subject, then the same actions. Nothing here moves on by
 * itself; momentum at the end of the article never reaches these buttons.
 */
export function ScrollEnd({
  entry,
  state,
  session,
  innerRef,
}: {
  readonly entry: EncounterEntry;
  readonly state: EncounterState;
  readonly session: EncounterSession;
  /** Lets the screen see whether the end card is on screen (it holds its own action row). */
  readonly innerRef?: Ref<ComponentRef<typeof View>>;
}) {
  const { seriesNext, related } = entry.context.continuations;
  const disabled = state.phase !== 'active';
  const pending = seriesNext.status === 'pending' || related.status === 'pending';
  const hasContinuation = seriesNext.status === 'ready' || related.status === 'ready';
  return (
    <View ref={innerRef} testID="encounter-scroll-end" style={styles.card}>
      <Text variant="label" color={content.ink2}>
        End of this Scroll
      </Text>
      {hasContinuation ? (
        <View style={styles.panel}>
          <Text variant="ui" heading={2}>
            Continue this idea
          </Text>
          {seriesNext.status === 'ready' ? (
            <ContinueRow state={seriesNext} session={session} disabled={disabled} />
          ) : null}
          {related.status === 'ready' ? <ContinueRow state={related} session={session} disabled={disabled} /> : null}
        </View>
      ) : null}
      {pending && !hasContinuation ? (
        <Text variant="meta" color={content.ink2}>
          Something you asked for is still being prepared.
        </Text>
      ) : null}
      <Button
        label="Next subject"
        icon="arrowUp"
        disabled={disabled}
        onPress={() => session.navigate({ mode: 'vertical', direction: 'next' })}
      />
      <View style={styles.actions}>
        <EncounterStrip entry={entry} state={state} session={session} align="start" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing[3],
    padding: spacing[4],
    borderRadius: radius.panel,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  panel: {
    gap: spacing[2],
    padding: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.continue,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 48,
    paddingVertical: spacing[1],
    paddingHorizontal: spacing[3],
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
    cursor: 'pointer' as const,
  },
  partRow: { borderStyle: 'solid' },
  relatedRow: { borderStyle: 'dashed' },
  rowTitle: { flex: 1 },
  disabled: { opacity: 0.45 },
  actions: { alignItems: 'flex-start' },
});
