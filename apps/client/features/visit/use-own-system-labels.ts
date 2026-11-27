import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createUniverseSceneSession, type AccountScope, type UniverseSceneState } from '@knowscroll/client-core';
import { placesOf, type UniversePlace } from '../universe/universe-places';
import { sceneCapabilities } from '../universe/universe-session';
import { universeSessionFor } from '../universe/use-universe-session';

/** The names of your own systems, as search reads them: every system on your map. */
export const ownSystemLabels = (places: readonly UniversePlace[]): readonly string[] =>
  places.flatMap((place) => (place.kind === 'system' ? [place.label] : []));

/**
 * The names of your own systems in a read, or undefined while the read holds nothing to say: not started, still loading
 * its first answer, or failed. An empty universe is an answer: no names.
 */
export function labelsOfRead(read: UniverseSceneState): readonly string[] | undefined {
  if (read.status === 'empty') return [];
  return read.snapshot || read.sky ? ownSystemLabels(placesOf(read)) : undefined;
}

const IDLE: UniverseSceneState = { status: 'idle', active: false };
const ignore = () => () => {};

/**
 * Where a friend's screen gets the names of your own systems, for "What we have in common" (names are compared on this
 * device; nothing is sent). The cheapest source first: this account's own Universe session, which already holds the
 * sky if you have opened the Universe tab since the app started. Only if it was never started does this make one read
 * of its own, the same sky read the tab makes (`createUniverseSceneSession`, no formation, no Lately, no landmarks),
 * and lets go of it as soon as it answers or the screen leaves. Undefined while there is nothing to compare with, or
 * when `enabled` is false: then nothing is created and nothing is read, so the old look is exactly as it was.
 */
export function useOwnSystemLabels(scope: AccountScope, enabled: boolean): readonly string[] | undefined {
  const session = enabled ? universeSessionFor(scope) : undefined;
  const read = useSyncExternalStore(
    session?.subscribe ?? ignore,
    () => session?.getState().read ?? IDLE,
    () => IDLE,
  );
  const held = useMemo(() => labelsOfRead(read), [read]);
  const [fetched, setFetched] = useState<readonly string[]>();
  const needsRead = enabled && read.status === 'idle';
  useEffect(() => {
    if (!needsRead) return;
    const reader = createUniverseSceneSession({ scope, capabilities: sceneCapabilities('full', true) });
    const answered = () => {
      const read = reader.getState();
      const labels = labelsOfRead(read);
      if (labels !== undefined) setFetched(labels);
      // An answer, or a failure that will not mend itself: either way the one read is done.
      if (labels !== undefined || read.status === 'unavailable' || read.status === 'unsupported') reader.dispose();
    };
    const stop = reader.subscribe(answered);
    reader.start();
    return () => {
      stop();
      reader.dispose();
    };
  }, [needsRead, scope]);
  return enabled ? (held ?? fetched) : undefined;
}
