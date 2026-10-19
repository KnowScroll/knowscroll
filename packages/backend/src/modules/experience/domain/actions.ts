/** Explicit actions a person takes on a Reel or Scroll. More kinds (like, hide) join later. */
export type ActionKind = 'save' | 'unsave';

/** Whether an asset is in the person's saved items. */
export interface SavedState {
  readonly saved: boolean;
}

/** The saved state after an action, and whether it differs from before. */
export interface ActionEffect {
  readonly saved: boolean;
  readonly changed: boolean;
}

/**
 * The pure rule for save/unsave: the result depends only on the current state and the action.
 * Saving a saved item and unsaving an unsaved item are accepted no-ops (`changed: false`).
 */
export function decideActionEffect(current: SavedState, kind: ActionKind): ActionEffect {
  switch (kind) {
    case 'save':
      return { saved: true, changed: !current.saved };
    case 'unsave':
      return { saved: false, changed: current.saved };
  }
}
