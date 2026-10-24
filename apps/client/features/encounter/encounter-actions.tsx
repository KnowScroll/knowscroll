import { ActionRail, ActionStrip, type EncounterAction } from '@knowscroll/ui';
import type { EncounterEntry } from './encounter-history';
import type { EncounterSession, EncounterState } from './encounter-session';

/** One action set for both formats (D-006 b): Like, Save, Share and Ask; ⋯ is in the top bar. */
const AVAILABLE: readonly EncounterAction[] = ['like', 'save', 'share', 'ask'];

function useActionProps(entry: EncounterEntry, state: EncounterState, session: EncounterSession, dense = false) {
  return {
    dense,
    available: AVAILABLE,
    liked: entry.context.actions.liked,
    saved: entry.context.actions.saved,
    saving: state.actionPending,
    onAction: (action: EncounterAction) => {
      if (action === 'ask') session.openRequest();
      else if (action === 'share') session.openShare();
      else if (action === 'save' || action === 'like') {
        if (state.actionPending || state.actionFailed) return;
        const on = action === 'save' ? entry.context.actions.saved : entry.context.actions.liked;
        session.act(on ? (action === 'save' ? 'unsave' : 'unlike') : action);
      }
    },
  };
}

/** The Reel's action column, over the video. */
export function EncounterRail({
  entry,
  state,
  session,
  dense,
}: {
  readonly entry: EncounterEntry;
  readonly state: EncounterState;
  readonly session: EncounterSession;
  readonly dense?: boolean;
}) {
  return <ActionRail {...useActionProps(entry, state, session, dense)} />;
}

/** The Scroll's action row: under the opening, and floating once the article is underway. */
export function EncounterStrip({
  entry,
  state,
  session,
  align,
}: {
  readonly entry: EncounterEntry;
  readonly state: EncounterState;
  readonly session: EncounterSession;
  readonly align?: 'start' | 'end';
}) {
  return <ActionStrip {...useActionProps(entry, state, session)} align={align} />;
}
