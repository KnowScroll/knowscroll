import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { spacing } from '@knowscroll/design-tokens';
import { ReaderMoreList } from '@knowscroll/ui';
import { moreRowsOf, type MoreRowInput } from './more-rows';

/**
 * The body of a Scroll's ••• sheet: the seven rows, then what the screen adds under them. A row closes the sheet first, so
 * the sheet it opens, or the picture it changes, is what the person sees next.
 */
export function MoreSheetBody({
  input,
  onClose,
  children,
}: {
  readonly input: MoreRowInput;
  readonly onClose: () => void;
  readonly children?: ReactNode;
}) {
  const closing = (act: () => void) => () => {
    onClose();
    act();
  };
  const { act } = input;
  return (
    <View style={styles.more}>
      <ReaderMoreList
        rows={moreRowsOf({
          ...input,
          act: {
            shareMoment: closing(act.shareMoment),
            challenge: closing(act.challenge),
            toggleTextVersion: closing(act.toggleTextVersion),
            toggleSimpler: closing(act.toggleSimpler),
            smallPrint: closing(act.smallPrint),
            report: closing(act.report),
          },
        })}
      />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({ more: { gap: spacing[3], alignSelf: 'stretch' } });
