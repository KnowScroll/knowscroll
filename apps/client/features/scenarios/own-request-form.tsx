import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { ownSelection, type OwnRow, type ScenarioSelection } from '@knowscroll/client-core';
import type { Assumption, OptionChange, ScenarioKind, ScenarioOption } from '@knowscroll/contracts';
import { content, spacing } from '@knowscroll/design-tokens';
import { Button, Text, useTypeStyle } from '@knowscroll/ui';
import { sheetStyles } from './sheet-styles';

/** One line of the form, with a key of its own so removing a line never moves another's words. */
interface Row extends OwnRow {
  readonly id: number;
}

const sameSubject = (a: string | undefined, b: string) => a?.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Lines of text for one list of assumptions, in a form that keeps each line's key and subject; `blank` empty lines
 * follow. A change that took the place of a premise (`replaces`) starts as that premise's subject, so the line
 * still replaces it until the member says otherwise.
 */
function useRows(initial: readonly OptionChange[], blank: number) {
  const [rows, setRows] = useState<readonly Row[]>(() => [
    ...initial.map((assumption, id): Row => ({
      id,
      statement: assumption.statement,
      subject: assumption.replaces ?? assumption.subject,
    })),
    ...Array.from({ length: blank }, (_, at): Row => ({ id: initial.length + at, statement: '' })),
  ]);
  const add = () => setRows([...rows, { id: Math.max(-1, ...rows.map((row) => row.id)) + 1, statement: '' }]);
  return { rows, setRows, add };
}

/** For a line that changes something: does it add a premise of its own, or replace one that already holds? */
function ReplacesChoice({
  row,
  premises,
  onChoose,
}: {
  readonly row: Row;
  readonly premises: readonly Assumption[];
  readonly onChoose: (subject: string | undefined) => void;
}) {
  const replaced = premises.find((premise) => sameSubject(row.subject, premise.subject));
  return (
    <View style={styles.choices} role="radiogroup" accessibilityLabel="Adds a premise, or replaces one">
      <Button
        label="New premise"
        size="sm"
        variant={replaced === undefined ? 'ink' : 'ghost'}
        toggled={replaced === undefined}
        onPress={() => onChoose(undefined)}
      />
      {premises.map((premise) => (
        <Button
          key={premise.subject}
          label={`Replaces: ${premise.subject}`}
          size="sm"
          variant={replaced === premise ? 'ink' : 'ghost'}
          toggled={replaced === premise}
          onPress={() => onChoose(premise.subject)}
        />
      ))}
    </View>
  );
}

/** Lines of one assumption each, as sentences. A what-if's changes may name the premise they replace. */
function RowsEditor({
  title,
  rows,
  add,
  setRows,
  max,
  min,
  premises,
}: {
  readonly title: string;
  readonly rows: readonly Row[];
  readonly add: () => void;
  readonly setRows: (next: readonly Row[]) => void;
  readonly max: number;
  readonly min: number;
  /** When given, each line may replace one of these instead of adding a premise. */
  readonly premises?: readonly Assumption[];
}) {
  const type = useTypeStyle('bodyS');
  const change = (id: number, patch: Partial<OwnRow>) =>
    setRows(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  return (
    <View style={styles.rows}>
      <Text variant="uiS">{title}</Text>
      {rows.map((row, index) => (
        <View key={row.id} style={styles.rowBlock}>
          <View style={styles.row}>
            <TextInput
              accessibilityLabel={`${title} ${String(index + 1)}`}
              value={row.statement}
              onChangeText={(statement) => change(row.id, { statement: statement.slice(0, 160) })}
              maxLength={160}
              allowFontScaling={false}
              style={[sheetStyles.input, styles.rowInput, { fontFamily: type.fontFamily, fontSize: type.fontSize }]}
            />
            {rows.length > min ? (
              <Button
                label="Remove"
                size="sm"
                variant="ghost"
                onPress={() => setRows(rows.filter((other) => other.id !== row.id))}
              />
            ) : null}
          </View>
          {premises === undefined || premises.length === 0 ? null : (
            <ReplacesChoice row={row} premises={premises} onChoose={(subject) => change(row.id, { subject })} />
          )}
        </View>
      ))}
      {rows.length < max ? <Button label="Add" size="sm" variant="ghost" icon="plus" onPress={add} /> : null}
    </View>
  );
}

/**
 * The member's own complete request: what changes and what stays, or the lens (Edit). Where the branch
 * continues others, the premises that already hold are listed, and a changed line either adds a premise
 * or says which one it replaces: a new line never silently stands beside the one it contradicts.
 */
export function OwnRequestForm({
  kind,
  initial,
  premises,
  busy,
  onSubmit,
  onCancel,
}: {
  readonly kind: ScenarioKind;
  /** The direction being edited, when there is one: the request names it, so the server keeps what it was marked. */
  readonly initial: Pick<ScenarioOption, 'optionId' | 'changes' | 'kept' | 'lens'> | undefined;
  readonly premises: readonly Assumption[];
  readonly busy: boolean;
  readonly onSubmit: (selection: ScenarioSelection) => void;
  readonly onCancel: () => void;
}) {
  const changes = useRows(initial?.changes ?? [], initial === undefined ? 1 : 0);
  const kept = useRows(initial?.kept ?? [], 0);
  const [lens, setLens] = useState(initial?.lens ?? '');
  const type = useTypeStyle('bodyS');
  const selection = ownSelection({
    kind,
    changes: changes.rows,
    kept: kept.rows,
    lens,
    fromOptionId: initial?.optionId,
  });
  return (
    <View style={sheetStyles.step}>
      {kind === 'what_if' ? (
        <>
          {premises.length === 0 ? null : (
            <View style={sheetStyles.summary} accessibilityLabel="Already assumed from earlier branches">
              <Text variant="uiS">Already assumed from earlier branches</Text>
              {premises.map((premise) => (
                <Text key={premise.subject} variant="bodyS">
                  · {premise.statement}
                </Text>
              ))}
              <Text variant="meta" color={content.ink2}>
                A line you add below is a new premise. To change one of these instead, choose Replaces on the line.
              </Text>
            </View>
          )}
          <RowsEditor title="What changes" {...changes} max={2} min={1} premises={premises} />
          <RowsEditor title="What stays the same" {...kept} max={3} min={0} />
        </>
      ) : (
        <View style={styles.rows}>
          <Text variant="uiS">The lens</Text>
          <TextInput
            accessibilityLabel="The lens"
            placeholder="For example, the view of the person on call"
            placeholderTextColor={content.ink2}
            value={lens}
            onChangeText={(next) => setLens(next.slice(0, 80))}
            maxLength={80}
            allowFontScaling={false}
            style={[sheetStyles.input, { fontFamily: type.fontFamily, fontSize: type.fontSize }]}
          />
        </View>
      )}
      <Button
        label="Explore"
        variant="primary"
        fullWidth
        disabled={selection === undefined}
        busy={busy}
        busyLabel="Starting"
        onPress={() => selection !== undefined && onSubmit(selection)}
      />
      <Button label="Back" variant="ghost" fullWidth onPress={onCancel} />
    </View>
  );
}

const styles = StyleSheet.create({
  rows: { gap: spacing[2] },
  rowBlock: { gap: spacing[2] },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  rowInput: { flex: 1 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
