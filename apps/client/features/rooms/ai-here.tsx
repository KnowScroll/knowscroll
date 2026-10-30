import { Pressable, StyleSheet, View } from 'react-native';
import type { RoomPreferencesChange } from '@knowscroll/client-core';
import type { RoomAiLevel, RoomYou } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { SwitchRow, Text } from '@knowscroll/ui';
import { AI_NOTICE } from './ai-notice';

const LEVELS: readonly { readonly level: RoomAiLevel; readonly label: string; readonly hint: string }[] = [
  {
    level: 'lively',
    label: 'Lively',
    hint: 'AI answers when someone asks, and joins in when a question goes unanswered or something is said very strongly.',
  },
  {
    level: 'quieter',
    label: 'Quieter',
    hint: 'What AI adds on its own is folded into one line, and you open it if you want it. Answers you ask for show in full.',
  },
  {
    level: 'off',
    label: 'Off',
    hint: 'You see nothing AI adds on its own. Answers you ask for still show.',
  },
];

/**
 * "AI here" (R3 C5): how much the room's AI inhabitants may speak to this member, whether this member's
 * messages are kept out of what AI reads, and the notice they were given on joining. Both settings are the
 * member's own and are saved as soon as they are changed. The level decides what this member sees of a resident that
 * speaks on its own (v3 R-2): Lively shows it, Quieter folds it, Off hides it. An answer the member asked for always shows.
 */
export function AiHere({
  you,
  working,
  onChange,
}: {
  readonly you: RoomYou;
  readonly working: boolean;
  readonly onChange: (change: RoomPreferencesChange) => void;
}) {
  const active = LEVELS.find((entry) => entry.level === you.aiLevel)!;
  return (
    <View style={styles.panel} testID="ai-here">
      <View role="radiogroup" accessibilityLabel="AI level" style={styles.levels}>
        {LEVELS.map((entry) => {
          const selected = entry.level === you.aiLevel;
          return (
            <Pressable
              key={entry.level}
              role="radio"
              aria-checked={selected}
              accessibilityState={{ checked: selected, disabled: working }}
              disabled={working}
              onPress={() => {
                if (!selected) onChange({ aiLevel: entry.level });
              }}
              style={[styles.level, selected ? styles.levelOn : null]}
              testID={`ai-level-${entry.level}`}
            >
              <Text variant="ui" color={selected ? content.onAccent : content.ink}>
                {entry.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text variant="meta" color={content.ink2}>
        {active.hint}
      </Text>
      <SwitchRow
        label="Keep my messages out of what AI reads"
        description="They’re replaced by a placeholder before any AI sees the room."
        on={you.keepOut}
        disabled={working}
        onChange={(keepOut) => onChange({ keepOut })}
      />
      <Text variant="meta" color={content.ink2}>
        {AI_NOTICE.body}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: spacing[3] },
  levels: {
    flexDirection: 'row',
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  level: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: content.paper },
  levelOn: { backgroundColor: content.accent },
});
