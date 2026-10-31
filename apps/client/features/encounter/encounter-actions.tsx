import { ActionRail, ActionStrip, type EncounterAction } from '@knowscroll/ui';
import type { EncounterEntry } from './encounter-history';
import type { EncounterSession, EncounterState } from './encounter-session';

/** One action set for both formats (D-006 b): Like, Save, Share and Ask; ⋯ is in the top bar. */
const AVAILABLE: readonly EncounterAction[] = ['like', 'save', 'share', 'ask'];

function useActionProps(
  entry: EncounterEntry,
  state: EncounterState,
  session: EncounterSession,
  dense = false,
  beforeOverlay?: () => void,
) {
  return {
    dense,
    available: AVAILABLE,
    liked: entry.context.actions.liked,
    saved: entry.context.actions.saved,
    saving: state.actionPending,
    onAction: (action: EncounterAction) => {
      if (action === 'ask') {
        beforeOverlay?.();
        session.openRequest();
      } else if (action === 'share') {
        beforeOverlay?.();
        session.openShare();
      }
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
  surface,
}: {
  readonly entry: EncounterEntry;
  readonly state: EncounterState;
  readonly session: EncounterSession;
  readonly dense?: boolean;
  /** `paper` when the rail sits beside a Reel card instead of over the video. */
  readonly surface?: 'media' | 'paper';
}) {
  return <ActionRail {...useActionProps(entry, state, session, dense)} surface={surface} />;
}

/** The Scroll's action row: under the opening, and floating once the article is underway. */
export function EncounterStrip({
  entry,
  state,
  session,
  align,
  beforeOverlay,
}: {
  readonly entry: EncounterEntry;
  readonly state: EncounterState;
  readonly session: EncounterSession;
  readonly align?: 'start' | 'end';
  /** Called just before Share or Ask opens its sheet, so a sheet this strip sits in can step aside first. */
  readonly beforeOverlay?: () => void;
}) {
  return <ActionStrip {...useActionProps(entry, state, session, false, beforeOverlay)} align={align} />;
}
