import { useState } from 'react';
import type { AccountScope } from '@knowscroll/client-core';
import type { ContentThreadRef, ScenarioCard, ScenarioKind } from '@knowscroll/contracts';
import { BottomSheet } from '@knowscroll/ui';
import { MessageStep } from './message-step';
import type { ScenarioStart } from './scenario-start';
import { SheetBody } from './sheet-body';

export type { ScenarioStart } from './scenario-start';

/**
 * X01: What if… and Another perspective, from the conversation. An overlay, not a route: closing it
 * returns to the same place in the thread, and the member's words survive leaving it. The model only
 * proposes directions; the member's choice is the only thing that makes a branch. A request that
 * started from a message's menu first asks which kind, in this same sheet.
 */
export function ScenarioSheet({
  start,
  scope,
  thread,
  onClose,
  onChosen,
}: {
  /** `undefined` while the sheet is closed; each opening starts a fresh composer. */
  readonly start: ScenarioStart | undefined;
  readonly scope: AccountScope;
  readonly thread: ContentThreadRef;
  readonly onClose: () => void;
  readonly onChosen: (card: ScenarioCard) => void;
}) {
  const [picked, setPicked] = useState<ScenarioKind>();
  const close = () => {
    setPicked(undefined);
    onClose();
  };
  const kind = start === undefined ? undefined : 'offer' in start ? start.offer.kind : (start.kind ?? picked);
  const choosingKind = start !== undefined && kind === undefined;
  return (
    <BottomSheet
      visible={start !== undefined}
      title={choosingKind ? 'From this message' : 'What if…'}
      onClose={close}
      testID="scenario-sheet"
    >
      {start === undefined ? null : kind === undefined ? (
        <MessageStep
          quote={'quote' in start && start.quote !== undefined ? start.quote : { authorName: '', preview: '' }}
          onPick={setPicked}
          onCancel={close}
        />
      ) : (
        <SheetBody
          key={'offer' in start ? start.offer.draftId : `${kind}:${JSON.stringify(start.origin)}:${start.words ?? ''}`}
          start={'offer' in start ? start : { ...start, kind }}
          scope={scope}
          thread={thread}
          onClose={close}
          onChosen={onChosen}
        />
      )}
    </BottomSheet>
  );
}
