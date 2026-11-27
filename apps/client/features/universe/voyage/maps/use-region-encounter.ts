import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';
import type { AvailableRegionPreview } from '@knowscroll/client-core';

/** Which of the card's two offers is opened: the encounter the server chose, or the same explanation in the other format. */
export type RegionChoice = 'encounter' | 'alternate';

/**
 * What the screen can do for the person with a region's preview: open it, say it could not, and go back to the
 * encounter that is in the way. This is the Open logic of the old region card (`RegionCard` in
 * `universe-cards.tsx`), copied because that card serves the switch-off look and the desktop panel and is not to be
 * touched here; once the old look is gone the card can call this too.
 */
export interface RegionEncounter {
  /** Opens one of the preview's two encounters. When another encounter is already open the session refuses: `blocked` is then true. */
  readonly open: (choice?: RegionChoice) => void;
  readonly blocked: boolean;
  /** Clears `blocked`, for "Try again" after an earlier encounter was dealt with. */
  readonly clearBlocked: () => void;
  /** Back to the encounter that was in the way. */
  readonly returnToEncounter: () => void;
}

/** The two places Open can take the person: the encounter, and back to the Universe when they leave it. */
export type EncounterRoute = '/explore' | '/universe';

export interface RegionEncounterOptions {
  /** On the web, the `data-testid` to focus when this screen goes without an encounter having been opened (Back or Escape), so a keyboard does not lose its place. Opening an encounter leaves the page and needs none. */
  readonly restoreFocusTo?: string | undefined;
  /** Goes to a route. The app's router by default; the developer gallery passes its own so a sample never leaves the page. */
  readonly navigate?: ((route: EncounterRoute) => void) | undefined;
}

/**
 * @param displayed the preview the screen shows, or undefined while there is none
 * @param onOpen the session's `openRegion(displayed, onReturn, choice)`: true when it started the encounter. `onReturn`
 *   is called when the person leaves the encounter by Back, and should land them on the Universe.
 */
export function useRegionEncounter(
  displayed: AvailableRegionPreview | undefined,
  onOpen: (displayed: AvailableRegionPreview, onReturn: () => void, choice: RegionChoice) => boolean,
  { restoreFocusTo, navigate }: RegionEncounterOptions = {},
): RegionEncounter {
  const router = useRouter();
  const go = (route: EncounterRoute): void => (navigate ? navigate(route) : router.navigate(route));
  const [blocked, setBlocked] = useState(false);
  const leaving = useRef(false);
  useEffect(
    () => () => {
      if (restoreFocusTo === undefined) return;
      queueMicrotask(() => {
        if (Platform.OS === 'web' && !leaving.current)
          document.querySelector<HTMLElement>(`[data-testid="${restoreFocusTo}"]`)?.focus();
      });
    },
    [restoreFocusTo],
  );
  return {
    open: (choice = 'encounter') => {
      if (!displayed) return;
      const accepted = onOpen(displayed, () => go('/universe'), choice);
      if (accepted) {
        leaving.current = true;
        go('/explore');
      } else setBlocked(true);
    },
    blocked,
    clearBlocked: () => setBlocked(false),
    returnToEncounter: () => go('/explore'),
  };
}
