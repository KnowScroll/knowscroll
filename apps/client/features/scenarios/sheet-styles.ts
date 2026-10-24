import { StyleSheet } from 'react-native';
import { borderWidth, content, radius, spacing, status } from '@knowscroll/design-tokens';

/** What the steps of the What if sheet share: their stack, a boxed summary, a dashed input and a row of actions. */
export const sheetStyles = StyleSheet.create({
  step: { gap: spacing[3] },
  input: {
    minHeight: 48,
    maxHeight: 160,
    borderWidth: borderWidth.regular,
    borderRadius: radius.card,
    borderColor: status.hypothetical.edge,
    borderStyle: 'dashed',
    backgroundColor: status.hypothetical.background,
    color: content.ink,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  summary: {
    gap: spacing[2],
    padding: spacing[4],
    borderWidth: borderWidth.regular,
    borderRadius: radius.card,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2], alignItems: 'center' },
});
