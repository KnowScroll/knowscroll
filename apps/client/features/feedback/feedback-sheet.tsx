import { Text, BottomSheet } from '@knowscroll/ui';
import type { FeedbackTarget, ReportKind } from '@knowscroll/client-core';
import { useAccountScope } from '../../providers/account-scope';
import { FeedbackContent } from './feedback-content';

export interface FeedbackSheetBodyProps {
  readonly target: FeedbackTarget;
  readonly start: 'menu' | ReportKind;
  readonly onClose: () => void;
  /** Offered only where the screen can move on to the next subject. */
  readonly onNotInterested?: () => Promise<boolean>;
}

/**
 * P03 ready to sit inside a sheet. The container owns the sheet's header and its place on the screen.
 * A signed-out person has nothing to report to.
 */
export function FeedbackSheetBody(props: FeedbackSheetBodyProps) {
  const { state } = useAccountScope();
  if (state.status !== 'signed_in') return <Text variant="bodyS">Sign in to send a report.</Text>;
  return <FeedbackContent scope={state.scope} {...props} />;
}

/**
 * P03 as a bottom sheet, for the screens that report a message or a person (conversation, thread,
 * room, visit). Closing it drops what was typed.
 */
export function FeedbackSheet({
  target,
  onClose,
}: {
  /** What to report; the sheet is open while there is one. */
  readonly target: FeedbackTarget | undefined;
  readonly onClose: () => void;
}) {
  return (
    <BottomSheet visible={target !== undefined} title="Report" onClose={onClose} testID="feedback-sheet">
      {target === undefined ? null : <FeedbackSheetBody target={target} start="abuse" onClose={onClose} />}
    </BottomSheet>
  );
}
