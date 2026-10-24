import { StyleSheet, View } from 'react-native';
import type { ScenarioOption } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing, status } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import { AssumptionChips } from './assumption-chips';
import { SPECULATIVE_NOTICE } from './branch-card';
import { sheetStyles } from './sheet-styles';

const SHARED_NOTE = 'Everyone in this thread will see the branch. Each of you opens it at your own pace.';

/** What we would explore, for one clear idea (X01 first phone): the summary, Edit, Explore. */
export function SummaryStep({
  option,
  busy,
  onExplore,
  onEdit,
}: {
  readonly option: ScenarioOption;
  readonly busy: boolean;
  readonly onExplore: () => void;
  readonly onEdit: () => void;
}) {
  return (
    <View style={sheetStyles.step}>
      <View style={sheetStyles.summary}>
        <View style={styles.summaryTop}>
          <Text variant="monoXs" color={content.ink2}>
            WE’LL EXPLORE
          </Text>
          <Button label="Edit" size="sm" variant="ghost" onPress={onEdit} />
        </View>
        <Text variant="ui">{option.title}</Text>
        <AssumptionChips option={option} />
      </View>
      <Button
        label="Explore"
        variant="primary"
        fullWidth
        busy={busy}
        busyLabel="Starting"
        icon="hypothetical"
        onPress={onExplore}
      />
      <Text variant="meta" color={content.ink2}>
        {SHARED_NOTE}
      </Text>
    </View>
  );
}

/** Several directions to pick from (Suggested branches): the member picks one, and that is the only thing that makes anything. */
export function OptionsStep({
  options,
  busy,
  onExplore,
  onEdit,
}: {
  readonly options: readonly ScenarioOption[];
  readonly busy: boolean;
  readonly onExplore: (option: ScenarioOption) => void;
  readonly onEdit: (option: ScenarioOption) => void;
}) {
  return (
    <View style={sheetStyles.step} role="list" accessibilityLabel="Suggested directions">
      <Text variant="meta" color={content.ink2}>
        Suggestions. Nothing is made until you choose one.
      </Text>
      {options.map((option) => (
        <View key={option.optionId} style={sheetStyles.summary} role="listitem">
          <Text variant="ui">{option.title}</Text>
          <Text variant="bodyS" color={content.ink2}>
            {option.explanation}
          </Text>
          <AssumptionChips option={option} />
          <View style={sheetStyles.actions}>
            <Button
              label="Explore this"
              variant="primary"
              size="sm"
              busy={busy}
              busyLabel="Starting"
              onPress={() => onExplore(option)}
            />
            <Button label="Edit" size="sm" variant="ghost" onPress={() => onEdit(option)} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** The confirm step for an unclear or speculative idea (X01 third phone): the premise, stated, before anything is made. */
export function ConfirmStep({
  option,
  busy,
  onCreate,
  onEdit,
  onCancel,
}: {
  readonly option: ScenarioOption;
  readonly busy: boolean;
  readonly onCreate: () => void;
  readonly onEdit: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <View style={sheetStyles.step}>
      <View style={styles.notice} role="note">
        <Text variant="uiS">{option.speculative ? SPECULATIVE_NOTICE : 'Is this what you mean?'}</Text>
        <Text variant="bodyS">
          {option.speculative
            ? 'A quick check first. The branch will say that this is an idea, not something that is known, and will compare it with what is established.'
            : 'A quick check first. This could be read more than one way. Check the premise below, or edit it, before anything is made.'}
        </Text>
      </View>
      <Text variant="ui">{option.title}</Text>
      <AssumptionChips option={option} />
      <Text variant="meta" color={content.ink2}>
        {SHARED_NOTE}
      </Text>
      <View style={sheetStyles.actions}>
        <Button label="Create branch" variant="primary" busy={busy} busyLabel="Creating" onPress={onCreate} />
        <Button label="Edit" variant="ghost" onPress={onEdit} />
        <Button label="Cancel" variant="ghost" onPress={onCancel} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  summaryTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  notice: {
    gap: spacing[1],
    padding: spacing[4],
    borderWidth: borderWidth.regular,
    borderRadius: radius.card,
    borderColor: status.hypothetical.edge,
    backgroundColor: status.hypothetical.background,
  },
});
