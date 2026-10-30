import { useCallback, useEffect, useRef } from 'react';
import type { INTERACTION_KINDS_V2 } from '@knowscroll/scroll-model';
import { useArticleActivity } from '../reading/use-activity';
import { monotonicNow } from '../reading/visibility';

/** The interaction kinds of a call, by kind and never by value (D-063). */
export type StopInteractionKind = (typeof INTERACTION_KINDS_V2)[keyof typeof INTERACTION_KINDS_V2][number];

/**
 * What a v2 reader reports about reading: the recorder in `client-core` implements it, and its own
 * `ReadingObserver` is assignable to it. A stop is named by its id, a call's reveal by its kind.
 */
export interface StageReadingObserver {
  onBlockVisibility(event: { readonly blockId: string; readonly visibleFraction: number; readonly at: number }): void;
  onBlockInteraction(event: {
    readonly blockId: string;
    readonly kind: StopInteractionKind;
    readonly at: number;
  }): void;
  onActivity(event: { readonly active: boolean; readonly at: number }): void;
}

export interface StopReading {
  /** A call's answer was shown. */
  readonly revealed: (callId: string) => void;
}

/**
 * Reports reading of a v2 Scroll to the recorder (D-128, D-135). The stop on screen is the one
 * visible stop, wholly (fraction 1) until the reader moves to another; the stage, the spine and the
 * end tray are not stops. Leaving a stop, unmounting, or a replaced observer closes it. Activity (the
 * app in the foreground, no overlay open) is the article's own rule, so time with a sheet over the
 * reader never counts. Nothing is reported for a stop just passed on the way: tapping through the
 * dots gives each stop only the time it was actually on screen.
 */
export function useStopReading(
  observer: StageReadingObserver | undefined,
  activeStopId: string | undefined,
  paused: boolean,
): StopReading {
  useArticleActivity(observer, paused);
  useEffect(() => {
    if (observer === undefined || activeStopId === undefined) return undefined;
    observer.onBlockVisibility({ blockId: activeStopId, visibleFraction: 1, at: monotonicNow() });
    return () => observer.onBlockVisibility({ blockId: activeStopId, visibleFraction: 0, at: monotonicNow() });
  }, [observer, activeStopId]);
  const latest = useRef(observer);
  useEffect(() => {
    latest.current = observer;
  }, [observer]);
  const revealed = useCallback((callId: string) => {
    latest.current?.onBlockInteraction({ blockId: callId, kind: 'revealed', at: monotonicNow() });
  }, []);
  return { revealed };
}
