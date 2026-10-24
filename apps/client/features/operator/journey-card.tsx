import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import type { OperatorJourneyState } from '@knowscroll/client-core';
import { clockOf } from './operator-copy';
import { Card, Line, Mono, Note, TextButton } from './operator-parts';
import { operatorColor, operatorFont } from './operator-theme';

/** The seconds a step took, when it recorded an end. */
function tookOf(at: string, endedAt: string | null): string | undefined {
  if (endedAt === null) return undefined;
  const seconds = (Date.parse(endedAt) - Date.parse(at)) / 1000;
  return `+${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

/**
 * 2 · Journey search: paste the ID of a request, production run, Reel order, model attempt,
 * reasoning run, exposure or asset and read what the records say, oldest first, with the gaps they
 * leave. Searching by account is not here: it needs the separate, audited step on the server
 * (`operator.js journey --account`).
 */
export function JourneyCard({
  journey,
  value,
  onChangeValue,
  onSearch,
  onClear,
}: {
  readonly journey: OperatorJourneyState;
  readonly value: string;
  readonly onChangeValue: (next: string) => void;
  readonly onSearch: () => void;
  readonly onClear: () => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Card title="2 · Journey search" source="ops.journey_events (operator only)" testID="operator-journey">
      <View style={styles.search}>
        <TextInput
          value={value}
          onChangeText={onChangeValue}
          onSubmitEditing={onSearch}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="request, production run, Reel order, attempt, exposure or asset ID"
          placeholderTextColor={operatorColor.faint}
          accessibilityLabel="ID to look up"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          returnKeyType="search"
          style={[styles.input, focused ? styles.focused : null]}
        />
        <TextButton label="Look up" onPress={onSearch} busy={journey.status === 'loading'} />
        {journey.status !== 'idle' ? <TextButton label="Clear" onPress={onClear} /> : null}
      </View>
      {journey.status === 'invalid' ? (
        <Note>That is not an ID. Paste a request, production run, Reel order, attempt, run, exposure or asset ID.</Note>
      ) : null}
      {journey.status === 'not_found' ? <Note>No record carries this ID, or it was erased.</Note> : null}
      {journey.status === 'unavailable' ? <Note>The lookup could not be made. Try again.</Note> : null}
      {journey.status === 'found' ? (
        <View testID="operator-journey-result" style={styles.result}>
          <Mono size={12} color={operatorColor.ink}>
            {journey.journey.subject.replace('_', ' ')} · {journey.journey.steps.length} steps
          </Mono>
          {journey.journey.steps.map((step, index) => (
            <Line key={`${step.stage}-${step.ref ?? ''}-${String(index)}`}>
              <Mono>{clockOf(step.at)}</Mono>
              <Mono>{step.scope === 'shared' ? 'shared' : 'personal'}</Mono>
              <Mono size={12} color={operatorColor.ink}>
                {step.stage}
              </Mono>
              <Mono>
                {[step.state, step.code, step.label, step.count === null ? null : `n=${String(step.count)}`]
                  .filter((part) => part !== null)
                  .join(' ')}
              </Mono>
              {tookOf(step.at, step.endedAt) === undefined ? null : <Mono>{tookOf(step.at, step.endedAt)}</Mono>}
              {step.ref === null ? null : (
                <Mono size={11} color={operatorColor.faint} selectable>
                  {step.ref}
                </Mono>
              )}
            </Line>
          ))}
          {journey.journey.gaps.map((gap, index) => (
            <Line key={`gap-${String(index)}`} attention>
              <Mono size={12} color={operatorColor.attentionInk}>
                Gap
              </Mono>
              <Mono>{gap.stage}</Mono>
              <Mono>{gap.note}</Mono>
            </Line>
          ))}
          {journey.journey.truncated ? <Note>Only the newest steps are shown.</Note> : null}
        </View>
      ) : null}
      <Note>Search by account needs a separate authorised step on the server; addresses never appear here.</Note>
    </Card>
  );
}

const styles = StyleSheet.create({
  search: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  input: {
    flexGrow: 1,
    flexBasis: '100%',
    minHeight: 44,
    paddingHorizontal: 10,
    borderColor: operatorColor.faint,
    borderWidth: 1,
    borderRadius: 4,
    backgroundColor: operatorColor.card,
    color: operatorColor.ink,
    fontFamily: operatorFont.mono,
    fontSize: 12,
  },
  focused: { borderColor: operatorColor.ink, borderWidth: 2 },
  result: { gap: 4 },
});
